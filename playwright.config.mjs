import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45_000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:1420',
    viewport: { width: 1120, height: 760 },
    trace: 'retain-on-failure',
    launchOptions: {
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--enable-usermedia-screen-capturing',
        '--auto-select-desktop-capture-source=Entire screen',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
  webServer: [
    {
      command: 'node tests/serve.mjs',
      url: 'http://127.0.0.1:8878/api/config',
      reuseExistingServer: false,
    },
    {
      command: 'npm run dev',
      url: 'http://127.0.0.1:1420/tests/e2e/harness.html',
      reuseExistingServer: false,
      env: { VITE_TINY_SERVER_URL: 'http://127.0.0.1:8878' },
    },
  ],
});
