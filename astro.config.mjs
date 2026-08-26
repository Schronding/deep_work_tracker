// astro.config.mjs
import { defineConfig } from "astro/config";
import node from "@astrojs/node";
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  vite: { ssr: { external: ["@libsql/client"] } }, // keep the native binding out of the bundle
});