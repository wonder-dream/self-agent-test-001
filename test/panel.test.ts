import assert from "node:assert/strict";
import test from "node:test";
import { Explorer } from "../src/loop.ts";
import { zeroUsage } from "../src/model.ts";
import { startPanel } from "../src/panel.ts";
import { deps, scripted, tempDb } from "./support.ts";

test("the panel starts and stops exploration, edits persona, and rejects a foreign origin", async () => {
  const { store, budget, dir } = tempDb();
  const model = scripted(() => ({ content: "我听到了。", toolCalls: [], usage: zeroUsage() }));
  const explorer = new Explorer(deps({ store, budget, model }));
  const panel = await startPanel({
    store,
    budget,
    explorer,
    now: () => new Date("2026-10-26T02:00:00.000Z"),
    logFile: `${dir}/agent.jsonl`,
    host: "127.0.0.1",
    port: 0,
  });

  const home = await fetch(panel.url);
  assert.match(await home.text(), /未出发/);

  const started = await fetch(`${panel.url}/exploration`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "action=start",
    redirect: "manual",
  });
  assert.equal(started.status, 303);
  assert.equal(store.state().exploration, "running");

  const blocked = await fetch(`${panel.url}/persona`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "http://evil.test",
    },
    body: "content=被改写",
  });
  assert.equal(blocked.status, 403);
  assert.equal(store.persona().content.includes("被改写"), false);

  const saved = await fetch(`${panel.url}/persona`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `content=${encodeURIComponent("用户写下的新人格。")}`,
  });
  assert.match(await saved.text(), /用户写下的新人格/);

  store.addChat("user", "在吗", new Date("2026-10-26T02:00:00.000Z"));
  const chat = await fetch(`${panel.url}/chat`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "content=在吗",
  });
  assert.match(await chat.text(), /我听到了/);

  const health = await fetch(`${panel.url}/health`);
  assert.equal((await health.json() as { ok: boolean }).ok, true);
  await panel.close();
  explorer.halt();
  store.close();
});
