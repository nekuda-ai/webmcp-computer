import {
  awaitToolInvocationQuiescence,
  getInFlightToolInvocationCount,
  hasInFlightSiteToolInvocation,
  SITE_TOOL_TIMEOUT_MS,
} from "../../tools/registry";

type Waiter = {
  resolve: () => void;
  reject: (error: unknown) => void;
};

type Schedule = (callback: () => void, delayMs: number) => () => void;

const scheduleTimeout: Schedule = (callback, delayMs) => {
  const timeout = setTimeout(callback, delayMs);
  return () => clearTimeout(timeout);
};

export type PreviewReloadScheduler = {
  request(delayMs?: number): Promise<void>;
  dispose(): void;
};

export function createPreviewReloadScheduler(
  reload: () => Promise<void>,
  schedule: Schedule = scheduleTimeout,
): PreviewReloadScheduler {
  let cancelTimer: (() => void) | undefined;
  let disposed = false;
  let running = false;
  let pending = false;
  let waiters: Waiter[] = [];

  const start = () => {
    if (disposed || running || !pending || cancelTimer !== undefined) return;
    running = true;
    pending = false;
    const currentWaiters = waiters;
    waiters = [];
    void reload().then(
      () => currentWaiters.forEach(({ resolve }) => resolve()),
      (error: unknown) => currentWaiters.forEach(({ reject }) => reject(error)),
    ).finally(() => {
      running = false;
      start();
    });
  };

  return {
    request(delayMs = 0) {
      if (disposed) return Promise.reject(new Error("webmcp-computer: preview reload scheduler is closed"));
      const result = new Promise<void>((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
      pending = true;
      cancelTimer?.();
      cancelTimer = undefined;
      if (delayMs > 0) {
        cancelTimer = schedule(() => {
          cancelTimer = undefined;
          start();
        }, delayMs);
      } else {
        start();
      }
      return result;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelTimer?.();
      cancelTimer = undefined;
      const error = new Error("webmcp-computer: preview reload scheduler is closed");
      waiters.forEach(({ reject }) => reject(error));
      waiters = [];
      pending = false;
    },
  };
}

type PendingCommit = {
  commit: () => void;
  discard: () => void;
};

type PreviewFrameCommitGateOptions = {
  getInFlightCount?: () => number;
  waitForQuiescence?: () => Promise<void>;
  hasInFlightSiteTool?: (scope: string) => boolean;
  maxWaitMs?: number;
  siteToolMaxWaitMs?: number;
  siteToolScope?: string;
  schedule?: Schedule;
};

export type PreviewFrameCommitGate = {
  request(commit: () => void, discard?: () => void): void;
  dispose(): void;
};

export function createPreviewFrameCommitGate({
  getInFlightCount = getInFlightToolInvocationCount,
  waitForQuiescence = awaitToolInvocationQuiescence,
  hasInFlightSiteTool = hasInFlightSiteToolInvocation,
  maxWaitMs = 2_000,
  siteToolMaxWaitMs = SITE_TOOL_TIMEOUT_MS,
  siteToolScope,
  schedule = scheduleTimeout,
}: PreviewFrameCommitGateOptions = {}): PreviewFrameCommitGate {
  let disposed = false;
  let pending: PendingCommit | undefined;
  let flushing = false;

  const delay = (delayMs: number) => new Promise<void>((resolve) => {
    schedule(resolve, delayMs);
  });

  const flush = async () => {
    if (flushing || disposed) return;
    flushing = true;
    const deferred = getInFlightCount() > 0;
    if (deferred) {
      const waitMs = siteToolScope !== undefined && hasInFlightSiteTool(siteToolScope)
        ? siteToolMaxWaitMs
        : maxWaitMs;
      const deadline = Date.now() + waitMs;
      while (!disposed && getInFlightCount() > 0) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const timedOut = await Promise.race([
          waitForQuiescence().then(() => false),
          delay(remaining).then(() => true),
        ]);
        if (timedOut) break;
      }
      if (!disposed) await delay(0);
    }
    if (!disposed) {
      const next = pending;
      pending = undefined;
      next?.commit();
    }
    flushing = false;
    if (pending !== undefined) void flush();
  };

  return {
    request(commit, discard = () => {}) {
      if (disposed) {
        discard();
        return;
      }
      pending?.discard();
      pending = { commit, discard };
      void flush();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pending?.discard();
      pending = undefined;
    },
  };
}
