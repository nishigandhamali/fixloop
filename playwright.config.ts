import { defineConfig, devices } from "@playwright/test";

const DB = "postgresql://fixloop:fixloop@localhost:54329/fixloop_e2e";
const API_ENV = { DATABASE_URL: DB, SESSION_SECRET: "e2e-secret-0123456789abcdef0123456789", DEMO_MODE: "true", PORT: "4100", ALLOWED_ORIGINS: "http://localhost:3100", STORAGE_DIR: "./.e2e-storage" };

export default defineConfig({
  testDir: "./e2e",
  testMatch: process.env.SHOTS ? /screenshots\.shots\.ts/ : /.*\.spec\.ts/,
  workers: 1, // tests share one demo household; they reset it themselves
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:3100", trace: "retain-on-failure", ...devices["Desktop Chrome"] },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"] } }, { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: /mobile\.spec\.ts/ }],
  webServer: [
    { command: "pnpm exec tsx e2e/prepare.mts && pnpm --filter @fixloop/api exec tsx src/server.ts", url: "http://127.0.0.1:4100/health/ready", env: API_ENV, reuseExistingServer: false, timeout: 60_000 },
    { command: "pnpm --filter @fixloop/web exec next start -p 3100", url: "http://localhost:3100/api/health", env: { FIXLOOP_API_URL: "http://127.0.0.1:4100" }, reuseExistingServer: false, timeout: 60_000 },
  ],
});
