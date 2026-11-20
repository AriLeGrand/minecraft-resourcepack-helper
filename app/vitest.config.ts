import { defineConfig } from "vitest/config";

// Unit tests cover the pure helpers only (no DOM needed).
export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
