import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      NODE_ENV: "test",
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://rootline@127.0.0.1:55434/rootline_test",
      SIMULATOR: "off",
      AGENT_MODE: "heuristic",
      GITHUB_WEBHOOK_SECRET: "whsec_test",
      INGEST_TOKEN: "rl_test_ingest",
      LOGIN_RATE_LIMIT: "1000",
    },
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
