import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port and ignores its own Rust folder.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**", "**/core/**", "**/target/**"] },
  },
  build: { target: "es2021", outDir: "dist", emptyOutDir: true },
});
