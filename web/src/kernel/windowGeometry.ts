import type { WindowRect } from "./types";

export const MENU_BAR_HEIGHT = 38;
export const TITLEBAR_HEIGHT = 38;
export const MIN_WINDOW_WIDTH = 300;
export const MIN_WINDOW_HEIGHT = 210;
export const MIN_VISIBLE_TITLEBAR_WIDTH = 60;
export const CASCADE_STEP = 24;
export const CASCADE_ORIGIN = { x: 54, y: 82 } as const;

export type ViewportSize = { width: number; height: number };

export function workareaForViewport(viewport: ViewportSize): ViewportSize {
  return {
    width: Math.max(MIN_WINDOW_WIDTH, viewport.width),
    height: Math.max(MIN_WINDOW_HEIGHT, viewport.height - MENU_BAR_HEIGHT),
  };
}

export function clampWindowRect(rect: WindowRect, viewport: ViewportSize): WindowRect {
  const workarea = workareaForViewport(viewport);
  const width = Math.min(workarea.width, Math.max(MIN_WINDOW_WIDTH, rect.width));
  const height = Math.min(workarea.height, Math.max(MIN_WINDOW_HEIGHT, rect.height));
  return {
    x: Math.min(workarea.width - MIN_VISIBLE_TITLEBAR_WIDTH, Math.max(0, rect.x)),
    y: Math.min(workarea.height - TITLEBAR_HEIGHT, Math.max(0, rect.y)),
    width,
    height,
  };
}

export function cascadeWindowRect(
  size: Pick<WindowRect, "width" | "height">,
  lastOrigin: Pick<WindowRect, "x" | "y"> | null,
  viewport: ViewportSize,
): WindowRect {
  const workarea = workareaForViewport(viewport);
  const normalizedSize = clampWindowRect(
    { x: 0, y: 0, ...size },
    viewport,
  );
  const wrapOrigin = {
    x: Math.min(CASCADE_ORIGIN.x, Math.max(0, workarea.width - normalizedSize.width)),
    y: Math.min(CASCADE_ORIGIN.y, Math.max(0, workarea.height - normalizedSize.height)),
  };
  const candidate = lastOrigin === null
    ? wrapOrigin
    : { x: lastOrigin.x + CASCADE_STEP, y: lastOrigin.y + CASCADE_STEP };
  const leavesWorkarea = candidate.x + normalizedSize.width > workarea.width ||
    candidate.y + normalizedSize.height > workarea.height;
  return clampWindowRect(
    {
      ...(leavesWorkarea ? wrapOrigin : candidate),
      width: normalizedSize.width,
      height: normalizedSize.height,
    },
    viewport,
  );
}

export function currentViewport(): ViewportSize {
  const width = typeof window === "undefined" ? 0 : window.innerWidth;
  const height = typeof window === "undefined" ? 0 : window.innerHeight;
  return {
    width: Number.isFinite(width) && width > 0 ? width : 1280,
    height: Number.isFinite(height) && height > 0 ? height : 720,
  };
}
