import { describe, expect, test } from "bun:test";
import {
  renderAgentCommandEcho,
  renderStoredInputLine,
  TERMINAL_AGENT_ROW,
  TERMINAL_INPUT,
  TERMINAL_RESET,
} from "./terminalInputRendering";

describe("terminal input rendering", () => {
  test("strips command control sequences before adding VerbOS styling", () => {
    const command = "echo ok \x1b[2J\x1b[10A\x1b]0;pwned";

    expect(renderAgentCommandEcho("codex@verbos:~$", command)).toBe(
      `\x1b[?25h${TERMINAL_AGENT_ROW}${TERMINAL_INPUT}` +
        `• codex@verbos:~$ echo ok ${TERMINAL_RESET}\r\n`,
    );
    expect(renderStoredInputLine({
      text: `codex@verbos:~$ ${command}`,
      source: "agent",
    })).toBe(
      `${TERMINAL_AGENT_ROW}${TERMINAL_INPUT}` +
        `codex@verbos:~$ echo ok ${TERMINAL_RESET}\r\n`,
    );
  });

  test("renders plain command text unchanged", () => {
    expect(renderAgentCommandEcho("codex@verbos:~$", "echo Aurora 🙂")).toBe(
      `\x1b[?25h${TERMINAL_AGENT_ROW}${TERMINAL_INPUT}` +
        `• codex@verbos:~$ echo Aurora 🙂${TERMINAL_RESET}\r\n`,
    );
  });
});
