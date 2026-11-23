import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// The backend. In docker compose the SPA runs in its own container: API_TARGET=http://app:8000.
const api = process.env.API_TARGET ?? "http://localhost:8000";

export default defineConfig({
  plugins: [react()],
  base: "/operator/",
  server: {
    // Docker on Windows does not pass file events into the container: poll instead.
    watch: process.env.VITE_POLL ? { usePolling: true, interval: 500 } : undefined,
    port: 5174,
    proxy: {
      "/auth": api,
      "/operator/ws": { target: api.replace(/^http/, "ws"), ws: true },
      "/operator/api": api,
    },
  },
  test: { environment: "jsdom" },
});
