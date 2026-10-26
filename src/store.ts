import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.ts";
import { StoreError } from "./errors.ts";

export type MemoryLayer = "episodic" | "semantic" | "self";
export type Importance = "high" | "medium" | "low";
export type MemoryStatus = "active" | "archived" | "isolated";
export type SourceType = "document" | "chat" | "diary";

export type Memory = {
  id: number;
  layer: MemoryLayer;
  content: string;
  importance: Importance;
  reason: string;
  status: MemoryStatus;
  createdAt: string;
  updatedAt: string;
};

export type SourceRef = { type: SourceType; id: number; note?: string };

export type AgentState = {
  exploration: "running" | "stopped";
  phase: string;
  nextWakeupAt: string | null;
  lastNote: string;
  updatedAt: string;
};

type Row = Record<string, unknown>;

export class Store {
  db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  close(): void {
    this.db.close();
  }

  persona(): { content: string; updatedAt: string } {
    const row = one(this.db, "SELECT content, updated_at AS updatedAt FROM persona WHERE id = 1");
    return { content: String(row.content), updatedAt: String(row.updatedAt) };
  }

  updatePersona(content: string, now: Date): void {
    const text = required(content, "人格不能为空");
    this.db.prepare("UPDATE persona SET content = ?, updated_at = ? WHERE id = 1").run(text, now.toISOString());
  }

  narrative(): { versionId: number; content: string; reason: string; createdAt: string } {
    const row = one(this.db, `
      SELECT v.id AS versionId, v.content, v.reason, v.created_at AS createdAt
      FROM narrative_pointer p JOIN narrative_versions v ON v.id = p.version_id WHERE p.id = 1
    `);
    return {
      versionId: Number(row.versionId),
      content: String(row.content),
      reason: String(row.reason),
      createdAt: String(row.createdAt),
    };
  }

  narrativeVersions(): Array<{ id: number; content: string; reason: string; createdAt: string; current: boolean }> {
    const current = this.narrative().versionId;
    return this.db.prepare(`
      SELECT id, content, reason, created_at AS createdAt FROM narrative_versions ORDER BY id DESC
    `).all().map((row) => {
      const item = row as Row;
      const id = Number(item.id);
      return {
        id,
        content: String(item.content),
        reason: String(item.reason),
        createdAt: String(item.createdAt),
        current: id === current,
      };
    });
  }

  updateNarrative(content: string, reason: string, now: Date): number {
    const text = required(content, "自我叙事不能为空");
    const why = required(reason, "需要写下修改原因");
    const info = this.db.prepare(
      "INSERT INTO narrative_versions(content, reason, created_at) VALUES (?, ?, ?)",
    ).run(text, why, now.toISOString());
    const id = Number(info.lastInsertRowid);
    this.db.prepare("UPDATE narrative_pointer SET version_id = ? WHERE id = 1").run(id);
    return id;
  }

  rollbackNarrative(versionId: number): void {
    const found = this.db.prepare("SELECT id FROM narrative_versions WHERE id = ?").get(versionId);
    if (!found) throw new StoreError("没有这个叙事版本");
    this.db.prepare("UPDATE narrative_pointer SET version_id = ? WHERE id = 1").run(versionId);
  }

  addDocument(input: { url: string; finalUrl: string; title: string; kind: string; text: string; now: Date }): number {
    const info = this.db.prepare(`
      INSERT INTO documents(url, final_url, title, kind, text, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
    `).run(input.url, input.finalUrl, input.title || input.finalUrl, input.kind, input.text, input.now.toISOString());
    return Number(info.lastInsertRowid);
  }

  searchDocuments(query: string, limit: number): Array<{ id: number; url: string; title: string; preview: string }> {
    const match = ftsQuery(query);
    if (!match) return [];
    return this.db.prepare(`
      SELECT d.id, d.final_url AS url, d.title, substr(d.text, 1, 240) AS preview
      FROM documents d JOIN documents_fts ON documents_fts.rowid = d.id
      WHERE documents_fts MATCH ? LIMIT ?
    `).all(match, limit).map((row) => {
      const item = row as Row;
      return { id: Number(item.id), url: String(item.url), title: String(item.title), preview: String(item.preview) };
    });
  }

  addMemory(input: {
    layer: MemoryLayer;
    content: string;
    importance: Importance;
    reason: string;
    sources: SourceRef[];
    now: Date;
  }): number {
    const content = required(input.content, "记忆内容不能为空");
    const reason = required(input.reason, "需要写下形成原因");
    if (input.sources.length === 0) throw new StoreError("记忆需要来源");
    for (const source of input.sources) this.assertSource(source);
    const now = input.now.toISOString();
    this.db.exec("BEGIN");
    try {
      const info = this.db.prepare(`
        INSERT INTO memories(layer, content, importance, reason, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'active', ?, ?)
      `).run(input.layer, content, input.importance, reason, now, now);
      const id = Number(info.lastInsertRowid);
      const insert = this.db.prepare(
        "INSERT INTO memory_sources(memory_id, source_type, source_id, note) VALUES (?, ?, ?, ?)",
      );
      for (const source of input.sources) insert.run(id, source.type, source.id, source.note ?? "");
      this.db.exec("COMMIT");
      return id;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  archiveMemory(id: number, now: Date): void {
    const memory = this.memory(id);
    if (!memory) throw new StoreError("没有这条记忆");
    if (memory.status !== "active") throw new StoreError("只有活跃记忆可以归档");
    this.db.prepare("UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ?").run(now.toISOString(), id);
  }

  isolateMemory(id: number, now: Date): void {
    if (!this.memory(id)) throw new StoreError("没有这条记忆");
    this.db.prepare("UPDATE memories SET status = 'isolated', updated_at = ? WHERE id = ?").run(now.toISOString(), id);
  }

  deleteMemory(id: number): void {
    const info = this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
    if (info.changes === 0) throw new StoreError("没有这条记忆");
  }

  memory(id: number): Memory | null {
    const row = this.db.prepare(`
      SELECT id, layer, content, importance, reason, status, created_at AS createdAt, updated_at AS updatedAt
      FROM memories WHERE id = ?
    `).get(id) as Row | undefined;
    return row ? asMemory(row) : null;
  }

  activeMemories(): Memory[] {
    return this.db.prepare(`
      SELECT id, layer, content, importance, reason, status, created_at AS createdAt, updated_at AS updatedAt
      FROM memories WHERE status = 'active'
      ORDER BY CASE importance WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, id DESC
    `).all().map((row) => asMemory(row as Row));
  }

  selectActiveMemories(charBudget: number): { picked: Memory[]; omitted: number } {
    const all = this.activeMemories();
    const picked: Memory[] = [];
    let used = 0;
    for (const memory of all) {
      const piece = memory.content.slice(0, 500);
      if (picked.length > 0 && used + piece.length > charBudget) break;
      picked.push({ ...memory, content: piece });
      used += piece.length;
    }
    return { picked, omitted: all.length - picked.length };
  }

  allMemories(): Memory[] {
    return this.db.prepare(`
      SELECT id, layer, content, importance, reason, status, created_at AS createdAt, updated_at AS updatedAt
      FROM memories ORDER BY id DESC
    `).all().map((row) => asMemory(row as Row));
  }

  searchArchivedMemories(query: string, limit: number): Memory[] {
    const match = ftsQuery(query);
    if (!match) return [];
    return this.db.prepare(`
      SELECT m.id, m.layer, m.content, m.importance, m.reason, m.status,
             m.created_at AS createdAt, m.updated_at AS updatedAt
      FROM memories m JOIN memories_fts ON memories_fts.rowid = m.id
      WHERE memories_fts MATCH ? AND m.status = 'archived'
      LIMIT ?
    `).all(match, limit).map((row) => asMemory(row as Row));
  }

  memorySources(memoryId: number): Array<{ type: SourceType; id: number; label: string }> {
    const rows = this.db.prepare(
      "SELECT source_type AS type, source_id AS id FROM memory_sources WHERE memory_id = ? ORDER BY id",
    ).all(memoryId) as Array<{ type: SourceType; id: number }>;
    return rows.map((source) => ({ ...source, label: this.sourceLabel(source.type, source.id) }));
  }

  addDiary(title: string, body: string, now: Date): number {
    const info = this.db.prepare(
      "INSERT INTO diary_entries(title, body, created_at) VALUES (?, ?, ?)",
    ).run(required(title, "日记需要标题"), required(body, "日记需要正文"), now.toISOString());
    return Number(info.lastInsertRowid);
  }

  diaries(limit = 30): Array<{ id: number; title: string; body: string; createdAt: string }> {
    return this.db.prepare(`
      SELECT id, title, body, created_at AS createdAt FROM diary_entries ORDER BY id DESC LIMIT ?
    `).all(limit) as Array<{ id: number; title: string; body: string; createdAt: string }>;
  }

  summary(day: string): string | null {
    const row = this.db.prepare("SELECT body FROM daily_summaries WHERE day = ?").get(day) as { body: string } | undefined;
    return row?.body ?? null;
  }

  writeSummary(day: string, body: string, now: Date): void {
    this.db.prepare(`
      INSERT INTO daily_summaries(day, body, created_at) VALUES (?, ?, ?)
      ON CONFLICT(day) DO UPDATE SET body = excluded.body, created_at = excluded.created_at
    `).run(day, required(body, "摘要不能为空"), now.toISOString());
  }

  summaries(limit = 14): Array<{ day: string; body: string; createdAt: string }> {
    return this.db.prepare(`
      SELECT day, body, created_at AS createdAt FROM daily_summaries ORDER BY day DESC LIMIT ?
    `).all(limit) as Array<{ day: string; body: string; createdAt: string }>;
  }

  addChat(role: "user" | "assistant", content: string, now: Date): number {
    const info = this.db.prepare(
      "INSERT INTO chat_messages(role, content, created_at) VALUES (?, ?, ?)",
    ).run(role, required(content, "消息不能为空"), now.toISOString());
    return Number(info.lastInsertRowid);
  }

  recentChat(limit = 30): Array<{ id: number; role: "user" | "assistant"; content: string; createdAt: string }> {
    const rows = this.db.prepare(`
      SELECT id, role, content, created_at AS createdAt FROM chat_messages ORDER BY id DESC LIMIT ?
    `).all(limit) as Array<{ id: number; role: "user" | "assistant"; content: string; createdAt: string }>;
    return rows.reverse();
  }

  state(): AgentState {
    const row = one(this.db, `
      SELECT exploration, phase, next_wakeup_at AS nextWakeupAt, last_note AS lastNote, updated_at AS updatedAt
      FROM agent_state WHERE id = 1
    `);
    return {
      exploration: row.exploration === "running" ? "running" : "stopped",
      phase: String(row.phase),
      nextWakeupAt: row.nextWakeupAt == null ? null : String(row.nextWakeupAt),
      lastNote: String(row.lastNote),
      updatedAt: String(row.updatedAt),
    };
  }

  setState(patch: Partial<AgentState> & { updatedAt?: string }, now = new Date()): void {
    const current = this.state();
    const next = { ...current, ...patch };
    this.db.prepare(`
      UPDATE agent_state
      SET exploration = ?, phase = ?, next_wakeup_at = ?, last_note = ?, updated_at = ?
      WHERE id = 1
    `).run(
      next.exploration,
      next.phase,
      next.nextWakeupAt,
      next.lastNote,
      patch.updatedAt ?? now.toISOString(),
    );
  }

  private assertSource(source: SourceRef): void {
    const table = source.type === "document" ? "documents" : source.type === "chat" ? "chat_messages" : "diary_entries";
    const found = this.db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(source.id);
    if (!found) throw new StoreError("来源不存在");
  }

  private sourceLabel(type: SourceType, id: number): string {
    if (type === "document") {
      const row = this.db.prepare("SELECT final_url AS url, title FROM documents WHERE id = ?").get(id) as
        | { url: string; title: string }
        | undefined;
      return row ? `${row.title} ${row.url}` : `文档 #${id}`;
    }
    if (type === "chat") {
      const row = this.db.prepare("SELECT content FROM chat_messages WHERE id = ?").get(id) as { content: string } | undefined;
      return row ? `对话：${row.content.slice(0, 80)}` : `对话 #${id}`;
    }
    const row = this.db.prepare("SELECT title FROM diary_entries WHERE id = ?").get(id) as { title: string } | undefined;
    return row ? `日记：${row.title}` : `日记 #${id}`;
  }
}

export function openStore(file: string): Store {
  return new Store(openDatabase(file));
}

function one(db: DatabaseSync, sql: string): Row {
  const row = db.prepare(sql).get() as Row | undefined;
  if (!row) throw new StoreError("记录不存在");
  return row;
}

function required(value: string, message: string): string {
  const text = value.trim();
  if (!text) throw new StoreError(message);
  if (text.length > 20_000) throw new StoreError("内容过长");
  return text;
}

function asMemory(row: Row): Memory {
  return {
    id: Number(row.id),
    layer: row.layer as MemoryLayer,
    content: String(row.content),
    importance: row.importance as Importance,
    reason: String(row.reason),
    status: row.status as MemoryStatus,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

export function ftsQuery(input: string): string | null {
  const query = input.replace(/["*]/g, " ").replace(/\s+/g, " ").trim();
  if (Array.from(query).length < 3) return null;
  return `"${query}"`;
}
