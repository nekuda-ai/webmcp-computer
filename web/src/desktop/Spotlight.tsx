import { useEffect, useRef, useState } from "react";
import {
  actOnSearchResult,
  searchOSDetailed,
  type OSSearchResult,
} from "../kernel/osSearch";
import { watchSpotlightPresentations } from "../kernel/spotlightPresentation";
import { contextMenuMachine } from "./ContextMenu";
import { formatVerbCall } from "./verbPresentation";

const AGENT_PRESENTATION_MS = 3_000;

export function Spotlight() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<OSSearchResult[]>([]);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [mode, setMode] = useState<"human" | "agent">("human");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.repeat || event.key.toLowerCase() !== "k" || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      contextMenuMachine.dismiss("activation");
      setMode("human");
      setOpen((current) => !current);
    };
    window.addEventListener("keydown", shortcut, { capture: true });
    return () => window.removeEventListener("keydown", shortcut, { capture: true });
  }, []);

  useEffect(() => {
    if (!open || mode !== "human") return;
    inputRef.current?.focus();
  }, [mode, open]);

  useEffect(() => watchSpotlightPresentations((presentation) => {
    contextMenuMachine.dismiss("activation");
    setMode("agent");
    setQuery(presentation.query);
    setResults(presentation.results);
    setWarning(
      presentation.warnings.length === 0 ? "" : "Some locations could not be searched.",
    );
    setError("");
    setSelected(0);
    setOpen(true);
  }), []);

  useEffect(() => {
    if (!open || mode !== "agent") return;
    const close = () => {
      setOpen(false);
      setQuery("");
      setResults([]);
      setWarning("");
    };
    const timer = window.setTimeout(close, AGENT_PRESENTATION_MS);
    window.addEventListener("keydown", close, { capture: true });
    window.addEventListener("click", close, { capture: true });
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", close, { capture: true });
      window.removeEventListener("click", close, { capture: true });
    };
  }, [mode, open]);

  useEffect(() => {
    let active = true;
    if (mode === "agent") return () => { active = false; };
    setSelected(0);
    setError("");
    setWarning("");
    if (query.trim() === "") {
      setResults([]);
      return () => { active = false; };
    }
    const timer = window.setTimeout(() => {
      void searchOSDetailed(query).then(
        (next) => {
          if (!active) return;
          setResults(next.results);
          setWarning(next.warnings.length === 0 ? "" : "Some locations could not be searched.");
        },
        (caught: unknown) => {
          if (!active) return;
          setResults([]);
          setError(caught instanceof Error ? caught.message : String(caught));
        },
      );
    }, 80);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [mode, query]);

  if (!open) return null;

  const act = (result: OSSearchResult | undefined) => {
    if (!result) return;
    void actOnSearchResult(result).catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : String(caught));
    });
    setOpen(false);
    setQuery("");
  };

  return (
    <div className="spotlight-backdrop" role="presentation" onMouseDown={() => setOpen(false)}>
      <section
        className="spotlight"
        role="dialog"
        aria-modal={mode === "human"}
        aria-label="Spotlight"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="spotlight__search">
          <span aria-hidden="true">⌕</span>
          <input
            ref={inputRef}
            value={query}
            aria-label="Search WebMCP Computer"
            placeholder="Search files, apps, settings, processes, commands"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setOpen(false);
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSelected((current) => Math.min(results.length - 1, current + 1));
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setSelected((current) => Math.max(0, current - 1));
              }
              if (event.key === "Enter") act(results[selected]);
            }}
          />
          <kbd className="mono">⌘K</kbd>
        </div>
        <div className="spotlight__results" role="listbox">
          {results.map((result, index) => {
            return (
              <button
                  key={result.id}
                  type="button"
                  role="option"
                  aria-selected={index === selected}
                  className={`spotlight__result${index === selected ? " is-selected" : ""}`}
                  onPointerMove={() => setSelected(index)}
                  onClick={() => { if (mode === "human") act(result); }}
                >
                  <span className={`spotlight__kind is-${result.kind}`} aria-hidden="true" />
                  <span className="spotlight__copy">
                    <strong>{result.name}</strong>
                    <span>{result.detail}</span>
                  </span>
                  <span className="spotlight__verb mono">
                    {formatVerbCall(result.verb, result.args)}
                  </span>
              </button>
            );
          })}
          {query.trim() !== "" && results.length === 0 && error === "" ? (
            <p className="spotlight__empty micro">NO RESULTS</p>
          ) : null}
          {error === "" ? null : <p className="spotlight__error mono">{error}</p>}
          {warning === "" ? null : <p className="spotlight__error mono">{warning}</p>}
        </div>
      </section>
    </div>
  );
}
