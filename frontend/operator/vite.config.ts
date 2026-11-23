import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/operator/",
  server: {
    port: 5174,
    proxy: {
      "/auth": "http://localhost:8000",
      "/operator/api": "http://localhost:8000",
    },
  },
  test: { environment: "jsdom" },
});
