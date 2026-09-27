import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? "/",
  build: { emptyOutDir: true },
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt",
      includeAssets: ["icons/icon.svg"],
      manifest: {
        name: "额度重置策略工作台",
        short_name: "额度排程",
        description: "本地优先的额度重置与高价值任务排程工具",
        theme_color: "#173332",
        background_color: "#f5f1e8",
        display: "standalone",
        start_url: ".",
        icons: [{ src: "icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }]
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,wasm,json}"],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024
      }
    })
  ],
  worker: { format: "es" },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    pool: "forks",
    maxWorkers: 1
  }
});
