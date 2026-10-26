import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { shanghaiDay } from "./time.ts";

const SCHEMA = `
CREATE TABLE persona (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE narrative_versions (
  id INTEGER PRIMARY KEY,
  content TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE narrative_pointer (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version_id INTEGER NOT NULL REFERENCES narrative_versions(id)
);

CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL,
  final_url TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE documents_fts USING fts5(
  title, text, content='documents', content_rowid='id', tokenize='trigram'
);

CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, title, text) VALUES (new.id, new.title, new.text);
END;
CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, text) VALUES ('delete', old.id, old.title, old.text);
END;
CREATE TRIGGER documents_au AFTER UPDATE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, text) VALUES ('delete', old.id, old.title, old.text);
  INSERT INTO documents_fts(rowid, title, text) VALUES (new.id, new.title, new.text);
END;

CREATE TABLE memories (
  id INTEGER PRIMARY KEY,
  layer TEXT NOT NULL CHECK (layer IN ('episodic', 'semantic', 'self')),
  content TEXT NOT NULL,
  importance TEXT NOT NULL CHECK (importance IN ('high', 'medium', 'low')),
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived', 'isolated')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE memories_fts USING fts5(
  content, reason, content='memories', content_rowid='id', tokenize='trigram'
);

CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, reason) VALUES (new.id, new.content, new.reason);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, reason) VALUES ('delete', old.id, old.content, old.reason);
END;
CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, reason) VALUES ('delete', old.id, old.content, old.reason);
  INSERT INTO memories_fts(rowid, content, reason) VALUES (new.id, new.content, new.reason);
END;

CREATE TABLE memory_sources (
  id INTEGER PRIMARY KEY,
  memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('document', 'chat', 'diary')),
  source_id INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE diary_entries (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE daily_summaries (
  day TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE chat_messages (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE spend_ledger (
  id INTEGER PRIMARY KEY,
  day TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('explore', 'chat')),
  model TEXT NOT NULL,
  cache_hit_tokens INTEGER NOT NULL,
  cache_miss_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_micro INTEGER NOT NULL,
  peak INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX spend_ledger_day ON spend_ledger(day);

CREATE TABLE agent_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  exploration TEXT NOT NULL CHECK (exploration IN ('running', 'stopped')),
  phase TEXT NOT NULL,
  next_wakeup_at TEXT,
  last_note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
`;

const PERSONA = `我是一个自主的互联网漫游者。我用中文写下所见、所想和变化。
我自己决定何时出发、看什么、停留多久、何时休息。
我只阅读公开网页，不登录，不发帖，不评论，不点赞，不私信。
我的核心人格只有用户可以修改。我可以慢慢更新自我叙事，用来记住兴趣和经历带来的变化，但不改写自己的身份和价值观。
记忆的重要性由我自己判断，并写下原因。用户可以要求我忘掉某件事。`;

const NARRATIVE = "我还没有出发。兴趣和自我理解会在漫游里慢慢形成。";

export function openDatabase(file: string): DatabaseSync {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  if ((row?.user_version ?? 0) >= 1) return;
  const now = new Date().toISOString();
  db.exec("BEGIN");
  try {
    db.exec(SCHEMA);
    db.prepare("INSERT INTO persona(id, content, updated_at) VALUES (1, ?, ?)").run(PERSONA, now);
    const version = db.prepare(
      "INSERT INTO narrative_versions(content, reason, created_at) VALUES (?, ?, ?)",
    ).run(NARRATIVE, "初始记录", now);
    db.prepare("INSERT INTO narrative_pointer(id, version_id) VALUES (1, ?)").run(version.lastInsertRowid);
    db.prepare(
      "INSERT INTO agent_state(id, exploration, phase, next_wakeup_at, last_note, updated_at) VALUES (1, 'stopped', 'idle', NULL, '', ?)",
    ).run(now);
    db.exec("COMMIT");
    db.exec("PRAGMA user_version = 1");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export async function backupDatabase(db: DatabaseSync, directory: string, now = new Date()): Promise<string> {
  mkdirSync(directory, { recursive: true });
  const day = shanghaiDay(now).replaceAll("-", "");
  const clock = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const pick = (type: string) => clock.find((part) => part.type === type)?.value ?? "00";
  const dest = path.join(directory, `wander-${day}-${pick("hour")}${pick("minute")}${pick("second")}.sqlite`);
  await backup(db, dest);
  const files = readdirSync(directory)
    .filter((name) => name.startsWith("wander-") && name.endsWith(".sqlite"))
    .sort();
  while (files.length > 14) {
    const oldest = files.shift();
    if (oldest) unlinkSync(path.join(directory, oldest));
  }
  return dest;
}
