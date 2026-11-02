import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [vue()],
  // Android's OS version does not determine its independently updated WebView.
  // Keep emitted syntax usable by older installations; runtime APIs are guarded.
  build: { target: "chrome87" },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  optimizeDeps: {
    entries: ["index.html"],
  },
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/.work/**", "**/src-tauri/**", "**/release/**", "**/Data/**", "**/Incoming/**", "**/Library/**", "**/Backups/**"],
    },
  },
});
