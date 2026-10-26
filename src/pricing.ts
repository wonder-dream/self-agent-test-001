import { readFileSync } from "node:fs";
import { tokenCostMicro } from "./money.ts";
import { shanghaiParts } from "./time.ts";

export type TokenUse = {
  cacheHit: number;
  cacheMiss: number;
  output: number;
};

export type PriceCard = {
  timezone: "Asia/Shanghai";
  peakMultiplier: number;
  weekdays: number[];
  windows: Array<[number, number]>;
  offPeakCnyPerMillion: {
    cacheHit: string;
    cacheMiss: string;
    output: string;
  };
};

export function loadPriceCard(json: unknown): PriceCard {
  if (!json || typeof json !== "object") throw new Error("价格表不是对象");
  const card = json as Partial<PriceCard>;
  const rates = card.offPeakCnyPerMillion;
  if (!rates?.cacheHit || !rates.cacheMiss || !rates.output) {
    throw new Error("价格表缺少单价");
  }
  const peakMultiplier = card.peakMultiplier;
  if (peakMultiplier === undefined || !Number.isInteger(peakMultiplier) || peakMultiplier < 1) {
    throw new Error("高峰倍率无效");
  }
  if (!Array.isArray(card.weekdays) || !Array.isArray(card.windows)) {
    throw new Error("价格表缺少高峰时段");
  }
  const windows = card.windows.map((window) => {
    if (!Array.isArray(window) || window.length !== 2) throw new Error("高峰时段无效");
    const [start, end] = window;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 24 || start >= end) {
      throw new Error("高峰时段无效");
    }
    return [start, end] as [number, number];
  });
  return {
    timezone: "Asia/Shanghai",
    peakMultiplier,
    weekdays: card.weekdays.map(Number),
    windows,
    offPeakCnyPerMillion: {
      cacheHit: rates.cacheHit,
      cacheMiss: rates.cacheMiss,
      output: rates.output,
    },
  };
}

export function loadPriceCardFile(file: string): PriceCard {
  return loadPriceCard(JSON.parse(readFileSync(file, "utf8")));
}

export function isPeak(card: PriceCard, at: Date): boolean {
  const parts = shanghaiParts(at);
  if (!card.weekdays.includes(parts.weekday)) return false;
  return card.windows.some(([start, end]) => parts.hour >= start && parts.hour < end);
}

export function quoteMicro(card: PriceCard, usage: TokenUse, at: Date): bigint {
  const multiplier = BigInt(isPeak(card, at) ? card.peakMultiplier : 1);
  const rates = card.offPeakCnyPerMillion;
  return (
    tokenCostMicro(usage.cacheHit, rates.cacheHit, multiplier) +
    tokenCostMicro(usage.cacheMiss, rates.cacheMiss, multiplier) +
    tokenCostMicro(usage.output, rates.output, multiplier)
  );
}
