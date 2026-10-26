import assert from "node:assert/strict";
import test from "node:test";
import { BudgetExceeded } from "../src/errors.ts";
import { DeepseekModel } from "../src/model.ts";
import { tempDb } from "./support.ts";

test("a completion records cache and output tokens, and refuses a call that would cross the cap", async () => {
  const { store, budget } = tempDb();
  const at = new Date("2026-10-26T05:00:00.000Z");
  let calls = 0;
  const model = new DeepseekModel({
    budget,
    apiKey: "secret-key",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-flash",
    now: () => at,
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "好", tool_calls: [] } }],
        usage: { prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 300, completion_tokens: 50 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const result = await model.complete({
    messages: [{ role: "user", content: "你好" }],
    tools: [],
    thinking: "disabled",
    maxOutputTokens: 100,
    category: "chat",
  });
  assert.equal(result.content, "好");
  assert.equal(budget.spent("2026-10-26"), 450n);
  budget.commit({
    at,
    category: "explore",
    model: "deepseek-flash",
    usage: { cacheHit: 0, cacheMiss: 0, output: 9_999_000 },
  });
  await assert.rejects(() => model.complete({
    messages: [{ role: "user", content: "再来" }],
    tools: [],
    thinking: "disabled",
    maxOutputTokens: 2000,
    category: "explore",
  }), BudgetExceeded);
  assert.equal(calls, 1);
  store.close();
});
