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
import { CLOUD_BUDGET_MS, CLOUD_IDLE_MS } from "../../../shared/session-limits";
import { AlarmSlots } from "./alarms";
import {
  handleRequest,
  type HandlerEnv,
  type WorkerDependencies,
  type WorkspaceExecHandle,
  type WorkspaceFileSystem,
  type WorkspaceHandle,
  type WorkspaceLease,
} from "./handler";
import { PublishQuota } from "./publishQuota";
import { RuntimeLease } from "./runtimeLease";
import { randomSlug } from "./slug";
import { DurableSyncRetryScheduler } from "./syncRetry";
import { coordinateWorkspaceAlarm, DurableTerminalSyncAttempts } from "./workspaceAlarm";

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

function workspaceOptions(
  self: InstanceType<typeof ContainerBase>,
  syncRetries: DurableSyncRetryScheduler,
): WorkspaceOptions {
  // @cloudflare/computer 0.2.1 and current workers-types carry structurally
  // equivalent SQL generics that TypeScript cannot unify across package copies.
  const { ctx } = self as unknown as { ctx: DurableObjectState };
  type CloudflareTracing = Parameters<typeof createCloudflareObserver>[0]["tracing"];
  const tracing = (ctx as unknown as { tracing?: CloudflareTracing }).tracing;
  return {
    storage: ctx.storage as unknown as DurableObjectStorageLike,
    backends: [self.backend],
    observer: createCloudflareObserver({ tracing }),
    retryScheduler: syncRetries,
    retry: {
      initialDelayMs: 2_000,
      maxDelayMs: 60_000,
      maxAttempts: 12,
    },
  };
}

export class WebMCPComputerWorkspace extends ContainerBase {
  readonly alarms = new AlarmSlots(this.ctx.storage);
  readonly lease = new RuntimeLease(this.ctx.storage, this.alarms, {
    budgetMs: CLOUD_BUDGET_MS,
    idleMs: CLOUD_IDLE_MS,
  });
  readonly publishQuota = new PublishQuota(this.ctx.storage);
  readonly syncRetries = new DurableSyncRetryScheduler(this.ctx.storage, this.alarms);
  readonly terminalSyncAttempts = new DurableTerminalSyncAttempts(this.ctx.storage);
  readonly workspace = new Workspace(workspaceOptions(this, this.syncRetries));
  #leaseOperation: Promise<void> = Promise.resolve();

  #withLease<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#leaseOperation.then(operation, operation);
    this.#leaseOperation = result.then(() => undefined, () => undefined);
    return result;
  }

  async __getWorkspaceStub(): Promise<WorkspaceStub> {
    await this.workspace.ready();
    return this.workspace.stub();
  }

  // Lease RPC surface used by the Worker before/after every exec.
  acquireRuntimeLease(busyForMs: number): ReturnType<WorkspaceLease["acquire"]> {
    return this.#withLease(() => this.lease.acquire(
      busyForMs,
      async () => {
        try {
          await this.terminalSyncAttempts.clear(this.backend.id);
        } catch (error) {
          console.error("WebMCP Computer terminal sync marker could not be cleared before exec admission", error);
          throw error;
        }
      },
    ));
  }

  runtimeLeaseStarted(): ReturnType<WorkspaceLease["started"]> {
    return this.#withLease(() => this.lease.started());
  }

  releaseRuntimeLease(): ReturnType<WorkspaceLease["release"]> {
    return this.#withLease(() => this.lease.release());
  }

  abandonRuntimeLease(): ReturnType<WorkspaceLease["abandon"]> {
    return this.#withLease(() => this.lease.abandon());
  }

  runtimeBudget(): ReturnType<RuntimeLease["budget"]> {
    return this.#withLease(() => this.lease.budget());
  }

  // Publish quota RPCs use only this DO's durable storage. They never access the Workspace
  // runtime or container backend, so publishing cannot start a container.
  reservePublish(reservationId: string): ReturnType<PublishQuota["reserve"]> {
    return this.publishQuota.reserve(reservationId);
  }

  beginPublish(reservationId: string): ReturnType<PublishQuota["begin"]> {
    return this.publishQuota.begin(reservationId);
  }

  commitPublish(reservationId: string): ReturnType<PublishQuota["commit"]> {
    return this.publishQuota.commit(reservationId);
  }

  releasePublish(reservationId: string): ReturnType<PublishQuota["release"]> {
    return this.publishQuota.release(reservationId);
  }

  override async fetch(request: Request): Promise<Response> {
    return await this.backend.handleFetch(request);
  }

  // SIGKILL rather than SIGTERM: the platform otherwise waits up to 15 minutes for the
  // process to exit, and we would pay for every one of them. The next exec relaunches;
  // the DO filesystem is normally authoritative because cleanup waits for sync. The hard
  // budget's explicitly logged terminal-sync path is the unavoidable exception.
  async #stopContainer(): Promise<void> {
    const container = this.ctx.container;
    if (!container?.running) return;
    await container.destroy();
  }

  override async alarm(): Promise<void> {
    await coordinateWorkspaceAlarm({
      alarms: this.alarms,
      backend: this.backend.id,
      now: Date.now(),
      terminalSyncAttempts: this.terminalSyncAttempts,
      getPendingSync: () => this.syncRetries.get(this.backend.id),
      retryPendingSync: () => this.workspace.retryPendingSync(this.backend.id),
      runtimeCleanupReason: () => this.#withLease(() => this.lease.cleanupReason()),
      runtimeHardBudgetDeadline: () => this.#withLease(() => this.lease.hardBudgetDeadline()),
      handleRuntimeLease: async () => {
        const outcome = await this.#withLease(() => this.lease.onAlarm(() => this.#stopContainer()));
        if (outcome !== "kept") console.log("WebMCP Computer runtime lease", JSON.stringify({ outcome }));
        return outcome;
      },
      onSyncResult(result) {
        console.log("WebMCP Computer workspace sync retry", JSON.stringify(result));
      },
      onSyncError(error) {
        console.error("WebMCP Computer workspace sync retry failure", error);
      },
      onTerminalMarkerError(error) {
        console.error("WebMCP Computer terminal sync marker storage failure; cleanup still takes precedence", error);
      },
      onTerminalSyncFailure(failure) {
        console.error(
          "WebMCP Computer workspace sync terminal failure: runtime budget takes precedence; " +
          "destroying container after terminal sync decision while retaining diagnostic intent",
          failure,
        );
      },
    });
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
    readdir: (path, options) => workspaceFs(client).readdir(path, options),
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
    const stub = workerEnv.WORKSPACES.get(id);
    // Match Computer's container example exactly: getWorkspace calls the
    // withWorkspace-installed accessor on this DO stub, so fs and runtime share
    // the single Workspace configured with ContainerBase.backend.
    const client = await getWorkspace(stub as unknown as Parameters<typeof getWorkspace>[0]);
    const handle = handlerWorkspace(client);
    handle.lease = {
      acquire: (busyForMs) => stub.acquireRuntimeLease(busyForMs),
      started: () => stub.runtimeLeaseStarted(),
      release: () => stub.releaseRuntimeLease(),
      abandon: () => stub.abandonRuntimeLease(),
    };
    return handle;
  },
  openPublishQuota(wsid, env) {
    const workerEnv = env as Env;
    const stub = workerEnv.WORKSPACES.get(workerEnv.WORKSPACES.idFromName(wsid));
    return {
      reserve: (reservationId) => stub.reservePublish(reservationId),
      begin: (reservationId) => stub.beginPublish(reservationId),
      commit: (reservationId) => stub.commitPublish(reservationId),
      release: (reservationId) => stub.releasePublish(reservationId),
    };
  },
  randomReservationId: () => crypto.randomUUID(),
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
