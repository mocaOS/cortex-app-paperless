import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // CORTEX_DEV_* deliberately have no VITE_ prefix: they are dev-proxy-only
  // and must never be inlined into the client bundle.
  const env = loadEnv(mode, process.cwd(), "");

  return {
    plugins: [react(), tailwindcss()],

    // Hosted apps are served under /apps/{slug}/ — all asset URLs must be
    // relative. Do not change this to an absolute base.
    base: "./",

    server: {
      proxy: {
        // Dev stand-in for the cortex-app app proxy: forwards ./api/cortex/*
        // to a real instance's /api/*, attaching your dev key server-side.
        // In production the hosting proxy does this with the app's minted key.
        "/api/cortex": {
          target: env.CORTEX_DEV_URL || "http://localhost:8000",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/cortex/, "/api"),
          headers: env.CORTEX_DEV_KEY ? { "X-API-Key": env.CORTEX_DEV_KEY } : {},
        },
        // Platform capabilities (type: "platform" apps) have no dev stand-in
        // yet — develop against an instance with app hosting enabled, or
        // guard platform calls behind feature detection.
      },
    },
  };
});
