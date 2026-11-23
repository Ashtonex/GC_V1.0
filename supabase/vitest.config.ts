import { defineProject } from 'vitest/config';

// Database tests (RLS, permissions, ingestion) against in-process Postgres (PGlite). No Docker needed.
export default defineProject({
  test: {
    name: 'supabase',
    include: ['tests/**/*.test.ts', 'functions/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
