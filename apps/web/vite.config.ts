/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import pkg from './package.json' with { type: 'json' };

const buildStamp = new Date().toISOString().slice(0, 16).replace('T', ' ');

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(`${pkg.version} (${buildStamp} UTC)`),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // "prompt" (not autoUpdate): Section 4 says updates apply only when no events are pending sync and
      // no sale is in progress. The shell shows "Update available" and the gate is added in M3.
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['icons/apple-touch-icon-180.png'],
      manifest: {
        id: '/',
        name: 'Game Command',
        short_name: 'GC',
        description: 'Game Command — trip, stock and cash control for the truck',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#0f172a',
        theme_color: '#0f172a',
        // No manifest-level orientation lock: one manifest serves both driver (phone) and office
        // (desktop/tablet) shells. See DECISIONS.md D-033.
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache the whole app shell so it opens in airplane mode (Section 4C #7).
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest}'],
        navigateFallback: '/index.html',
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  test: {
    name: 'web',
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
