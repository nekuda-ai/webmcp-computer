/**
 * Kept dependency-free because its source is injected into opaque app frames.
 */
export function installFrameConsoleCapture(
  send: (level: "log" | "info" | "warn" | "error", message: string) => void,
): void {
  const maxMessageBytes = 8 * 1_024;
  const truncationMarker = "…[truncated]";
  const encoder = new TextEncoder();
  const truncate = (message: string) => {
    if (encoder.encode(message).byteLength <= maxMessageBytes) return message;
    const markerBytes = encoder.encode(truncationMarker).byteLength;
    const contentBudget = Math.max(0, maxMessageBytes - markerBytes);
    let prefix = "";
    let prefixBytes = 0;
    for (const character of message) {
      const characterBytes = encoder.encode(character).byteLength;
      if (prefixBytes + characterBytes > contentBudget) break;
      prefix += character;
      prefixBytes += characterBytes;
    }
    return `${prefix}${truncationMarker}`;
  };
  const format = (value: unknown) => {
    if (value instanceof Error) return value.stack || value.message;
    try {
      return typeof value === "string" ? value : JSON.stringify(value);
    } catch {
      return String(value);
    }
  };
  const sendConsole = (level: "log" | "info" | "warn" | "error", args: unknown[]) => {
    send(level, truncate(Array.from(args, format).join(" ")));
  };
  for (const level of ["log", "info", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      sendConsole(level, args);
      original(...args);
    };
  }
  window.addEventListener("error", (event) => {
    sendConsole("error", [
      event.message,
      event.filename && event.lineno ? `${event.filename}:${event.lineno}` : "",
    ]);
  });
  window.addEventListener("unhandledrejection", (event) => {
    sendConsole("error", ["Unhandled rejection", event.reason]);
  });
}
