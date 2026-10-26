import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { backupDatabase } from "../src/db.ts";
import { StoreError } from "../src/errors.ts";
import { tempDb } from "./support.ts";

const now = new Date("2026-10-26T02:00:00.000Z");

test("persona stays user-owned and narrative can roll back", () => {
  const { store } = tempDb();
  const before = store.persona().content;
  const first = store.narrative().versionId;
  const second = store.updateNarrative("我开始对灯塔感兴趣。", "第一次出门", now);
  assert.equal(store.narrative().versionId, second);
  assert.equal(store.persona().content, before);
  store.rollbackNarrative(first);
  assert.equal(store.narrative().versionId, first);
  store.updatePersona("由用户写下的人格。", now);
  assert.equal(store.persona().content, "由用户写下的人格。");
  store.close();
});

test("active recall skips archived and isolated memories, search can still find the archive", () => {
  const { store } = tempDb();
  const doc = store.addDocument({
    url: "https://example.com/lighthouse",
    finalUrl: "https://example.com/lighthouse",
    title: "海边的灯塔",
    kind: "html",
    text: "今天去看了海边的灯塔，灯是白的。",
    now,
  });
  const active = store.addMemory({
    layer: "episodic",
    content: "我在海边看见了白灯塔。",
    importance: "high",
    reason: "这是第一次出门记住的画面",
    sources: [{ type: "document", id: doc }],
    now,
  });
  const fading = store.addMemory({
    layer: "semantic",
    content: "灯塔通常建在危险的海岸。",
    importance: "low",
    reason: "从同一页留下的常识",
    sources: [{ type: "document", id: doc }],
    now,
  });
  store.archiveMemory(fading, now);
  const hidden = store.addMemory({
    layer: "self",
    content: "我想忘掉这次迷路的感受。",
    importance: "medium",
    reason: "用户要求隔离",
    sources: [{ type: "document", id: doc }],
    now,
  });
  store.isolateMemory(hidden, now);
  assert.deepEqual(store.activeMemories().map((memory) => memory.id), [active]);
  assert.equal(store.selectActiveMemories(6000).picked.length, 1);
  const foundDocs = store.searchDocuments("海边的灯塔", 5);
  assert.equal(foundDocs[0]?.id, doc);
  const foundMemories = store.searchArchivedMemories("危险的海岸", 5);
  assert.equal(foundMemories[0]?.id, fading);
  assert.equal(store.searchArchivedMemories("迷路的感受", 5).length, 0);
  store.deleteMemory(hidden);
  assert.equal(store.memory(hidden), null);
  assert.throws(() => store.addMemory({
    layer: "episodic",
    content: "没有来源的记忆",
    importance: "low",
    reason: "不该留下",
    sources: [],
    now,
  }), StoreError);
  store.close();
});

test("backup copies the database and keeps the newest files", async () => {
  const { dir, store } = tempDb();
  store.updatePersona("备份里的人格。", now);
  const file = await backupDatabase(store.db, `${dir}/backups`, now);
  const text = readFileSync(file);
  assert.ok(text.byteLength > 0);
  store.close();
});
