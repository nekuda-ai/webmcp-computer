import {
  getWorkspace,
  Workspace,
  type DurableObjectStorageLike,
  type WorkspaceClient,
  type WorkspaceFilesystemStub,
  type WorkspaceOptions,
  type WorkspaceStub,
} from "@cloudflare/computer";
import {
  CloudflareContainerBackend,
  withWorkspaceContainer,
} from "@cloudflare/computer/backends/container";
import { DurableObject } from "cloudflare:workers";
import { createCloudflareObserver } from "@cloudflare/computer/observe/cloudflare";
import {
  bearerGatewayCapability,
  verifyGatewayCapability,
  type GatewayCapabilityClaims,
} from "../../../shared/gateway-capability";
import {
  handleRequest,
  type HandlerEnv,
  type WorkerDependencies,
  type WorkspaceExecHandle,
  type WorkspaceFileSystem,
  type WorkspaceHandle,
} from "./handler";
import { randomSlug } from "./slug";
import { DurableSyncRetryScheduler } from "./syncRetry";

export { WorkspaceProxy } from "@cloudflare/computer";

export type Env = HandlerEnv & {
  WORKSPACES: DurableObjectNamespace<WebMCPComputerWorkspace>;
};

class ContainerBase extends withWorkspaceContainer(class extends DurableObject<Env> {}) {
  readonly backend = new CloudflareContainerBackend({
    id: "container",
    container: () => this,
    workspace: { binding: "WORKSPACES", id: this.ctx.id.toString() },
    egress: { mode: "direct" },
  });
}

function workspaceOptions(self: InstanceType<typeof ContainerBase>): WorkspaceOptions {
  // @cloudflare/computer 0.2.1 and current workers-types carry structurally
  // equivalent SQL generics that TypeScript cannot unify across package copies.
  const { ctx } = self as unknown as { ctx: DurableObjectState };
  type CloudflareTracing = Parameters<typeof createCloudflareObserver>[0]["tracing"];
  const tracing = (ctx as unknown as { tracing?: CloudflareTracing }).tracing;
  return {
    storage: ctx.storage as unknown as DurableObjectStorageLike,
    backends: [self.backend],
    observer: createCloudflareObserver({ tracing }),
    retryScheduler: new DurableSyncRetryScheduler(ctx.storage),
    retry: {
      initialDelayMs: 2_000,
      maxDelayMs: 60_000,
      maxAttempts: 12,
    },
  };
}

export class WebMCPComputerWorkspace extends ContainerBase {
  readonly workspace = new Workspace(workspaceOptions(this));

  async __getWorkspaceStub(): Promise<WorkspaceStub> {
    await this.workspace.ready();
    return this.workspace.stub();
  }

  override async fetch(request: Request): Promise<Response> {
    return await this.backend.handleFetch(request);
  }

  override async alarm(alarmInfo?: { retryCount: number; isRetry: boolean }): Promise<void> {
    try {
      const result = await this.workspace.retryPendingSync(this.backend.id);
      console.log("WebMCP Computer workspace sync retry", JSON.stringify(result));
    } catch (error) {
      if ((alarmInfo?.retryCount ?? 0) >= 5) {
        await this.ctx.storage.setAlarm(Date.now() + 30_000);
        console.error("WebMCP Computer workspace sync retry rescheduled", error);
        return;
      }
      throw error;
    }
  }
}

// `client.fs` is an RPC stub: its properties are RpcProperty proxies, not plain
// functions. Detaching one (Reflect.get + bind) breaks workerd's dispatch and fails
// every call with "Could not serialize object of type RpcProperty", so each method
// below must call through the stub at invocation time.
// getWorkspace() types `fs` as WorkspaceFilesystem, but the object it actually hands
// back is a WorkspaceFilesystemStub, which also carries exists() and statOrNull()
// (both exercised against workerd). Narrow to the type the runtime provides.
function workspaceFs(client: WorkspaceClient): WorkspaceFilesystemStub {
  return client.fs as unknown as WorkspaceFilesystemStub;
}

function handlerWorkspace(client: WorkspaceClient): WorkspaceHandle {
  const fs: WorkspaceFileSystem = {
    readFile: (path) => workspaceFs(client).readFile(path),
    writeFile: (path, content) => workspaceFs(client).writeFile(path, content),
    exists: (path) => workspaceFs(client).exists(path),
    stat: (path) => workspaceFs(client).stat(path),
    statOrNull: (path) => workspaceFs(client).statOrNull(path),
    readdir: (path) => workspaceFs(client).readdir(path),
    mkdir: (path, options) => workspaceFs(client).mkdir(path, options),
    rm: (path, options) => workspaceFs(client).rm(path, options),
  };
  return {
    fs,
    runtime: {
      async exec(command, options) {
        return await client.runtime.exec(command, options) as WorkspaceExecHandle;
      },
      async getExec(id, options) {
        return await client.runtime.getExec(id, options) as WorkspaceExecHandle;
      },
    },
    [Symbol.dispose]() {
      client[Symbol.dispose]();
    },
  };
}

const dependencies: WorkerDependencies = {
  authenticate: authenticateComputerRequest,
  async openWorkspace(wsid, env) {
    const workerEnv = env as Env;
    const id = workerEnv.WORKSPACES.idFromName(wsid);
    // Match Computer's container example exactly: getWorkspace calls the
    // withWorkspace-installed accessor on this DO stub, so fs and runtime share
    // the single Workspace configured with ContainerBase.backend.
    const client = await getWorkspace(
      workerEnv.WORKSPACES.get(id) as unknown as Parameters<typeof getWorkspace>[0],
    );
    return handlerWorkspace(client);
  },
  randomSlug,
};

export async function authenticateComputerRequest(
  request: Request,
  env: HandlerEnv,
  workspaceId: string,
): Promise<GatewayCapabilityClaims> {
  return await verifyGatewayCapability(bearerGatewayCapability(request), {
    secret: env.GATEWAY_SIGNING_SECRET,
    scope: "computer",
    origin: request.headers.get("Origin"),
    workspace: workspaceId,
  });
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env, dependencies);
  },
} satisfies ExportedHandler<Env>;
