import type { OSSearchResult } from "./osSearch";

export type SpotlightPresentation = {
  query: string;
  results: OSSearchResult[];
  warnings: string[];
};

type SpotlightPresentationListener = (presentation: SpotlightPresentation) => void;

const listeners = new Set<SpotlightPresentationListener>();

export function presentSpotlight(presentation: SpotlightPresentation): void {
  for (const listener of listeners) listener(presentation);
}

export function watchSpotlightPresentations(listener: SpotlightPresentationListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
