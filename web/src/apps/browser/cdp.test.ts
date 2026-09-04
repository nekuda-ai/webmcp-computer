import { describe, expect, test } from "bun:test";
import { CdpClient, type BrowserWebSocket } from "./cdp";

class FakeSocket extends EventTarget implements BrowserWebSocket {
  readyState: number = WebSocket.OPEN;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  receive(message: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }
}

describe("CdpClient", () => {
  test("matches out-of-order responses by request id", async () => {
    const socket = new FakeSocket();
    const client = new CdpClient(socket);
    const first = client.send<{ value: number }>("Page.one");
    const second = client.send<{ value: number }>("Page.two");
    const [firstMessage, secondMessage] = socket.sent.map((value) => JSON.parse(value) as { id: number });
    socket.receive({ id: secondMessage?.id, result: { value: 2 } });
    socket.receive({ id: firstMessage?.id, result: { value: 1 } });
    expect(await first).toEqual({ value: 1 });
    expect(await second).toEqual({ value: 2 });
  });

  test("aborts a pending command promptly and ignores its stale response", async () => {
    const socket = new FakeSocket();
    const client = new CdpClient(socket);
    const controller = new AbortController();
    const pending = client.send("Page.navigate", { url: "https://old-owner.test" }, controller.signal);
    const sent = JSON.parse(socket.sent[0] ?? "") as { id: number };

    controller.abort(new Error("machine ownership was lost"));
    await expect(pending).rejects.toThrow("machine ownership was lost");
    socket.receive({ id: sent.id, result: {} });
    expect(socket.sent).toHaveLength(1);
  });

  test("times out commands and settles pending calls on close", async () => {
    const timeoutSocket = new FakeSocket();
    const timeoutClient = new CdpClient(timeoutSocket, { commandTimeoutMs: 5 });
    await expect(timeoutClient.send("Page.slow")).rejects.toThrow(
      "webmcp-computer: browser command timed out: Page.slow",
    );

    const closeSocket = new FakeSocket();
    const closeClient = new CdpClient(closeSocket);
    const pending = closeClient.send("Page.pending");
    closeSocket.close();
    await expect(pending).rejects.toThrow("webmcp-computer: browser connection closed");
  });

  test("prefixes every evaluate operation with its marker", async () => {
    const socket = new FakeSocket();
    const client = new CdpClient(socket);
    const operations = [
      "identity",
      "read",
      "click",
      "type",
      "site_tools",
      "site_call",
      "heartbeat",
    ] as const;
    for (const operation of operations) {
      const result = client.evaluate(operation, "1 + 1");
      const sent = JSON.parse(socket.sent.at(-1) ?? "") as {
        id: number;
        params: { expression: string };
      };
      expect(sent.params.expression.startsWith(`/*webmcp-computer:${operation}*/`)).toBe(true);
      socket.receive({ id: sent.id, result: { result: { value: 2 } } });
      expect(await result).toBe(2);
    }
    await expect(client.send("Runtime.evaluate", { expression: "1 + 1" })).rejects.toThrow(
      "webmcp-computer: browser evaluate expression is missing its operation marker",
    );
  });

  test("sets the remote viewport with device emulation", async () => {
    const socket = new FakeSocket();
    const client = new CdpClient(socket);
    const resized = client.setViewport(1280, 720);
    const sent = JSON.parse(socket.sent.at(-1) ?? "") as {
      id: number;
      method: string;
      params: Record<string, unknown>;
    };
    expect(sent).toEqual({
      id: 1,
      method: "Emulation.setDeviceMetricsOverride",
      params: { width: 1280, height: 720, deviceScaleFactor: 0, mobile: false },
    });
    socket.receive({ id: sent.id, result: {} });
    await expect(resized).resolves.toBeUndefined();
  });

  test("dispatches protocol events", async () => {
    const socket = new FakeSocket();
    const client = new CdpClient(socket);
    const event = client.waitForEvent("Page.loadEventFired");
    socket.receive({ method: "Page.loadEventFired", params: { timestamp: 42 } });
    expect(await event).toEqual({ timestamp: 42 });
  });

  test("reports missing serialized evaluate values with webmcp-computer voice", async () => {
    const socket = new FakeSocket();
    const client = new CdpClient(socket);
    const evaluated = client.evaluate("read", "undefined");
    const sent = JSON.parse(socket.sent.at(-1) ?? "") as { id: number };
    socket.receive({ id: sent.id, result: { result: {} } });
    await expect(evaluated).rejects.toThrow("webmcp-computer: browser returned no value for read");
  });
});
