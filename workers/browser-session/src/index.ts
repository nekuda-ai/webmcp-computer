import { DurableObject } from "cloudflare:workers";
import { BrowserLease, type BrowserLeaseLike } from "./lease";
import { browserRunUpstream } from "./upstream";
import { handleRequest, type Env } from "./worker";

export { authenticateBrowserRequest, handleRequest } from "./worker";
export type { BrowserLeaseLike, Env, LeaseResult, RateLimitBinding, WorkerDependencies } from "./worker";

/** One Durable Object per machine; see `lease.ts` for the policy it enforces. */
export class BrowserLeaseObject extends DurableObject<Env> {
  readonly #lease: BrowserLease;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#lease = new BrowserLease(ctx.storage, browserRunUpstream(env, (...args) => fetch(...args)));
  }

  create(url: string): ReturnType<BrowserLeaseLike["create"]> {
    return this.#lease.create(url);
  }

  heartbeat(sessionId: string): ReturnType<BrowserLeaseLike["heartbeat"]> {
    return this.#lease.heartbeat(sessionId);
  }

  refresh(sessionId: string): ReturnType<BrowserLeaseLike["refresh"]> {
    return this.#lease.refresh(sessionId);
  }

  close(sessionId: string): ReturnType<BrowserLeaseLike["close"]> {
    return this.#lease.close(sessionId);
  }

  override async alarm(): Promise<void> {
    const outcome = await this.#lease.onAlarm();
    if (outcome !== "kept") console.log("WebMCP Computer browser lease", JSON.stringify({ outcome }));
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
