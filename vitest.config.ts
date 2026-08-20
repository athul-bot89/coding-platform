import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  // tsconfig sets `jsx: preserve` for Next to handle, which leaves nothing to
  // transform JSX in a .tsx test. The plugin is what makes component tests
  // runnable at all; without it they fail to parse rather than fail to pass.
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
});
