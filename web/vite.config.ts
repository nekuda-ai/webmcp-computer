import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { sites } from "@openai/sites-vite-plugin";
import { access, copyFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const distRoot = resolve(projectRoot, "dist");

const sitesArtifactLayout = {
  name: "verbos-sites-artifact-layout",
  apply: "build" as const,
  async buildStart() {
    await rm(distRoot, { recursive: true, force: true });
  },
  async closeBundle() {
    await access(resolve(distRoot, "client/index.html"));
    await mkdir(resolve(distRoot, "server"), { recursive: true });
    await copyFile(
      resolve(projectRoot, "server/index.js"),
      resolve(distRoot, "server/index.js"),
    );
  },
};

export default defineConfig({
  plugins: [sitesArtifactLayout, sites(), react()],
  optimizeDeps: {
    exclude: ["@opentelemetry/api-logs"],
  },
  build: {
    outDir: "dist/client",
    rollupOptions: {
      external: ["@opentelemetry/api-logs"],
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/react/") ||
            id.includes("/node_modules/react-dom/") ||
            id.includes("/node_modules/scheduler/")) {
            return "vendor-react";
          }
          if (id.includes("/node_modules/@zenfs/")) return "vendor-zenfs";
          if (id.includes("/node_modules/react-rnd/") ||
            id.includes("/node_modules/react-draggable/") ||
            id.includes("/node_modules/re-resizable/")) {
            return "vendor-ui";
          }
          return undefined;
        },
      },
    },
  },
  resolve: {
    alias: {
      "node:zlib": resolve(projectRoot, "src/kernel/shell/zlibShim.ts"),
    },
    // Resolve the vendored file dependency through web/node_modules so its peers
    // use this app's dependency graph during dev and production builds.
    preserveSymlinks: true,
  },
});
