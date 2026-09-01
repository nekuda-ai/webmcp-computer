import {
  getWorkspace,
  withWorkspace,
  type DurableObjectStorageLike,
  type WorkspaceClient,
  type WorkspaceFilesystemStub,
  type WorkspaceOptions,
} from "@cloudflare/computer";
import {
  CloudflareContainerBackend,
  withWorkspaceContainer,
} from "@cloudflare/computer/backends/container";
import { DurableObject } from "cloudflare:workers";
import {
  handleRequest,
  type HandlerEnv,
  type WorkerDependencies,
  type WorkspaceExecHandle,
  type WorkspaceFileSystem,
  type WorkspaceHandle,
} from "./handler";
import { randomSlug } from "./slug";

export { WorkspaceProxy } from "@cloudflare/computer";

type Env = HandlerEnv & {
  WORKSPACES: DurableObjectNamespace<VerbosWorkspace>;
};

class ContainerBase extends withWorkspaceContainer(class extends DurableObject<Env> {}) {
  readonly backend = new CloudflareContainerBackend({
    container: () => this,
    workspace: { binding: "WORKSPACES", id: this.ctx.id.toString() },
    egress: { mode: "direct" },
  });
}

function workspaceOptions(self: InstanceType<typeof ContainerBase>): WorkspaceOptions {
  // @cloudflare/computer 0.2.1 and current workers-types carry structurally
  // equivalent SQL generics that TypeScript cannot unify across package copies.
  const { ctx } = self as unknown as { ctx: DurableObjectState };
  return {
    storage: ctx.storage as unknown as DurableObjectStorageLike,
    backends: [self.backend],
  };
}

export class VerbosWorkspace extends withWorkspace(ContainerBase, workspaceOptions) {
  override async fetch(request: Request): Promise<Response> {
    return await this.backend.handleFetch(request);
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

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env, dependencies);
  },
} satisfies ExportedHandler<Env>;
