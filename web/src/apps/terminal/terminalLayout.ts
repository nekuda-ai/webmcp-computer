export const TERMINAL_CELL_HEIGHT = 22;
export const TERMINAL_HORIZONTAL_INSET = 28;
export const TERMINAL_VERTICAL_RESERVE = 34;

export function terminalGridSize(width: number, height: number): { cols: number; rows: number } {
  return {
    cols: Math.max(20, Math.floor((width - TERMINAL_HORIZONTAL_INSET) / 7.8)),
    rows: Math.max(5, Math.floor((height - TERMINAL_VERTICAL_RESERVE) / TERMINAL_CELL_HEIGHT)),
  };
}
