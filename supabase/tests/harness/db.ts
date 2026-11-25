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
import { PGlite } from '@electric-sql/pglite';

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

/** Minimal driver both backends satisfy. */
export interface Tx {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
}
interface Driver extends Tx {
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * GC_TEST_DATABASE_URL set → run against a REAL Supabase Postgres (local `supabase start`, port 54322) instead
 * of PGlite. Each TestDb wipes the `public` and `gc` schemas and the auth users, then re-applies every
 * migration, so it is LOCAL ONLY: the harness refuses any host other than localhost / 127.0.0.1.
 */
const realUrl = process.env.GC_TEST_DATABASE_URL;

export class TestDb {
  private constructor(readonly pg: Driver) {}

  static async create(): Promise<TestDb> {
    if (realUrl) return new TestDb(await realDriver(realUrl));
    const pg = new PGlite();
    await pg.exec(readFileSync(join(here, 'supabase-stub.sql'), 'utf8'));
    for (const f of migrationFiles()) {
      try {
        await pg.exec(readFileSync(join(migrationsDir, f), 'utf8'));
      } catch (err) {
        throw new Error(`migration ${f} failed: ${(err as Error).message}`, { cause: err });
      }
    }
    return new TestDb(pg as unknown as Driver);
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

async function realDriver(url: string): Promise<Driver> {
  const host = new URL(url).hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') {
    throw new Error(`GC_TEST_DATABASE_URL must point at a local database (got host ${host}); the harness wipes it`);
  }
  const { default: pgmod } = await import('pg');
  // Match PGlite's parsing so the same assertions hold: int8 → number.
  pgmod.types.setTypeParser(20, (v: string) => Number(v));
  const client = new pgmod.Client({ connectionString: url });
  await client.connect();
  const tx: Tx = {
    query: async (sql, params = []) => ({ rows: (await client.query(sql, params as unknown[])).rows }),
    exec: (sql) => client.query(sql),
  };
  await client.query(`
    drop schema if exists gc cascade;
    drop schema if exists public cascade;
    create schema public;
    grant usage on schema public to anon, authenticated, service_role;
    grant all on schema public to postgres;
    alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated, service_role;
    delete from auth.users;`);
  for (const f of migrationFiles()) {
    try {
      await client.query(readFileSync(join(migrationsDir, f), 'utf8'));
    } catch (err) {
      throw new Error(`migration ${f} failed: ${(err as Error).message}`, { cause: err });
    }
  }
  return {
    ...tx,
    async transaction(fn) {
      await client.query('begin');
      try {
        const out = await fn(tx);
        await client.query('commit');
        return out;
      } catch (err) {
        await client.query('rollback');
        throw err;
      }
    },
    close: () => client.end(),
  };
}

async function enter(tx: Tx, role: string, s: Session): Promise<void> {
  const claims = { sub: s.userId, role, aal: s.aal ?? 'aal2' };
  const headers = s.deviceId ? { 'x-gc-device-id': s.deviceId } : {};
  await tx.query(`select set_config('request.jwt.claims', $1, true), set_config('request.headers', $2, true)`, [
    JSON.stringify(claims),
    JSON.stringify(headers),
  ]);
  await tx.exec(`set local role ${role}`);
}
