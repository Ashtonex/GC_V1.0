import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const isCI = !!process.env.CI;

// Runs against the production build (service worker only exists there).
// Locally it uses the installed Google Chrome; CI installs Playwright's Chromium.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: isCI ? 1 : 0,
  reporter: isCI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    ...devices['Pixel 7'],
    ...(isCI ? {} : { channel: 'chrome' }),
  },
  webServer: {
    command: 'npm run build && npm run preview',
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !isCI,
    timeout: 120_000,
  },
});
