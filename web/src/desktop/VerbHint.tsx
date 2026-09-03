import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useKernelStore } from "../kernel/store";
import { formatVerbCall } from "./verbPresentation";

type VerbHintProps = {
  verb: string;
  arg?: string | number;
  children: ReactNode;
};

export type HintPlacement = {
  arrowX: number;
  left: number;
  placement: "above" | "below";
  top: number;
};

type Rect = Pick<DOMRect, "bottom" | "left" | "right" | "top" | "width">;

type ActiveHintClaim = {
  dismiss: () => void;
  token: symbol;
};

let activeHintClaim: ActiveHintClaim | undefined;

function claimVerbHint(token: symbol, dismiss: () => void): void {
  if (activeHintClaim?.token === token) {
    activeHintClaim = { token, dismiss };
    return;
  }
  const previous = activeHintClaim;
  activeHintClaim = { token, dismiss };
  previous?.dismiss();
}

function releaseVerbHint(token: symbol): void {
  if (activeHintClaim?.token === token) activeHintClaim = undefined;
}

export function placeVerbHint(
  anchor: Rect,
  tip: { height: number; width: number },
  viewport: { height: number; width: number },
): HintPlacement {
  const gap = 10;
  const margin = 8;
  const fitsAbove = anchor.top - tip.height - gap >= margin;
  const fitsBelow = anchor.bottom + tip.height + gap <= viewport.height - margin;
  const placement = fitsAbove || !fitsBelow ? "above" : "below";
  const idealTop = placement === "above"
    ? anchor.top - tip.height - gap
    : anchor.bottom + gap;
  const top = Math.min(viewport.height - tip.height - margin, Math.max(margin, idealTop));
  const anchorCenter = anchor.left + anchor.width / 2;
  const left = Math.min(
    viewport.width - tip.width - margin,
    Math.max(margin, anchorCenter - tip.width / 2),
  );
  return {
    arrowX: Math.min(tip.width - 10, Math.max(10, anchorCenter - left)),
    left,
    placement,
    top,
  };
}

export function VerbHint({ verb, arg, children }: VerbHintProps) {
  const enabled = useKernelStore((state) => state.settings.verb_hints);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const tokenRef = useRef<symbol | null>(null);
  const token = tokenRef.current ??= Symbol("VerbHint");
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<HintPlacement | null>(null);

  const hide = useCallback(() => {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    timerRef.current = undefined;
    releaseVerbHint(token);
    setOpen(false);
    setPosition(null);
  }, [token]);

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    const tip = tipRef.current;
    if (!anchor || !tip) return;
    setPosition(placeVerbHint(
      anchor.getBoundingClientRect(),
      tip.getBoundingClientRect(),
      { width: window.innerWidth, height: window.innerHeight },
    ));
  }, []);

  useLayoutEffect(() => {
    if (!open) return undefined;
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  useEffect(() => hide, [hide]);

  useEffect(() => {
    if (!enabled) hide();
  }, [enabled, hide]);

  const showAfterDelay = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const target = event.target;
    if (target instanceof Element && target.closest("[data-verb-hint]") !== event.currentTarget) {
      return;
    }
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined;
      claimVerbHint(token, hide);
      setOpen(true);
    }, 600);
  };

  const tip = enabled && open && typeof document !== "undefined"
    ? createPortal(
      <span
        ref={tipRef}
        className={`verb-hint__tip${position ? " is-ready" : ""}`}
        data-placement={position?.placement ?? "above"}
        data-analytics-block=""
        role="tooltip"
        style={position ? {
          left: position.left,
          top: position.top,
          "--verb-hint-arrow-x": `${position.arrowX}px`,
        } as CSSProperties : undefined}
      >
        <span className="verb-hint__dot" aria-hidden="true" />
        {formatVerbCall(verb, arg)}
      </span>,
      document.body,
    )
    : null;

  return (
    <span
      ref={anchorRef}
      className="verb-hint"
      data-verb-hint=""
      onPointerEnter={enabled ? showAfterDelay : undefined}
      onPointerLeave={enabled ? hide : undefined}
      onPointerDown={enabled ? hide : undefined}
    >
      {children}
      {tip}
    </span>
  );
}
