import { reuseCityEnv } from "./scripts/city-files.ts";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/browser",
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.BROWSER_GAME_URL || "http://127.0.0.1:4175",
    viewport: { width: 640, height: 450 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: process.env.BROWSER_DOCKER_IMAGE
      ? `docker run --rm --name ${process.env.BROWSER_GAME_CONTAINER || "afterhours-browser-game"} -p 4175:5173 -e ALLOW_DEBUG=1 ${process.env.BROWSER_DOCKER_IMAGE}`
      : "node --import tsx server/index.ts --production",
    env: { PORT: "4175", ALLOW_DEBUG: "1", ...reuseCityEnv() },
    url: "http://127.0.0.1:4175/health",
    // Docker regenerates and bakes its city; match production's startup allowance.
    timeout: process.env.BROWSER_DOCKER_IMAGE ? 600_000 : 60_000,
    reuseExistingServer: false,
  },
});
