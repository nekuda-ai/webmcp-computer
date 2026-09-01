import { workareaForViewport, type ViewportSize } from "./windowGeometry";

export const STICKY_NOTE_WIDTH = 230;
export const STICKY_NOTE_HEIGHT = 180;

export function clampStickyPosition(
  position: { x: number; y: number },
  viewport: ViewportSize,
): { x: number; y: number } {
  const workarea = workareaForViewport(viewport);
  return {
    x: Math.min(Math.max(0, workarea.width - STICKY_NOTE_WIDTH), Math.max(0, position.x)),
    y: Math.min(Math.max(0, workarea.height - STICKY_NOTE_HEIGHT), Math.max(0, position.y)),
  };
}

export function defaultStickyPosition(count: number, viewport: ViewportSize): { x: number; y: number } {
  return clampStickyPosition({
    x: viewport.width - STICKY_NOTE_WIDTH - 28 - (count % 4) * 24,
    y: 48 + (count % 6) * 24,
  }, viewport);
}
