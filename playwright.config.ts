import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3001",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: "npm run start --prefix backend",
      url: "http://127.0.0.1:5000/health",
      timeout: 120_000,
      reuseExistingServer: true,
    },
    {
      command: "npm run dev --prefix frontend",
      url: "http://127.0.0.1:3001",
      timeout: 120_000,
      reuseExistingServer: true,
    },
  ],
});
