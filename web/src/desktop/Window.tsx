import { memo, Suspense } from "react";
import { Rnd } from "react-rnd";
import type { AppDefinition } from "../apps/registry";
import { useKernelStore } from "../kernel/store";
import type { ProcessRecord } from "../kernel/types";
import { showContextMenu } from "./ContextMenu";
import { VerbHint } from "./VerbHint";
import { closeHumanWindow, focusHumanWindow, minimizeHumanWindow } from "./humanActions";

type WindowProps = {
  process: ProcessRecord;
  app: AppDefinition;
  minimized: boolean;
};

export const Window = memo(function Window({ process, app, minimized }: WindowProps) {
  const move = useKernelStore((state) => state.move);
  const resize = useKernelStore((state) => state.resize);
  const osEvent = useKernelStore((state) => state.osEvent);
  const hostname = useKernelStore((state) => state.settings.hostname);
  const AppBody = app.component;
  const title = app.id === "terminal"
    ? `Terminal — ${hostname}`
    : app.id === "ui"
      ? process.path?.split("/").at(-1)?.replace(/\.html$/i, "") ?? app.name
      : app.name;

  const focusWindow = (event: MouseEvent) => {
    const target = event.target as Element;
    if (process.focused || target.closest(".window-control")) return;
    focusHumanWindow(process.pid);
  };
  const minimizeWindow = () => { minimizeHumanWindow(process.pid); };
  const closeWindow = () => { closeHumanWindow(process.pid); };

  return (
    <Rnd
      className={`window-shell window-shell--${app.id}${process.focused ? " is-focused" : " is-idle"}${minimized ? " is-minimized" : ""}`}
      bounds="parent"
      dragHandleClassName="window-titlebar"
      cancel=".window-control"
      minWidth={300}
      minHeight={210}
      size={{ width: process.windowRect.width, height: process.windowRect.height }}
      position={{ x: process.windowRect.x, y: process.windowRect.y }}
      style={{ zIndex: 20 + process.zIndex, ...(minimized ? { display: "none" } : {}) }}
      onMouseDown={focusWindow}
      onDragStop={(_event, data) => {
        move(process.pid, data.x, data.y);
        osEvent("human", "window_move", { pid: process.pid, x: data.x, y: data.y });
      }}
      onResizeStop={(_event, _direction, ref, _delta, position) => {
        const width = ref.offsetWidth;
        const height = ref.offsetHeight;
        move(process.pid, position.x, position.y);
        resize(process.pid, width, height);
        osEvent("human", "window_resize", {
          pid: process.pid,
          x: position.x,
          y: position.y,
          width,
          height,
        });
      }}
      resizeHandleComponent={{
        bottomRight: (
          <VerbHint verb="window_resize" arg={`PID ${process.pid}`}>
            <span className="window-resize-affordance" aria-hidden="true" />
          </VerbHint>
        ),
      }}
    >
      <VerbHint verb="window_focus" arg={`PID ${process.pid}`}>
        <article className="window-surface" aria-label={`${app.name} window, PID ${process.pid}`}>
          <header
            className="window-titlebar"
            onContextMenu={(event) => showContextMenu(event, {
              label: `${app.name} window`,
              items: [
                { label: "Minimize", onSelect: minimizeWindow },
                { type: "separator" },
                {
                  label: "Close",
                  verb: "app_close",
                  arg: `PID ${process.pid}`,
                  onSelect: closeWindow,
                },
              ],
            })}
          >
            <span className="window-controls">
              <VerbHint verb="app_close" arg={`PID ${process.pid}`}>
                <button
                  className="window-control window-control--close"
                  type="button"
                  aria-label={`Close ${app.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    closeWindow();
                  }}
                />
              </VerbHint>
              <button
                className="window-control window-control--minimize"
                type="button"
                aria-label={`Minimize ${app.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  minimizeWindow();
                }}
              />
              <span className="window-control window-control--inert" aria-hidden="true" />
            </span>
            <VerbHint verb="window_move" arg={`PID ${process.pid}`}>
              <span className="window-title">
                {title}
              </span>
            </VerbHint>
            <span className="window-pid mono">PID {process.pid}</span>
          </header>
          <div className="window-body">
            <Suspense
              fallback={<div className="app-loading mono" role="status">Opening {app.name}…</div>}
            >
              <AppBody process={process} />
            </Suspense>
          </div>
        </article>
      </VerbHint>
    </Rnd>
  );
});
