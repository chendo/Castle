import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss()],
  server: { port: 5173 },
  // Relative asset URLs (`./assets/...` in index.html) so the bundle works
  // both at the document root (dev / standalone) and under an arbitrary path
  // prefix (HA Supervisor ingress: `/api/hassio_ingress/<token>/...`). With
  // an absolute base, ingress-served assets would request `/assets/...` at
  // the HA host and 404.
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
});
