import type { TerminalLine } from "../../kernel/terminalSessions";
import { createTerminalOutputSanitizer } from "./terminalOutputSanitizer";

export const TERMINAL_RESET = "\x1b[0m";
export const TERMINAL_INPUT = "\x1b[38;2;216;236;255m";
export const TERMINAL_AGENT_ROW = "\x1b[48;2;20;50;75m";

function sanitizeInput(text: string): string {
  return createTerminalOutputSanitizer().push(text);
}

export function renderStoredInputLine(
  line: Pick<TerminalLine, "source" | "text">,
): string {
  const tint = line.source === "agent" ? TERMINAL_AGENT_ROW : "";
  return `${tint}${TERMINAL_INPUT}${sanitizeInput(line.text)}${TERMINAL_RESET}\r\n`;
}

export function renderAgentCommandEcho(prompt: string, command: string): string {
  return "\x1b[?25h" +
    `${TERMINAL_AGENT_ROW}${TERMINAL_INPUT}• ${prompt} ` +
    `${sanitizeInput(command)}${TERMINAL_RESET}\r\n`;
}
