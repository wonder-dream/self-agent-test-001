import assert from "node:assert/strict";
import test from "node:test";
import { Explorer } from "../src/loop.ts";
import { zeroUsage } from "../src/model.ts";
import type { ModelOutput } from "../src/types.ts";
import { deps, scripted, tempDb } from "./support.ts";

const future = "2026-10-26T12:00:00.000Z";

function tool(name: string, arguments_: Record<string, unknown>, id = name): ModelOutput {
  return { content: "", toolCalls: [{ id, name, arguments: arguments_ }], usage: zeroUsage() };
}

test("an outing browses, writes a diary, and sleeps until the chosen time", async () => {
  const { store, budget } = tempDb();
  const opened: string[] = [];
  const model = scripted((input) => {
    if (input.thinking === "low") return tool("finish_reflection", {}, "reflect");
    if (model.calls === 1) return tool("browse_page", { url: "https://example.com/lighthouse" });
    if (model.calls === 2) return tool("write_diary", { title: "灯塔", body: "白灯亮着。" });
    return tool("sleep_until", { at: future });
  });
  store.setState({ exploration: "running" });
  const explorer = new Explorer(deps({
    store,
    budget,
    model,
    openUrl: async (url) => {
      opened.push(url);
      const documentId = store.addDocument({
        url,
        finalUrl: url,
        title: "灯塔",
        kind: "html",
        text: "灯塔的正文很长。",
        now: new Date("2026-10-26T02:00:00.000Z"),
      });
      return { ok: true, documentId, title: "灯塔", finalUrl: url, excerpt: "灯塔的正文" };
    },
  }));
  const wait = await explorer.stepOnce();
  assert.deepEqual(opened, ["https://example.com/lighthouse"]);
  assert.equal(store.diaries()[0]?.title, "灯塔");
  assert.equal(store.state().nextWakeupAt, future);
  assert.equal(store.state().phase, "sleeping");
  assert.ok(wait > 0);
  store.close();
});

test("the same page is opened at most three times in one outing", async () => {
  const { store, budget } = tempDb();
  const opened: string[] = [];
  let step = 0;
  const model = scripted(() => {
    step += 1;
    if (step < 5) return tool("browse_page", { url: "https://example.com/same" }, `b${step}`);
    return tool("sleep_until", { at: future }, "sleep");
  });
  store.setState({ exploration: "running" });
  const explorer = new Explorer(deps({
    store,
    budget,
    model,
    openUrl: async (url) => {
      opened.push(url);
      return { ok: false, error: "停" };
    },
  }));
  await explorer.stepOnce();
  assert.equal(opened.length, 3);
  store.close();
});

test("without a key or remaining budget the model is not called", async () => {
  const { store, budget } = tempDb();
  const model = scripted(() => {
    throw new Error("不该调用");
  });
  store.setState({ exploration: "running" });
  const sleeping = new Explorer(deps({ store, budget, model, hasApiKey: false }));
  await sleeping.stepOnce();
  assert.equal(store.state().phase, "needs_key");
  assert.equal(model.calls, 0);

  store.setState({ exploration: "running" });
  budget.commit({
    at: new Date("2026-10-26T02:00:00.000Z"),
    category: "explore",
    model: "deepseek-flash",
    usage: { cacheHit: 0, cacheMiss: 0, output: 10_000_000 },
  });
  const held = new Explorer(deps({ store, budget, model }));
  await held.stepOnce();
  assert.equal(store.state().phase, "budget_hold");
  assert.equal(model.calls, 0);
  store.close();
});

test("chat can search the archive and shares the stopped state of the budget", async () => {
  const { store, budget } = tempDb();
  const now = new Date("2026-10-26T02:00:00.000Z");
  store.addDocument({
    url: "https://example.com/old",
    finalUrl: "https://example.com/old",
    title: "旧灯塔",
    kind: "html",
    text: "旧记录里有一座已经熄灭的灯塔。",
    now,
  });
  const model = scripted((input) => {
    if (model.calls === 1) return tool("search_archive", { query: "熄灭的灯塔" });
    return { content: "我翻到了旧记录。", toolCalls: [], usage: zeroUsage() };
  });
  const explorer = new Explorer(deps({ store, budget, model }));
  store.addChat("user", "还记得熄灭的灯塔吗？", now);
  const reply = await explorer.chat("还记得熄灭的灯塔吗？");
  assert.equal(reply, "我翻到了旧记录。");
  budget.commit({
    at: now,
    category: "chat",
    model: "deepseek-flash",
    usage: { cacheHit: 0, cacheMiss: 0, output: 10_000_000 },
  });
  await assert.rejects(() => explorer.chat("再问一句"), /额度/);
  store.close();
});
