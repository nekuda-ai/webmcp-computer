type SanitizerState =
  | "text"
  | "escape"
  | "escape-intermediate"
  | "csi"
  | "osc"
  | "osc-escape"
  | "control-string"
  | "control-string-escape";

export type TerminalOutputSanitizer = {
  push(chunk: string): string;
  reset(): void;
};

export function createTerminalOutputSanitizer(): TerminalOutputSanitizer {
  let state: SanitizerState = "text";

  return {
    push(chunk) {
      let output = "";
      for (const character of chunk) {
        const code = character.charCodeAt(0);
        if (state === "text") {
          if (code === 0x1b) {
            state = "escape";
          } else if (code === 0x9b) {
            state = "csi";
          } else if (code === 0x9d) {
            state = "osc";
          } else if ([0x90, 0x98, 0x9e, 0x9f].includes(code)) {
            state = "control-string";
          } else if (
            (code >= 0x00 && code <= 0x1f && code !== 0x09 && code !== 0x0a) ||
            (code >= 0x7f && code <= 0x9f)
          ) {
            continue;
          } else {
            output += character;
          }
          continue;
        }

        if (state === "escape") {
          if (character === "[") state = "csi";
          else if (character === "]") state = "osc";
          else if (["P", "X", "^", "_"].includes(character)) state = "control-string";
          else if (code >= 0x20 && code <= 0x2f) state = "escape-intermediate";
          else state = "text";
          continue;
        }

        if (state === "escape-intermediate") {
          if (code < 0x20 || code > 0x2f) state = "text";
          continue;
        }

        if (state === "csi") {
          if (code >= 0x40 && code <= 0x7e) state = "text";
          continue;
        }

        if (state === "osc") {
          if (code === 0x07 || code === 0x9c) state = "text";
          else if (code === 0x1b) state = "osc-escape";
          continue;
        }

        if (state === "osc-escape") {
          state = character === "\\" ? "text" : character === "\x1b" ? "osc-escape" : "osc";
          continue;
        }

        if (state === "control-string") {
          if (code === 0x9c) state = "text";
          else if (code === 0x1b) state = "control-string-escape";
          continue;
        }

        if (state === "control-string-escape") {
          state = character === "\\"
            ? "text"
            : character === "\x1b" ? "control-string-escape" : "control-string";
        }
      }
      return output;
    },
    reset() {
      state = "text";
    },
  };
}
