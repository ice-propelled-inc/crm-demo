import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/admin/",
  server: {
    port: 5173,
    proxy: {
      "/auth": "http://localhost:8000",
      "/admin/api": "http://localhost:8000",
    },
  },
  test: { environment: "jsdom" },
});
