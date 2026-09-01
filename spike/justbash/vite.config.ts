import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "node:zlib": fileURLToPath(new URL("./zlib-shim.ts", import.meta.url)),
    },
  },
});
