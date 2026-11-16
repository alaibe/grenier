import type { Source, Store } from "@grenier/store";
import { pullSource } from "./pull.ts";
import { applyPull } from "./source.ts";

export interface SourceSync {
  name: string;
  added: number;
  removed: number;
  error?: string;
}

/** Pulls one source and applies what changed; null for the memory source, which has nothing to pull. */
export async function syncSource(store: Store, source: Source): Promise<{ added: number; removed: number } | null> {
  const pulling = pullSource(source);
  if (!pulling) return null;
  return applyPull(store, source, await pulling);
}

/** Pulls every source (or the one named) in turn; one that fails is reported and does not stop the others. */
export async function syncSources(store: Store, log: (line: string) => void, only?: string): Promise<SourceSync[]> {
  const results: SourceSync[] = [];
  for (const source of await store.sources.list()) {
    if (only && source.name !== only) continue;
    try {
      const result = await syncSource(store, source);
      if (result) results.push({ name: source.name, ...result });
    } catch (error) {
      const message = (error as Error).message;
      log(`grenier: could not sync ${source.name}: ${message}`);
      results.push({ name: source.name, added: 0, removed: 0, error: message });
    }
  }
  return results;
}
