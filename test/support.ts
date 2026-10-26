import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Budget } from "../src/budget.ts";
import { Guard } from "../src/guard.ts";
import { openDatabase } from "../src/db.ts";
import type { ExplorerDeps } from "../src/loop.ts";
import { loadPriceCard, type PriceCard } from "../src/pricing.ts";
import { Store } from "../src/store.ts";
import type { Model, ModelInput, ModelOutput } from "../src/types.ts";

export const testCard: PriceCard = loadPriceCard({
  peakMultiplier: 2,
  weekdays: [1, 2, 3, 4, 5],
  windows: [[9, 12], [14, 18]],
  offPeakCnyPerMillion: { cacheHit: "1", cacheMiss: "1", output: "1" },
});

export function tempDb(): { dir: string; file: string; store: Store; budget: Budget } {
  const dir = mkdtempSync(path.join(tmpdir(), "wander-"));
  const file = path.join(dir, "wander.sqlite");
  const store = new Store(openDatabase(file));
  const budget = Budget.fromCny(store.db, testCard, "10");
  return { dir, file, store, budget };
}

export function scripted(handler: (input: ModelInput) => ModelOutput): Model & { calls: number } {
  const model = {
    calls: 0,
    async complete(input: ModelInput): Promise<ModelOutput> {
      model.calls += 1;
      return handler(input);
    },
  };
  return model;
}

export function deps(partial: Partial<ExplorerDeps> & Pick<ExplorerDeps, "store" | "budget" | "model">): ExplorerDeps {
  return {
    now: () => new Date("2026-10-26T02:00:00.000Z"),
    hasApiKey: true,
    openUrl: async () => ({ ok: false, error: "未实现" }),
    lookImage: async () => ({ ok: false, error: "未实现" }),
    guard: new Guard(async () => ["93.184.216.34"]),
    ...partial,
  };
}
