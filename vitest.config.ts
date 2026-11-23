import { defineConfig } from 'vitest/config';

// One Vitest run covers every workspace. Each package keeps its tests next to its code.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/web'],
  },
});
