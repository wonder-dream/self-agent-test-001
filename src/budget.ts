import type { DatabaseSync } from "node:sqlite";
import { decimalToMicro } from "./money.ts";
import type { PriceCard, TokenUse } from "./pricing.ts";
import { isPeak, quoteMicro } from "./pricing.ts";
import { shanghaiDay } from "./time.ts";

export type SpendCategory = "explore" | "chat";

export class Budget {
  private db: DatabaseSync;
  card: PriceCard;
  private limitMicro: bigint;

  constructor(db: DatabaseSync, card: PriceCard, limitMicro: bigint) {
    this.db = db;
    this.card = card;
    this.limitMicro = limitMicro;
  }

  static fromCny(db: DatabaseSync, card: PriceCard, cny: string): Budget {
    return new Budget(db, card, decimalToMicro(cny));
  }

  spent(day: string): bigint {
    const row = this.db.prepare(
      "SELECT COALESCE(SUM(cost_micro), 0) AS spent FROM spend_ledger WHERE day = ?",
    ).get(day) as { spent: number | bigint };
    return BigInt(row.spent);
  }

  snapshot(at: Date): { day: string; spent: bigint; remaining: bigint; peak: boolean; limit: bigint } {
    const day = shanghaiDay(at);
    const spent = this.spent(day);
    const remaining = this.limitMicro > spent ? this.limitMicro - spent : 0n;
    return { day, spent, remaining, peak: isPeak(this.card, at), limit: this.limitMicro };
  }

  authorize(usage: TokenUse, at: Date):
    | { ok: true; cost: bigint; day: string }
    | { ok: false; cost: bigint; day: string; remaining: bigint } {
    const cost = quoteMicro(this.card, usage, at);
    const snap = this.snapshot(at);
    if (cost > snap.remaining) return { ok: false, cost, day: snap.day, remaining: snap.remaining };
    return { ok: true, cost, day: snap.day };
  }

  commit(entry: { at: Date; category: SpendCategory; model: string; usage: TokenUse }): bigint {
    const cost = quoteMicro(this.card, entry.usage, entry.at);
    this.db.prepare(`
      INSERT INTO spend_ledger(
        day, category, model, cache_hit_tokens, cache_miss_tokens, output_tokens, cost_micro, peak, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      shanghaiDay(entry.at),
      entry.category,
      entry.model,
      entry.usage.cacheHit,
      entry.usage.cacheMiss,
      entry.usage.output,
      Number(cost),
      isPeak(this.card, entry.at) ? 1 : 0,
      entry.at.toISOString(),
    );
    return cost;
  }

  recent(limit = 10): Array<{
    day: string;
    category: string;
    costMicro: number;
    peak: number;
    createdAt: string;
  }> {
    return this.db.prepare(`
      SELECT day, category, cost_micro AS costMicro, peak, created_at AS createdAt
      FROM spend_ledger ORDER BY id DESC LIMIT ?
    `).all(limit) as Array<{ day: string; category: string; costMicro: number; peak: number; createdAt: string }>;
  }
}
