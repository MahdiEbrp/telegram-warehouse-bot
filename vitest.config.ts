import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["src/tests/**/*.test.ts"],
    // TestBot intercepts fetch globally: never share one worker concurrently.
    fileParallelism: false,
    testTimeout: 15000,
    coverage: {
      provider: "v8",
      thresholds: { statements: 92, branches: 84, functions: 96, lines: 93 },
      reporter: ["text", "html", "json-summary"],
      include: ["src/lib/**/*.ts", "src/db/queries/**/*.ts", "src/bot/**/*.ts"],
      exclude: ["src/lib/env.ts", "src/bot/bot.ts"],
    },
  },
});
