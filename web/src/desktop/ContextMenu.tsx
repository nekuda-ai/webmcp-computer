import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { formatVerbCall } from "./verbPresentation";

export type ContextMenuAction = {
  type?: "item";
  label: string;
  verb?: string;
  arg?: string | number;
  disabled?: boolean;
  onSelect: () => void;
};

export type ContextMenuSeparator = { type: "separator" };
export type ContextMenuItem = ContextMenuAction | ContextMenuSeparator;

export type ContextMenuDescriptor = {
  label: string;
  x: number;
  y: number;
  items: ContextMenuItem[];
};

type ActiveContextMenu = ContextMenuDescriptor & { id: number };
type DismissReason = "escape" | "click-away" | "scroll" | "contextmenu" | "activation";
type Listener = () => void;
type FocusableElement = Element & { focus: () => void };

function currentFocusableElement(): FocusableElement | null {
  if (typeof document === "undefined") return null;
  const active = document.activeElement;
  return active && "focus" in active && typeof active.focus === "function"
    ? active as FocusableElement
    : null;
}

export class ContextMenuMachine {
  private current: ActiveContextMenu | null = null;
  private listeners = new Set<Listener>();
  private nextId = 1;
  private focusBeforeOpen: FocusableElement | null = null;

  snapshot = (): ActiveContextMenu | null => this.current;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  open(menu: ContextMenuDescriptor): void {
    if (this.current === null) this.focusBeforeOpen = currentFocusableElement();
    this.current = { ...menu, id: this.nextId };
    this.nextId += 1;
    this.emit();
  }

  dismiss(_reason: DismissReason): void {
    if (this.current === null) return;
    const focusBeforeOpen = this.focusBeforeOpen;
    this.current = null;
    this.focusBeforeOpen = null;
    this.emit();
    if (focusBeforeOpen?.isConnected) focusBeforeOpen.focus();
  }

  activate(index: number): boolean {
    const item = this.current?.items[index];
    if (!item || item.type === "separator" || item.disabled) return false;
    this.dismiss("activation");
    item.onSelect();
    return true;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const contextMenuMachine = new ContextMenuMachine();

export function clampContextMenuPosition(
  point: { x: number; y: number },
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const margin = 8;
  return {
    left: Math.max(margin, Math.min(point.x, viewport.width - menu.width - margin)),
    top: Math.max(margin, Math.min(point.y, viewport.height - menu.height - margin)),
  };
}

function enabledMenuItem(item: ContextMenuItem | undefined): item is ContextMenuAction {
  return item !== undefined && item.type !== "separator" && !item.disabled;
}

export function nextEnabledMenuItem(
  items: readonly ContextMenuItem[],
  current: number,
  direction: 1 | -1,
): number {
  if (items.length === 0) return -1;
  let candidate = current < 0
    ? (direction === 1 ? 0 : items.length - 1)
    : (current + direction + items.length) % items.length;
  for (let checked = 0; checked < items.length; checked += 1) {
    if (enabledMenuItem(items[candidate])) return candidate;
    candidate = (candidate + direction + items.length) % items.length;
  }
  return -1;
}

export function keepsNativeContextMenu(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(
    "input, textarea, [contenteditable]:not([contenteditable='false'])",
  ) !== null;
}

export function showContextMenu(
  event: ReactMouseEvent,
  menu: Omit<ContextMenuDescriptor, "x" | "y">,
): boolean {
  if (keepsNativeContextMenu(event.target)) return false;
  event.preventDefault();
  event.stopPropagation();
  contextMenuMachine.open({ ...menu, x: event.clientX, y: event.clientY });
  return true;
}

export function ContextMenu() {
  const menu = useSyncExternalStore(
    contextMenuMachine.subscribe,
    contextMenuMachine.snapshot,
    () => null,
  );
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [position, setPosition] = useState<{ id: number; left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    setPosition({
      id: menu.id,
      ...clampContextMenuPosition(
        { x: menu.x, y: menu.y },
        { width: rect.width, height: rect.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    });
    const first = nextEnabledMenuItem(menu.items, -1, 1);
    if (first >= 0) buttonRefs.current[first]?.focus();
    else menuRef.current.focus();
  }, [menu]);

  useEffect(() => {
    const dismissOnPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      contextMenuMachine.dismiss("click-away");
    };
    const dismissOnContextMenu = () => contextMenuMachine.dismiss("contextmenu");
    const dismissOnScroll = () => contextMenuMachine.dismiss("scroll");
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") contextMenuMachine.dismiss("escape");
    };
    document.addEventListener("pointerdown", dismissOnPointerDown, true);
    document.addEventListener("contextmenu", dismissOnContextMenu, true);
    document.addEventListener("keydown", dismissOnEscape);
    window.addEventListener("scroll", dismissOnScroll, true);
    return () => {
      document.removeEventListener("pointerdown", dismissOnPointerDown, true);
      document.removeEventListener("contextmenu", dismissOnContextMenu, true);
      document.removeEventListener("keydown", dismissOnEscape);
      window.removeEventListener("scroll", dismissOnScroll, true);
    };
  }, []);

  if (!menu || typeof document === "undefined") return null;
  const readyPosition = position?.id === menu.id ? position : null;
  const moveFocus = (event: ReactKeyboardEvent<HTMLDivElement>, direction: 1 | -1) => {
    event.preventDefault();
    const current = buttonRefs.current.findIndex((button) => button === document.activeElement);
    const next = nextEnabledMenuItem(menu.items, current, direction);
    if (next >= 0) buttonRefs.current[next]?.focus();
  };

  return createPortal(
    <div
      ref={menuRef}
      className={`context-menu${readyPosition ? " is-ready" : ""}`}
      data-context-menu=""
      data-analytics-block=""
      role="menu"
      aria-label={menu.label}
      tabIndex={-1}
      style={{
        left: readyPosition?.left ?? menu.x,
        top: readyPosition?.top ?? menu.y,
      } as CSSProperties}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") moveFocus(event, 1);
        else if (event.key === "ArrowUp") moveFocus(event, -1);
        else if (event.key === "Enter") {
          const current = buttonRefs.current.findIndex((button) => button === document.activeElement);
          if (current >= 0) {
            event.preventDefault();
            contextMenuMachine.activate(current);
          }
        }
      }}
    >
      {menu.items.map((item, index) => {
        if (item.type === "separator") {
          return <div className="context-menu__separator" role="separator" key={`separator-${index}`} />;
        }
        return (
          <button
            key={`${item.label}-${index}`}
            ref={(node) => { buttonRefs.current[index] = node; }}
            className="context-menu__item"
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => contextMenuMachine.activate(index)}
          >
            <span>{item.label}</span>
            {item.verb ? (
              <span className="context-menu__verb mono">{formatVerbCall(item.verb, item.arg)}</span>
            ) : null}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
