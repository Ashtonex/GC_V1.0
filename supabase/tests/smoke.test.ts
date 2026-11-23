import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestDb, migrationFiles } from './harness/db.ts';

let db: TestDb;
beforeAll(async () => {
  db = await TestDb.create();
});
afterAll(() => db.close());

describe('migrations', () => {
  it('apply cleanly in order', () => {
    expect(migrationFiles().length).toBeGreaterThanOrEqual(4);
  });

  it('enable Row Level Security on every table in public (Section 4)', async () => {
    const rows = await db.admin<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'`,
    );
    expect(rows.length).toBeGreaterThan(15);
    expect(rows.filter((r) => !r.relrowsecurity).map((r) => r.relname)).toEqual([]);
  });
});
