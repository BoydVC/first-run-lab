import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 40_000,
    hookTimeout: 40_000,
    sequence: { concurrent: false },
  },
});
