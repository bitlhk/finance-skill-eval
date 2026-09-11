import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: {
    outDir: "../web-dist",
    emptyOutDir: true,
    rollupOptions: { output: { manualChunks: { charts: ["recharts"], markdown: ["react-markdown", "remark-gfm", "remend"] } } },
  },
  server: {
    port: 5174,
    proxy: {
      "/api": "http://localhost:56361",
    },
  },
});
