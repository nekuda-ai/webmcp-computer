import { describe, expect, test } from "bun:test";
import { executeCloudCommand, type CloudExecDependencies } from "./cloudExec";

const WSID = "0123456789abcdef0123456789abcdef";

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function streamResponse(parts: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}

function dependencies(response: () => Response): CloudExecDependencies {
  return {
    fetch: async () => response(),
    workerBaseUrl: "https://computer.test",
    workspaceId: WSID,
  };
}

describe("executeCloudCommand limit errors", () => {
  test("explains an exhausted cloud budget from a 429 before streaming", async () => {
    const run = executeCloudCommand({ command: "pwd" }, dependencies(() => Response.json(
      { error: "budget exhausted", code: "EBUDGET", retryAfterMs: 3 * 60 * 60_000 + 15 * 60_000 },
      { status: 429 },
    )));
    await expect(run).rejects.toThrow(
      "webmcp-computer: cloud exec failed: cloud time budget (2 h per 24 h) is used up; resets in 3 h 15 min",
    );
  });

  test("explains capacity, budget, and idle codes carried by SSE error frames", async () => {
    await expect(executeCloudCommand({ command: "pwd" }, dependencies(() => streamResponse([
      sse("error", { error: "no free slot", code: "ECAPACITY" }),
    ])))).rejects.toThrow(
      "webmcp-computer: cloud exec failed: cloud is busy or at capacity right now; try again in a minute or keep working locally",
    );

    await expect(executeCloudCommand({ command: "pwd" }, dependencies(() => streamResponse([
      sse("stdout", "partial\n"),
      sse("error", { error: "budget", code: "EBUDGET", retryAfterMs: 30_000 }),
    ])))).rejects.toThrow(
      "webmcp-computer: cloud exec failed: cloud time budget (2 h per 24 h) is used up; resets in under a minute",
    );

    await expect(executeCloudCommand({ command: "pwd" }, dependencies(() => streamResponse([
      sse("error", { error: "stopped", code: "EIDLE" }),
    ])))).rejects.toThrow(
      "webmcp-computer: cloud exec failed: cloud container stopped after 5 minutes of inactivity; run the command again to continue",
    );
  });

  test("keeps plain Worker error text and status fallbacks", async () => {
    await expect(executeCloudCommand({ command: "pwd" }, dependencies(() => Response.json(
      { error: "rate limited" },
      { status: 429 },
    )))).rejects.toThrow("webmcp-computer: cloud exec failed: rate limited");

    await expect(executeCloudCommand({ command: "pwd" }, dependencies(() => new Response("nope", { status: 502 }))))
      .rejects.toThrow("webmcp-computer: cloud exec failed: computer Worker returned 502");

    await expect(executeCloudCommand({ command: "pwd" }, dependencies(() => streamResponse([
      sse("error", { error: "container crashed", code: "ESOMETHING" }),
    ])))).rejects.toThrow("webmcp-computer: cloud exec failed: container crashed");
  });
});
