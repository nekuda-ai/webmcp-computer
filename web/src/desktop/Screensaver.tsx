import { useEffect, useRef, useState } from "react";
import { useKernelStore } from "../kernel/store";
import { screensaverHueAfterFrame } from "./screensaverMotion";

type Ghost = {
  id: number;
  x: number;
  y: number;
  hue: number;
};

const randomPeriod = (minimumSeconds: number, spanSeconds: number) =>
  (minimumSeconds + Math.random() * spanSeconds) * 1_000;

export function Screensaver() {
  const stageRef = useRef<HTMLDivElement>(null);
  const logoRef = useRef<HTMLDivElement>(null);
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const wakeScreensaver = useKernelStore((state) => state.wakeScreensaver);
  const osEvent = useKernelStore((state) => state.osEvent);
  const fileSystemStatus = useKernelStore((state) => state.fileSystemStatus);
  const fileSystemError = useKernelStore((state) => state.fileSystemError);

  useEffect(() => {
    const stage = stageRef.current;
    const logo = logoRef.current;
    if (!stage || !logo) return undefined;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      logo.style.transform = "translate(calc(50vw - 110px), calc(50vh - 38px))";
      return undefined;
    }

    let frame = 0;
    let lastTime = performance.now();
    let x = 0;
    let y = 0;
    let hue = 0;
    let horizontalPeriod = 12_000;
    let verticalPeriod = 9_000;
    let maxX = Math.max(0, stage.clientWidth - logo.offsetWidth);
    let maxY = Math.max(0, stage.clientHeight - logo.offsetHeight);
    let directionX = 1;
    let directionY = 1;
    let velocityX = maxX / horizontalPeriod;
    let velocityY = maxY / verticalPeriod;
    let lastHorizontalHit = Number.NEGATIVE_INFINITY;
    let lastVerticalHit = Number.NEGATIVE_INFINITY;
    let ghostId = 0;

    const draw = (now: number) => {
      const elapsed = Math.min(50, now - lastTime);
      lastTime = now;
      const nextMaxX = Math.max(0, stage.clientWidth - logo.offsetWidth);
      const nextMaxY = Math.max(0, stage.clientHeight - logo.offsetHeight);

      if (nextMaxX !== maxX) {
        maxX = nextMaxX;
        x = Math.max(0, Math.min(maxX, x));
        velocityX = maxX <= 0 ? 0 : directionX * (maxX / horizontalPeriod);
      }
      if (nextMaxY !== maxY) {
        maxY = nextMaxY;
        y = Math.max(0, Math.min(maxY, y));
        velocityY = maxY <= 0 ? 0 : directionY * (maxY / verticalPeriod);
      }

      let nextX = x + velocityX * elapsed;
      let nextY = y + velocityY * elapsed;
      let hitHorizontal = false;
      let hitVertical = false;

      if (maxX <= 0) {
        nextX = 0;
        velocityX = 0;
      } else if (nextX <= 0 || nextX >= maxX) {
        nextX = Math.max(0, Math.min(maxX, nextX));
        directionX *= -1;
        velocityX = directionX * (maxX / horizontalPeriod);
        hitHorizontal = true;
      }
      if (maxY <= 0) {
        nextY = 0;
        velocityY = 0;
      } else if (nextY <= 0 || nextY >= maxY) {
        nextY = Math.max(0, Math.min(maxY, nextY));
        directionY *= -1;
        velocityY = directionY * (maxY / verticalPeriod);
        hitVertical = true;
      }

      x = nextX;
      y = nextY;

      const wallHit = hitHorizontal || hitVertical;
      const nextHue = screensaverHueAfterFrame(hue, wallHit, wallHit ? Math.random() : 0);

      if (wallHit) {
        setGhosts((current) => [
          ...current.slice(-2),
          { id: ghostId++, x, y, hue },
        ]);
        hue = nextHue;
        logo.style.filter = `hue-rotate(${hue}deg)`;
      }

      const cornerHit =
        (hitHorizontal && (hitVertical || now - lastVerticalHit < 120)) ||
        (hitVertical && now - lastHorizontalHit < 120);

      if (hitHorizontal) lastHorizontalHit = now;
      if (hitVertical) lastVerticalHit = now;

      if (cornerHit) {
        horizontalPeriod = randomPeriod(8, 6);
        verticalPeriod = randomPeriod(7, 5);
        velocityX = maxX <= 0 ? 0 : directionX * (maxX / horizontalPeriod);
        velocityY = maxY <= 0 ? 0 : directionY * (maxY / verticalPeriod);
      }

      logo.style.transform = `translate(${x}px, ${y}px)`;
      frame = requestAnimationFrame(draw);
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  const wake = () => {
    useKernelStore.getState().recordActivity();
    const wasActive = wakeScreensaver();
    if (wasActive) osEvent("human", "screensaver_wake", { via: "pointer" });
  };

  return (
    <div
      ref={stageRef}
      className="screensaver"
      role="button"
      tabIndex={0}
      aria-label="Wake VerbOS"
      onPointerDown={wake}
    >
      <div className="screensaver__pixel-grid" aria-hidden="true" />
      <div className="screensaver__grain" aria-hidden="true" />
      {ghosts.map((ghost) => (
        <span
          key={ghost.id}
          className="screensaver__ghost wordmark"
          style={{
            transform: `translate(${ghost.x + 10}px, ${ghost.y + 10}px)`,
            filter: `hue-rotate(${ghost.hue}deg)`,
          }}
          aria-hidden="true"
        >
          verbOS
        </span>
      ))}
      <div ref={logoRef} className="screensaver__logo">
        <span className="wordmark">verbOS</span>
      </div>
      <span className="screensaver__state mono">
        VERBOS // STATE: IDLE — SCREENSAVER PID 1 — FS: {fileSystemStatus.toUpperCase()}
        {fileSystemStatus === "mounting" ? "…" : ""}
      </span>
      {fileSystemStatus === "failed" ? (
        <span className="screensaver__fs-error mono">FS FAILURE: {fileSystemError}</span>
      ) : null}
      <span className="screensaver__mechanics mono">
        HUE STEPS ON WALL HIT — PERIODS RECALIBRATE AT CORNERS
      </span>
      <span className="screensaver__wake mono">
        <span aria-hidden="true" />
        PRESS ANY KEY — OR CALL ANY TOOL
      </span>
      <div className="screensaver__scanlines" aria-hidden="true" />
      <div className="screensaver__vignette" aria-hidden="true" />
    </div>
  );
}
