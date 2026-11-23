/**
 * Test database: PGlite (real Postgres compiled to WebAssembly, in-process) + the Supabase stub + every
 * migration in supabase/migrations, in order. Lets RLS, permissions and ingestion be tested without Docker.
 *
 * `as(user)` runs SQL exactly as a signed-in Supabase API request would: role `authenticated`, JWT claims in
 * `request.jwt.claims`, request headers (device id) in `request.headers`. RLS applies.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite, type Transaction } from '@electric-sql/pglite';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'migrations');

export function migrationFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

export interface Session {
  /** auth.uid() */
  userId: string;
  /** Owner powers require a two-factor (aal2) session (Section 4). Default aal2. */
  aal?: 'aal1' | 'aal2';
  /** Sent as the x-gc-device-id header (D-027: a driver phone gets driver powers only). */
  deviceId?: string;
}

export type Row = Record<string, unknown>;

export class TestDb {
  private constructor(readonly pg: PGlite) {}

  static async create(): Promise<TestDb> {
    const pg = new PGlite();
    await pg.exec(readFileSync(join(here, 'supabase-stub.sql'), 'utf8'));
    for (const f of migrationFiles()) {
      try {
        await pg.exec(readFileSync(join(migrationsDir, f), 'utf8'));
      } catch (err) {
        throw new Error(`migration ${f} failed: ${(err as Error).message}`, { cause: err });
      }
    }
    return new TestDb(pg);
  }

  /** As the database owner (setup only; bypasses RLS). */
  async admin<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.pg.query<T>(sql, params)).rows;
  }

  /** As a signed-in user through the API: RLS and grants apply. */
  async as<T extends Row = Row>(s: Session, sql: string, params: unknown[] = []): Promise<T[]> {
    return this.pg.transaction(async (tx) => {
      await enter(tx, 'authenticated', s);
      return (await tx.query<T>(sql, params)).rows;
    });
  }

  /** As the service role (Edge Functions with the service key). Bypasses RLS like on Supabase. */
  async service<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.pg.transaction(async (tx) => {
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'service_role' })]);
      await tx.exec('set local role service_role');
      return (await tx.query<T>(sql, params)).rows;
    });
  }

  /** As an anonymous (signed-out) API caller. */
  async anon<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.pg.transaction(async (tx) => {
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'anon' })]);
      await tx.exec('set local role anon');
      return (await tx.query<T>(sql, params)).rows;
    });
  }

  close(): Promise<void> {
    return this.pg.close();
  }
}

async function enter(tx: Transaction, role: string, s: Session): Promise<void> {
  const claims = { sub: s.userId, role, aal: s.aal ?? 'aal2' };
  const headers = s.deviceId ? { 'x-gc-device-id': s.deviceId } : {};
  await tx.query(`select set_config('request.jwt.claims', $1, true), set_config('request.headers', $2, true)`, [
    JSON.stringify(claims),
    JSON.stringify(headers),
  ]);
  await tx.exec(`set local role ${role}`);
}
