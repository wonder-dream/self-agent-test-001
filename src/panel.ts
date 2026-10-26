import http from "node:http";
import { BudgetExceeded, NeedKey, StoreError } from "./errors.ts";
import { flash, escapeHtml, page } from "./html.ts";
import { readTail } from "./log.ts";
import type { Explorer } from "./loop.ts";
import { formatCny } from "./money.ts";
import type { Budget } from "./budget.ts";
import type { Store } from "./store.ts";
import { formatShanghai } from "./time.ts";

const PHASES: Record<string, string> = {
  idle: "未出发",
  sleeping: "休息",
  exploring: "漫游中",
  budget_hold: "今日额度已用完",
  needs_key: "等待 API Key",
};

export type PanelDeps = {
  store: Store;
  budget: Budget;
  explorer: Explorer;
  now: () => Date;
  logFile: string;
  host: string;
  port: number;
};

export async function startPanel(deps: PanelDeps): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    void handle(req, res, deps).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "面板出错";
      send(res, 500, "text/plain; charset=utf-8", message);
    });
  });
  await new Promise<void>((resolve) => server.listen(deps.port, deps.host, () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("面板没有监听端口");
  return {
    url: `http://${deps.host}:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, deps: PanelDeps): Promise<void> {
  const url = new URL(req.url ?? "/", "http://panel.local");
  if (req.method === "GET" && url.pathname === "/health") {
    send(res, 200, "application/json", JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === "POST") {
    if (!sameOrigin(req, url)) {
      send(res, 403, "text/plain; charset=utf-8", "拒绝跨站请求");
      return;
    }
    const form = new URLSearchParams(await readBody(req));
    const notice = await post(url.pathname, form, deps);
    redirect(res, url.pathname, notice);
    return;
  }
  if (req.method !== "GET") {
    send(res, 405, "text/plain; charset=utf-8", "不支持的方法");
    return;
  }
  const notice = url.searchParams.get("notice");
  const html = url.pathname === "/diary" ? diaryPage(deps, notice)
    : url.pathname === "/memories" ? memoryPage(deps, notice)
    : url.pathname === "/chat" ? chatPage(deps, notice)
    : url.pathname === "/self" ? selfPage(deps, notice)
    : statusPage(deps, notice);
  send(res, 200, "text/html; charset=utf-8", html);
}

async function post(pathname: string, form: URLSearchParams, deps: PanelDeps): Promise<string> {
  const now = deps.now();
  try {
    if (pathname === "/exploration") {
      if (form.get("action") === "start") deps.explorer.requestStart();
      else deps.explorer.requestStop();
      return form.get("action") === "start" ? "已开始。作息由它自己决定。" : "已停止。";
    }
    if (pathname === "/persona") {
      deps.store.updatePersona(form.get("content") ?? "", now);
      return "核心人格已更新。";
    }
    if (pathname === "/narrative/rollback") {
      deps.store.rollbackNarrative(Number(form.get("version")));
      return "已回到所选的自我叙事。";
    }
    if (pathname === "/memories/forget") {
      const id = Number(form.get("id"));
      if (form.get("mode") === "delete") deps.store.deleteMemory(id);
      else deps.store.isolateMemory(id, now);
      return form.get("mode") === "delete" ? "这条记忆已删除。" : "这条记忆已隔离，不再进入回忆。";
    }
    if (pathname === "/chat") {
      const text = (form.get("content") ?? "").trim();
      if (!text) return "消息是空的。";
      deps.store.addChat("user", text, now);
      try {
        const reply = await deps.explorer.chat(text);
        deps.store.addChat("assistant", reply, deps.now());
        return "";
      } catch (error) {
        if (error instanceof BudgetExceeded) return "今日额度已用完，聊天和漫游都先停下。";
        if (error instanceof NeedKey) return "还没有配置 DeepSeek API Key。";
        throw error;
      }
    }
  } catch (error) {
    if (error instanceof StoreError) return error.message;
    throw error;
  }
  return "没有这个操作。";
}

function statusPage(deps: PanelDeps, notice: string | null): string {
  const now = deps.now();
  const state = deps.store.state();
  const snap = deps.budget.snapshot(now);
  const rows = deps.budget.recent(8).map((row) => (
    `<li>${escapeHtml(formatShanghai(new Date(row.createdAt)))} ${escapeHtml(row.category)} ${escapeHtml(formatCny(BigInt(row.costMicro)))}${row.peak ? " 高峰" : ""}</li>`
  )).join("");
  const wakeup = state.nextWakeupAt ? formatShanghai(new Date(state.nextWakeupAt)) : "没有安排";
  const logs = readTail(deps.logFile).map((line) => escapeHtml(line)).join("\n");
  return page("状态", `
    ${flash(notice)}
    <section class="card">
      <p>探索：${state.exploration === "running" ? "运行" : "停止"}</p>
      <p>阶段：${escapeHtml(PHASES[state.phase] ?? state.phase)}</p>
      <p>下次醒来：${escapeHtml(wakeup)}</p>
      <p class="meta">${escapeHtml(state.lastNote)}</p>
      <form method="post" action="/exploration">
        <button name="action" value="start">开始</button>
        <button name="action" value="stop">停止</button>
      </form>
    </section>
    <section class="card">
      <h2>今日费用</h2>
      <p>${escapeHtml(snap.day)} ${snap.peak ? "高峰" : "低谷"}</p>
      <p>已用 ${escapeHtml(formatCny(snap.spent))}，剩余 ${escapeHtml(formatCny(snap.remaining))}，上限 ${escapeHtml(formatCny(snap.limit))}</p>
      <ul>${rows || "<li>还没有调用</li>"}</ul>
    </section>
    <section class="card">
      <h2>日志</h2>
      <pre>${logs || "还没有日志"}</pre>
    </section>
  `);
}

function diaryPage(deps: PanelDeps, notice: string | null): string {
  const diaries = deps.store.diaries().map((entry) => `
    <article class="card">
      <h2>${escapeHtml(entry.title)}</h2>
      <p class="meta">${escapeHtml(formatShanghai(new Date(entry.createdAt)))}</p>
      <pre>${escapeHtml(entry.body)}</pre>
    </article>
  `).join("");
  const summaries = deps.store.summaries().map((entry) => `
    <article class="card">
      <h2>${escapeHtml(entry.day)}</h2>
      <pre>${escapeHtml(entry.body)}</pre>
    </article>
  `).join("");
  return page("日记", `${flash(notice)}<h2>每日摘要</h2>${summaries || "<p>还没有摘要。</p>"}<h2>漫游日记</h2>${diaries || "<p>还没有日记。</p>"}`);
}

function memoryPage(deps: PanelDeps, notice: string | null): string {
  const cards = deps.store.allMemories().map((memory) => {
    const sources = deps.store.memorySources(memory.id).map((source) => `<li>${escapeHtml(source.label)}</li>`).join("");
    return `
      <article class="card">
        <p>${escapeHtml(memory.layer)} / ${escapeHtml(memory.importance)} / ${escapeHtml(memory.status)}</p>
        <pre>${escapeHtml(memory.content)}</pre>
        <p>原因：${escapeHtml(memory.reason)}</p>
        <ul>${sources}</ul>
        <form method="post" action="/memories/forget">
          <input type="hidden" name="id" value="${memory.id}">
          <button name="mode" value="isolate">隔离</button>
          <button name="mode" value="delete">删除</button>
        </form>
      </article>
    `;
  }).join("");
  return page("记忆", `${flash(notice)}<p class="meta">隔离和删除都不再进入回忆。对应的网页原文仍留在归档里。</p>${cards || "<p>还没有记忆。</p>"}`);
}

function chatPage(deps: PanelDeps, notice: string | null): string {
  const messages = deps.store.recentChat(50).map((message) => `
    <article class="card">
      <p class="meta">${message.role === "user" ? "你" : "漫游者"} · ${escapeHtml(formatShanghai(new Date(message.createdAt)))}</p>
      <pre>${escapeHtml(message.content)}</pre>
    </article>
  `).join("");
  return page("聊天", `
    ${flash(notice)}
    ${messages || "<p>还没有对话。</p>"}
    <form method="post" action="/chat" class="card">
      <textarea name="content" required></textarea>
      <button>发送</button>
    </form>
  `);
}

function selfPage(deps: PanelDeps, notice: string | null): string {
  const persona = deps.store.persona();
  const versions = deps.store.narrativeVersions().map((version) => `
    <article class="card">
      <p class="meta">${version.current ? "当前" : "历史"} · ${escapeHtml(formatShanghai(new Date(version.createdAt)))} · ${escapeHtml(version.reason)}</p>
      <pre>${escapeHtml(version.content)}</pre>
      ${version.current ? "" : `<form method="post" action="/narrative/rollback"><input type="hidden" name="version" value="${version.id}"><button>回到这一版</button></form>`}
    </article>
  `).join("");
  return page("人格", `
    ${flash(notice)}
    <form method="post" action="/persona" class="card">
      <h2>核心人格</h2>
      <p class="meta">只有这里能改。最近更新 ${escapeHtml(formatShanghai(new Date(persona.updatedAt)))}</p>
      <textarea name="content">${escapeHtml(persona.content)}</textarea>
      <button>保存</button>
    </form>
    <h2>自我叙事</h2>
    ${versions}
  `);
}

function sameOrigin(req: http.IncomingMessage, url: URL): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === (req.headers.host ?? url.host);
  } catch {
    return false;
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error("提交内容过大"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function redirect(res: http.ServerResponse, pathname: string, notice: string): void {
  const back = pathname === "/chat" ? "/chat"
    : pathname.startsWith("/memories") ? "/memories"
    : pathname === "/persona" || pathname.startsWith("/narrative") ? "/self"
    : "/";
  const target = notice ? `${back}?notice=${encodeURIComponent(notice)}` : back;
  res.writeHead(303, { location: target });
  res.end();
}

function send(res: http.ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, {
    "content-type": type,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  });
  res.end(body);
}
