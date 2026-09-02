import { useEffect, useState } from "react";
import {
  ACTIVITY_SUMMARY_MAX_CHARS,
  formatEventSummary,
} from "../../desktop/verbPresentation";
import { useKernelStore } from "../../kernel/store";
import type { OSEvent } from "../../kernel/types";

export function relativeEventAge(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 2) return "now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

export function humanizeEvent(event: OSEvent, now: number): string {
  const prefix = `[${event.source}] `;
  const age = ` · ${relativeEventAge(event.ts, now)}`;
  const eventBudget = ACTIVITY_SUMMARY_MAX_CHARS - prefix.length - age.length;
  return `${prefix}${formatEventSummary(event, eventBudget)}${age}`;
}

export function ActivityLog() {
  const events = useKernelStore((state) => state.events);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const latest = events.slice(-50).reverse();
  return (
    <section className="activity-log" aria-label="Activity">
      <span className="micro">ACTIVITY — LAST 50 EVENTS</span>
      {latest.length === 0 ? <p className="activity-log__empty mono">NO ACTIVITY YET</p> : (
        <ol>
          {latest.map((event, index) => (
            <li className="mono" key={`${event.ts}-${event.verb}-${index}`}>
              {humanizeEvent(event, now)}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
