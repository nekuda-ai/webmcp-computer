import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { sites } from "@openai/sites-vite-plugin";
import { access, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build as buildServer } from "esbuild";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const distRoot = resolve(projectRoot, "dist");
const LOCAL_GATEWAY_SECRET =
  "webmcp-computer-local-development-gateway-secret-do-not-use-in-production";

const sitesArtifactLayout = {
  name: "webmcp-computer-sites-artifact-layout",
  apply: "build" as const,
  async buildStart() {
    await rm(distRoot, { recursive: true, force: true });
  },
  async closeBundle() {
    await access(resolve(distRoot, "client/index.html"));
    await mkdir(resolve(distRoot, "server"), { recursive: true });
    await buildServer({
      entryPoints: [resolve(projectRoot, "server/index.js")],
      outfile: resolve(distRoot, "server/index.js"),
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
    });
  },
};

function sitesLocalApi() {
  const workspaceId = "6c6f63616c5f73656564795f76657262";
  const userStore = { async getOrCreate() { return workspaceId; } };
  return {
    name: "webmcp-computer-sites-local-api",
    configureServer(server: { middlewares: { use(handler: (...args: any[]) => void): void }; ssrLoadModule(path: string): Promise<any> }) {
      server.middlewares.use(async (request, response, next) => {
        let url: URL;
        try {
          url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
        } catch {
          next();
          return;
        }
        if (url.pathname !== "/api/session") {
          next();
          return;
        }
        try {
          const headers = new Headers();
          for (const [name, value] of Object.entries(request.headers)) {
            if (typeof value === "string") headers.set(name, value);
            else if (Array.isArray(value)) headers.set(name, value.join(", "));
          }
          const module = await server.ssrLoadModule("/server/index.js") as {
            handleRequest(request: Request, env: Record<string, unknown>, dependencies: Record<string, unknown>): Promise<Response>;
          };
          const result = await module.handleRequest(
            new Request(url, { method: request.method, headers }),
            {
              ASSETS: { fetch: () => new Response("not found", { status: 404 }) },
              GATEWAY_SIGNING_SECRET: process.env.WEBMCP_COMPUTER_DEV_GATEWAY_SIGNING_SECRET ?? LOCAL_GATEWAY_SECRET,
              BROWSER_WORKER_URL: process.env.VITE_BROWSER_WORKER_URL ?? "http://127.0.0.1:8787",
              COMPUTER_WORKER_URL: process.env.VITE_COMPUTER_WORKER_URL ?? "http://127.0.0.1:8788",
            },
            { userStore },
          );
          response.statusCode = result.status;
          result.headers.forEach((value, name) => response.setHeader(name, value));
          response.end(new Uint8Array(await result.arrayBuffer()));
        } catch (error) {
          next(error);
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [sitesArtifactLayout, sites(), sitesLocalApi(), react()],
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
