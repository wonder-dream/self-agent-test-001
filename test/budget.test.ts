import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { decimalToMicro, formatCny, tokenCostMicro } from "../src/money.ts";
import { loadPriceCardFile, quoteMicro } from "../src/pricing.ts";
import { nextShanghaiMidnight, shanghaiDay } from "../src/time.ts";
import { tempDb, testCard } from "./support.ts";

test("money rounds token cost up", () => {
  assert.equal(decimalToMicro("10"), 10_000_000n);
  assert.equal(decimalToMicro("0.03"), 30_000n);
  assert.equal(tokenCostMicro(1, "1", 1n), 1n);
  assert.equal(formatCny(10_000_000n), "10.0000 元");
});

test("shanghai day changes at midnight and peak follows weekday windows", () => {
  assert.equal(shanghaiDay(new Date("2026-10-26T15:59:00.000Z")), "2026-10-26");
  assert.equal(shanghaiDay(new Date("2026-10-26T16:00:00.000Z")), "2026-10-27");
  assert.equal(nextShanghaiMidnight(new Date("2026-10-26T15:59:00.000Z")).toISOString(), "2026-10-26T16:00:00.000Z");
  const mondayMorning = new Date("2026-10-26T01:00:00.000Z");
  const mondayNoon = new Date("2026-10-26T04:00:00.000Z");
  const saturday = new Date("2026-10-24T02:00:00.000Z");
  assert.equal(quoteMicro(testCard, { cacheHit: 0, cacheMiss: 0, output: 1_000_000 }, mondayMorning), 2_000_000n);
  assert.equal(quoteMicro(testCard, { cacheHit: 0, cacheMiss: 0, output: 1_000_000 }, mondayNoon), 1_000_000n);
  assert.equal(quoteMicro(testCard, { cacheHit: 0, cacheMiss: 0, output: 1_000_000 }, saturday), 1_000_000n);
});

test("chat and exploration share the daily ledger and the day refreshes at midnight", () => {
  const { store, budget } = tempDb();
  const during = new Date("2026-10-26T05:00:00.000Z");
  budget.commit({
    at: during,
    category: "explore",
    model: "deepseek-flash",
    usage: { cacheHit: 0, cacheMiss: 0, output: 9_500_000 },
  });
  assert.equal(budget.authorize({ cacheHit: 0, cacheMiss: 0, output: 600_000 }, during).ok, false);
  assert.equal(budget.authorize({ cacheHit: 0, cacheMiss: 0, output: 400_000 }, during).ok, true);
  const nextDay = new Date("2026-10-26T16:00:00.000Z");
  assert.equal(budget.snapshot(nextDay).remaining, 10_000_000n);
  store.close();
});

test("the shipped price card parses", () => {
  const card = loadPriceCardFile("config/pricing.json");
  assert.equal(card.peakMultiplier, 2);
  assert.equal(card.offPeakCnyPerMillion.output, "4.40");
  assert.ok(readFileSync("config/pricing.json", "utf8").includes("deepseek"));
});
