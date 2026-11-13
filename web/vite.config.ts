import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, the API paths are proxied to the service (npm run console).
const target = "http://127.0.0.1:3979";
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/score": target, "/findings": target, "/exceptions": target, "/audit": target } },
});
