export const MAX_PREVIEW_CONSOLE_MESSAGE_BYTES = 8 * 1024;
export const PREVIEW_CONSOLE_TRUNCATION_MARKER = "…[truncated]";

export function truncatePreviewConsoleMessage(
  message: string,
  maxBytes = MAX_PREVIEW_CONSOLE_MESSAGE_BYTES,
): string {
  const encoder = new TextEncoder();
  if (encoder.encode(message).byteLength <= maxBytes) return message;
  const markerBytes = encoder.encode(PREVIEW_CONSOLE_TRUNCATION_MARKER).byteLength;
  const contentBudget = Math.max(0, maxBytes - markerBytes);
  let prefix = "";
  let prefixBytes = 0;
  for (const character of message) {
    const characterBytes = encoder.encode(character).byteLength;
    if (prefixBytes + characterBytes > contentBudget) break;
    prefix += character;
    prefixBytes += characterBytes;
  }
  return `${prefix}${PREVIEW_CONSOLE_TRUNCATION_MARKER}`;
}
