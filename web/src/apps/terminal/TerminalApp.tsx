import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  releaseTerminalSession,
  setTerminalShellExecutor,
  terminalSession,
  type TerminalLine,
} from "../../kernel/terminalSessions";
import { executeShell } from "../../kernel/shell/engine";
import { useKernelStore } from "../../kernel/store";
import { VerbHint } from "../../desktop/VerbHint";
import type { AppComponentProps } from "../registry";
import { TERMINAL_CELL_HEIGHT, terminalGridSize } from "./terminalLayout";
import {
  createTerminalOutputSanitizer,
  type TerminalOutputSanitizer,
} from "./terminalOutputSanitizer";
import {
  renderAgentCommandEcho,
  renderStoredInputLine,
  TERMINAL_INPUT,
  TERMINAL_RESET,
} from "./terminalInputRendering";

const PROMPT = "\x1b[38;2;95;122;150m";
const OUTPUT = "\x1b[38;2;125;156;187m";
const ERROR = "\x1b[38;2;255;122;89m";

setTerminalShellExecutor(executeShell);

function terminalText(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\n", "\r\n");
}

function renderedLine(line: TerminalLine, sanitizer: TerminalOutputSanitizer): string {
  if (line.tone === "input") return renderStoredInputLine(line);
  const text = sanitizer.push(`${line.text}\n`);
  return `${line.tone === "error" ? ERROR : OUTPUT}${terminalText(text)}${TERMINAL_RESET}`;
}

export function TerminalApp({ process }: AppComponentProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [agentInput, setAgentInput] = useState<{
    prompt: string;
    command: string;
    row: number;
  } | null>(null);
  const [running, setRunning] = useState(false);
  const [lastCommand, setLastCommand] = useState("");
  const [attachReady, setAttachReady] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setAttachReady(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!attachReady) return undefined;
    const host = hostRef.current;
    if (!host) return undefined;
    const controller = terminalSession(process.pid);
    const terminal = new Terminal({
      allowTransparency: true,
      convertEol: true,
      cursorBlink: false,
      cursorStyle: "block",
      fontFamily: '"IBM Plex Mono", ui-monospace, "SFMono-Regular", monospace',
      fontSize: 12.5,
      letterSpacing: 0.15,
      lineHeight: 1.5,
      scrollback: 2_000,
      theme: {
        background: "#0d1a2b",
        foreground: "#9fd8ff",
        cursor: "#9fd8ff",
        cursorAccent: "#0d1a2b",
        selectionBackground: "rgba(46, 159, 243, 0.34)",
        black: "#0d1a2b",
        red: "#ff7a59",
        green: "#7ee0a3",
        blue: "#2e9ff3",
        brightBlue: "#9fd8ff",
        white: "#d8ecff",
      },
    });
    terminal.open(host);
    terminalRef.current = terminal;

    let prompt = "guest@webmcp-computer:~$";
    let buffer = "";
    let cursor = 0;
    let historyIndex = controller.shell.history.length;
    let busy = false;
    const outputSanitizer = createTerminalOutputSanitizer();

    const writePrompt = () => terminal.write(`${PROMPT}${prompt}${TERMINAL_RESET} `);
    const redraw = () => {
      terminal.write(
        `\r\x1b[2K${PROMPT}${prompt}${TERMINAL_RESET} ` +
          `${TERMINAL_INPUT}${buffer}${TERMINAL_RESET}`,
      );
      const trailing = buffer.length - cursor;
      if (trailing > 0) terminal.write(`\x1b[${trailing}D`);
    };

    const unsubscribe = controller.attach((event) => {
      if (event.type === "reset") {
        terminal.clear();
        const replaySanitizer = createTerminalOutputSanitizer();
        for (const line of event.lines) {
          if (line.tone === "input") replaySanitizer.reset();
          terminal.write(renderedLine(line, replaySanitizer));
        }
        outputSanitizer.reset();
        prompt = event.prompt;
        writePrompt();
        return;
      }
      if (event.type === "typing") {
        outputSanitizer.reset();
        busy = true;
        setRunning(true);
        terminal.write("\x1b[?25l\r\x1b[2K");
        setAgentInput({
          prompt: event.prompt,
          command: event.command,
          row: Math.min(terminal.buffer.active.cursorY, terminal.rows - 2),
        });
        return;
      }
      if (event.type === "input") {
        outputSanitizer.reset();
        setLastCommand(event.command);
        setAgentInput(null);
        terminal.write(renderAgentCommandEcho(event.prompt, event.command));
        return;
      }
      if (event.type === "output") {
        const text = outputSanitizer.push(event.text);
        terminal.write(
          `${event.tone === "error" ? ERROR : OUTPUT}` +
            `${terminalText(text)}${TERMINAL_RESET}`,
        );
        return;
      }
      if (event.type === "clear") {
        outputSanitizer.reset();
        terminal.clear();
        return;
      }
      busy = false;
      outputSanitizer.reset();
      setRunning(false);
      setAgentInput(null);
      buffer = "";
      cursor = 0;
      historyIndex = controller.shell.history.length;
      prompt = event.prompt;
      terminal.write("\x1b[?25h");
      writePrompt();
    });

    const dataDisposable = terminal.onData((data) => {
      if (data === "\u0003") {
        const interrupted = busy && controller.interrupt();
        buffer = "";
        cursor = 0;
        terminal.write("^C\r\n");
        if (!interrupted) writePrompt();
        return;
      }
      if (busy) return;
      if (data === "\r") {
        terminal.write("\r\n");
        const command = buffer;
        buffer = "";
        cursor = 0;
        if (command.trim() === "") {
          writePrompt();
          return;
        }
        busy = true;
        setRunning(true);
        setLastCommand(command);
        const action = useKernelStore.getState().osEvent("human", "term_exec", {
          command,
          term_pid: process.pid,
          appId: "terminal",
          pid: process.pid,
        });
        void controller.run(command, "human", { inputAlreadyRendered: true }).then(
          () => useKernelStore.getState().settleEvent(action, true),
          (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            useKernelStore.getState().settleEvent(action, false, message);
          },
        );
        return;
      }
      if (data === "\u000c") {
        terminal.clear();
        redraw();
        return;
      }
      if (data === "\u007f") {
        if (cursor > 0) {
          buffer = `${buffer.slice(0, cursor - 1)}${buffer.slice(cursor)}`;
          cursor -= 1;
          redraw();
        }
        return;
      }
      if (data === "\x1b[A" || data === "\x1b[B") {
        const history = controller.shell.history;
        if (data === "\x1b[A" && historyIndex > 0) historyIndex -= 1;
        if (data === "\x1b[B" && historyIndex < history.length) historyIndex += 1;
        buffer = historyIndex < history.length ? history[historyIndex] ?? "" : "";
        cursor = buffer.length;
        redraw();
        return;
      }
      if (data === "\x1b[D") {
        if (cursor > 0) {
          cursor -= 1;
          terminal.write("\x1b[D");
        }
        return;
      }
      if (data === "\x1b[C") {
        if (cursor < buffer.length) {
          cursor += 1;
          terminal.write("\x1b[C");
        }
        return;
      }
      if (/^[^\x00-\x1f\x7f]+$/.test(data)) {
        buffer = `${buffer.slice(0, cursor)}${data}${buffer.slice(cursor)}`;
        cursor += data.length;
        redraw();
      }
    });

    const resize = () => {
      const rect = host.getBoundingClientRect();
      // A minimized window measures 0x0; resizing then would reflow the live
      // buffer to the grid floor. The un-hide resize restores the real grid.
      if (rect.width === 0 || rect.height === 0) return;
      const grid = terminalGridSize(rect.width, rect.height);
      terminal.resize(grid.cols, grid.rows);
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    resize();
    terminal.focus();

    return () => {
      unsubscribe();
      dataDisposable.dispose();
      resizeObserver.disconnect();
      terminalRef.current = null;
      terminal.dispose();
      queueMicrotask(() => {
        if (!useKernelStore.getState().processes.some(({ pid }) => pid === process.pid)) {
          releaseTerminalSession(process.pid);
        }
      });
    };
  }, [attachReady, process.pid]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    const terminal = terminalRef.current;
    if (!host || !terminal) return;
    const rect = host.getBoundingClientRect();
    // Minimized window measures 0x0 — same guard as the ResizeObserver above.
    if (rect.width === 0 || rect.height === 0) return;
    const grid = terminalGridSize(rect.width, rect.height);
    terminal.resize(grid.cols, grid.rows);
  }, [process.windowRect.height, process.windowRect.width]);

  return (
    <section
      className="terminal-app"
      data-terminal-pid={process.pid}
      data-terminal-busy={running ? "true" : "false"}
      data-terminal-last-command={lastCommand}
    >
      <VerbHint verb="term_exec" arg={`PID ${process.pid}`}>
        <div className="terminal-host" ref={hostRef} aria-label={`Terminal session PID ${process.pid}`} />
      </VerbHint>
      {agentInput ? (
        <div
          className="terminal-agent-row mono"
          aria-live="polite"
          style={{ top: `${10 + agentInput.row * TERMINAL_CELL_HEIGHT}px` }}
        >
          <span className="terminal-agent-presence" aria-hidden="true" />
          <span className="terminal-agent-tag">CODEX</span>
          <span className="terminal-agent-prompt">{agentInput.prompt}</span>
          <span className="terminal-agent-command">{agentInput.command}</span>
          <span className="terminal-agent-caret" aria-hidden="true" />
        </div>
      ) : null}
      <div className="terminal-scanlines" aria-hidden="true" />
    </section>
  );
}
