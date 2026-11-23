import { defineProject } from 'vitest/config';

// Database tests (RLS, permissions, ingestion) against in-process Postgres (PGlite). No Docker needed.
export default defineProject({
  test: {
    name: 'supabase',
    include: ['tests/**/*.test.ts', 'functions/**/*.test.ts'],
    // Each file starts its own in-process Postgres (a large WebAssembly heap). Run the files one at a time so
    // several databases never compete for memory (parallel runs crashed the worker processes).
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
