import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri loads the dev server at a fixed port and the built files from dist.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: { port: 1440, strictPort: true },
  build: { target: "es2022", outDir: "dist" },
});
