import { defineConfig } from "vitest/config";
import { join } from "path";

export default defineConfig({
  resolve: {
    alias: {
      "openclaw/plugin-sdk/plugin-entry": join(__dirname, "test/__mocks__/plugin-entry.ts"),
      "openclaw/plugin-sdk/setup-tools": join(__dirname, "test/__mocks__/setup-tools.ts"),
    },
  },
  test: {
    testTimeout: 15_000,
    sequence: { concurrent: false },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
    },
  },
});
