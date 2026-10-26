import { BudgetExceeded, NeedKey, StoreError } from "./errors.ts";
import { formatCny } from "./money.ts";
import { exploreSystem, chatSystem, reflectSystem } from "./prompt.ts";
import type { Importance, MemoryLayer, SourceType, Store } from "./store.ts";
import { exploreTools, chatTools, reflectTools } from "./tools.ts";
import { formatShanghai, msUntil, nextShanghaiMidnight, shanghaiDay } from "./time.ts";
import type { ChatMessage, Model, ToolCall } from "./types.ts";
import type { Budget } from "./budget.ts";
import { Guard } from "./guard.ts";

export type OpenResult =
  | { ok: true; documentId: number; title: string; finalUrl: string; excerpt: string }
  | { ok: false; error: string };

export type LookResult =
  | { ok: true; documentId: number; note: string; dataUrl: string }
  | { ok: false; error: string };

export type ExplorerDeps = {
  store: Store;
  budget: Budget;
  model: Model;
  now: () => Date;
  hasApiKey: boolean;
  openUrl: (url: string) => Promise<OpenResult>;
  lookImage: (url: string) => Promise<LookResult>;
  guard: Guard;
  log?: (event: Record<string, unknown>) => void;
};

type ToolOutcome = { ok: boolean; body: unknown; sleepAt?: string };

export class Explorer {
  private deps: ExplorerDeps;
  private stopped = false;
  private busy = false;
  private cancel = false;
  private waiters: Array<() => void> = [];

  constructor(deps: ExplorerDeps) {
    this.deps = deps;
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      const wait = await this.stepOnce();
      await this.sleep(wait);
    }
  }

  halt(): void {
    this.stopped = true;
    this.cancel = true;
    this.wake();
  }

  requestStart(): void {
    this.cancel = false;
    this.deps.store.setState({
      exploration: "running",
      phase: "idle",
      nextWakeupAt: null,
      lastNote: "准备出发",
    }, this.deps.now());
    this.wake();
  }

  requestStop(): void {
    this.cancel = true;
    this.deps.store.setState({
      exploration: "stopped",
      phase: "idle",
      nextWakeupAt: null,
      lastNote: "已停止",
    }, this.deps.now());
    this.wake();
  }

  async stepOnce(): Promise<number> {
    if (this.busy) return 1000;
    this.busy = true;
    try {
      return await this.step();
    } finally {
      this.busy = false;
    }
  }

  private async step(): Promise<number> {
    const now = this.deps.now();
    const state = this.deps.store.state();
    if (state.exploration !== "running" || this.cancel) {
      return 24 * 60 * 60 * 1000;
    }
    if (!this.deps.hasApiKey) {
      this.deps.store.setState({ phase: "needs_key", lastNote: "还没有 DeepSeek API Key" }, now);
      return 60_000;
    }
    if (this.deps.budget.snapshot(now).remaining <= 0n) {
      return this.holdForBudget(now);
    }
    if (state.nextWakeupAt && new Date(state.nextWakeupAt).getTime() > now.getTime()) {
      this.deps.store.setState({ phase: "sleeping" }, now);
      return Math.max(1000, msUntil(now, new Date(state.nextWakeupAt)));
    }
    this.deps.store.setState({ phase: "exploring", lastNote: "正在漫游" }, now);
    try {
      const outcome = await this.outing();
      if (outcome.kind === "budget") return this.holdForBudget(this.deps.now());
      if (outcome.kind === "backoff") {
        const until = new Date(this.deps.now().getTime() + outcome.ms);
        this.deps.store.setState({
          phase: "sleeping",
          nextWakeupAt: until.toISOString(),
          lastNote: outcome.note,
        }, this.deps.now());
        return outcome.ms;
      }
      this.deps.store.setState({
        phase: "sleeping",
        nextWakeupAt: outcome.until,
        lastNote: "休息中",
      }, this.deps.now());
      return Math.max(1000, msUntil(this.deps.now(), new Date(outcome.until)));
    } catch (error) {
      if (error instanceof BudgetExceeded) return this.holdForBudget(this.deps.now());
      const note = error instanceof Error ? error.message : "漫游出错";
      this.deps.log?.({ event: "outing_error", note });
      const until = new Date(this.deps.now().getTime() + 10 * 60 * 1000);
      this.deps.store.setState({ phase: "sleeping", nextWakeupAt: until.toISOString(), lastNote: note }, this.deps.now());
      return 10 * 60 * 1000;
    }
  }

  private holdForBudget(now: Date): number {
    const until = nextShanghaiMidnight(now);
    this.deps.store.setState({
      phase: "budget_hold",
      nextWakeupAt: until.toISOString(),
      lastNote: "今日额度已用完，聊天和漫游都先停下",
    }, now);
    return Math.max(1000, msUntil(now, until));
  }

  private async outing(): Promise<
    | { kind: "sleep"; until: string }
    | { kind: "budget" }
    | { kind: "backoff"; ms: number; note: string }
  > {
    const history: ChatMessage[] = [];
    const seen = new Map<string, number>();
    let latestDocumentId: number | null = null;
    let pendingImage: string | null = null;
    let nudges = 0;
    let consecutiveErrors = 0;
    let sleepAt: string | null = null;

    while (!sleepAt) {
      if (this.cancel || this.deps.store.state().exploration !== "running") {
        return { kind: "backoff", ms: 1000, note: "已停止" };
      }
      const now = this.deps.now();
      if (this.deps.budget.snapshot(now).remaining <= 0n) return { kind: "budget" };
      const system = this.systemMessage("explore");
      const extra: ChatMessage[] = [];
      if (pendingImage) {
        extra.push({
          role: "user",
          content: [
            { type: "text", text: "这是刚才那张图。" },
            { type: "image_url", image_url: { url: pendingImage } },
          ],
        });
        pendingImage = null;
      }
      const result = await this.deps.model.complete({
        messages: [system, ...trim(history), ...extra],
        tools: exploreTools,
        thinking: "disabled",
        maxOutputTokens: 2048,
        category: "explore",
      });
      if (result.toolCalls.length === 0) {
        nudges += 1;
        history.push({ role: "assistant", content: result.content });
        if (nudges >= 2) return { kind: "backoff", ms: 30 * 60 * 1000, note: "没有决定下一步，稍后再试" };
        history.push({ role: "user", content: "请调用工具继续。要休息时调用 sleep_until，并自己决定下次醒来的时间。" });
        continue;
      }
      nudges = 0;
      history.push({ role: "assistant", content: result.content, toolCalls: result.toolCalls });
      for (const call of result.toolCalls) {
        const outcome = await this.dispatch(call, {
          phase: "explore",
          latestDocumentId,
          latestChatId: null,
          seen,
        });
        if (outcome.body && typeof outcome.body === "object" && "documentId" in outcome.body) {
          latestDocumentId = Number((outcome.body as { documentId: number }).documentId);
        }
        if (outcome.body && typeof outcome.body === "object" && "dataUrl" in outcome.body) {
          pendingImage = String((outcome.body as { dataUrl: string }).dataUrl);
        }
        history.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(outcome.body) });
        consecutiveErrors = outcome.ok ? 0 : consecutiveErrors + 1;
        if (outcome.sleepAt) {
          sleepAt = outcome.sleepAt;
          break;
        }
        if (consecutiveErrors >= 8) {
          return { kind: "backoff", ms: 20 * 60 * 1000, note: "连续出错，稍后再试" };
        }
      }
    }

    const revised = await this.reflect(history, sleepAt);
    return { kind: "sleep", until: revised };
  }

  private async reflect(history: ChatMessage[], sleepAt: string): Promise<string> {
    let until = sleepAt;
    const local = history.slice();
    local.push({ role: "user", content: reflectSystem() });
    for (let round = 0; round < 4; round += 1) {
      if (this.deps.budget.snapshot(this.deps.now()).remaining <= 0n) return until;
      let result;
      try {
        result = await this.deps.model.complete({
          messages: [this.systemMessage("explore"), ...trim(local)],
          tools: reflectTools,
          thinking: "low",
          maxOutputTokens: 4096,
          category: "explore",
        });
      } catch (error) {
        if (error instanceof BudgetExceeded) return until;
        throw error;
      }
      if (result.toolCalls.length === 0) return until;
      local.push({ role: "assistant", content: result.content, toolCalls: result.toolCalls });
      let finished = false;
      for (const call of result.toolCalls) {
        const outcome = await this.dispatch(call, { phase: "reflect", latestDocumentId: null, latestChatId: null, seen: new Map() });
        local.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(outcome.body) });
        if (outcome.sleepAt) until = outcome.sleepAt;
        if (call.name === "finish_reflection") finished = true;
      }
      if (finished) return until;
    }
    return until;
  }

  async chat(userText: string): Promise<string> {
    if (!this.deps.hasApiKey) throw new NeedKey();
    if (this.deps.budget.snapshot(this.deps.now()).remaining <= 0n) throw new BudgetExceeded();
    const history: ChatMessage[] = this.deps.store.recentChat(20).map((message) => ({
      role: message.role,
      content: message.content,
    }));
    const latest = this.deps.store.recentChat(1).at(-1);
    const latestChatId = latest?.role === "user" && latest.content === userText.trim() ? latest.id : null;
    for (let round = 0; round < 4; round += 1) {
      const result = await this.deps.model.complete({
        messages: [this.systemMessage("chat"), ...history],
        tools: chatTools,
        thinking: "disabled",
        maxOutputTokens: 2048,
        category: "chat",
      });
      if (result.toolCalls.length === 0) return result.content || "我在。";
      history.push({ role: "assistant", content: result.content, toolCalls: result.toolCalls });
      for (const call of result.toolCalls) {
        const outcome = await this.dispatch(call, {
          phase: "chat",
          latestDocumentId: null,
          latestChatId,
          seen: new Map(),
        });
        history.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(outcome.body) });
      }
    }
    return "我先停在这里。";
  }

  private systemMessage(kind: "explore" | "chat"): ChatMessage {
    const now = this.deps.now();
    const snap = this.deps.budget.snapshot(now);
    const selected = this.deps.store.selectActiveMemories(6000);
    const memories = selected.picked.map((memory) => (
      `#${memory.id} [${memory.layer}/${memory.importance}] ${memory.content}（原因：${memory.reason}）`
    )).join("\n");
    const omitted = selected.omitted > 0 ? `\n还有 ${selected.omitted} 条活跃记忆没有放进这次上下文。` : "";
    if (kind === "chat") {
      return {
        role: "system",
        content: chatSystem({
          persona: this.deps.store.persona().content,
          narrative: this.deps.store.narrative().content,
          memories: memories + omitted,
          remaining: formatCny(snap.remaining),
        }),
      };
    }
    const diaries = this.deps.store.diaries(3).map((entry) => entry.title).join("、");
    return {
      role: "system",
      content: exploreSystem({
        nowLabel: formatShanghai(now),
        peak: snap.peak,
        remaining: formatCny(snap.remaining),
        persona: this.deps.store.persona().content,
        narrative: this.deps.store.narrative().content,
        memories: memories + omitted,
        diaries,
      }),
    };
  }

  private async dispatch(call: ToolCall, ctx: DispatchContext): Promise<ToolOutcome> {
    try {
      return await this.exec(call, ctx);
    } catch (error) {
      const message = error instanceof StoreError || error instanceof Error ? error.message : "工具失败";
      return { ok: false, body: { error: message } };
    }
  }

  private async exec(call: ToolCall, ctx: DispatchContext): Promise<ToolOutcome> {
    const args = call.arguments;
    if (ctx.phase === "reflect" && (call.name === "browse_page" || call.name === "look_image")) {
      return { ok: false, body: { error: "整理阶段不再打开网页" } };
    }
    if (call.name === "browse_page") {
      const url = stringArg(args, "url");
      const decision = await this.deps.guard.checkRequest(url, "GET");
      if (!decision.allow) return { ok: false, body: { error: decision.reason } };
      const times = (ctx.seen.get(url) ?? 0) + 1;
      ctx.seen.set(url, times);
      if (times > 3) return { ok: false, body: { error: "这一页刚刚读过" } };
      const opened = await this.deps.openUrl(url);
      this.deps.log?.({ event: "browse", url, ok: opened.ok });
      return opened.ok
        ? { ok: true, body: { documentId: opened.documentId, title: opened.title, finalUrl: opened.finalUrl, excerpt: opened.excerpt } }
        : { ok: false, body: { error: opened.error } };
    }
    if (call.name === "look_image") {
      const url = stringArg(args, "url");
      const decision = await this.deps.guard.checkRequest(url, "GET");
      if (!decision.allow) return { ok: false, body: { error: decision.reason } };
      const looked = await this.deps.lookImage(url);
      return looked.ok
        ? { ok: true, body: { documentId: looked.documentId, note: looked.note, dataUrl: looked.dataUrl } }
        : { ok: false, body: { error: looked.error } };
    }
    if (call.name === "search_archive") {
      const query = stringArg(args, "query");
      return {
        ok: true,
        body: {
          documents: this.deps.store.searchDocuments(query, 5),
          memories: this.deps.store.searchArchivedMemories(query, 5),
        },
      };
    }
    if (call.name === "remember") {
      const sources = readSources(args.sources);
      const filled = sources.length > 0 ? sources : defaultSource(ctx);
      if (filled.length === 0) return { ok: false, body: { error: "写下这条记忆的来源" } };
      const id = this.deps.store.addMemory({
        layer: enumArg(args, "layer", ["episodic", "semantic", "self"]) as MemoryLayer,
        content: stringArg(args, "content"),
        importance: enumArg(args, "importance", ["high", "medium", "low"]) as Importance,
        reason: stringArg(args, "reason"),
        sources: filled,
        now: this.deps.now(),
      });
      return { ok: true, body: { id } };
    }
    if (call.name === "archive_memory") {
      this.deps.store.archiveMemory(numberArg(args, "id"), this.deps.now());
      return { ok: true, body: { archived: true } };
    }
    if (call.name === "write_diary") {
      const id = this.deps.store.addDiary(stringArg(args, "title"), stringArg(args, "body"), this.deps.now());
      return { ok: true, body: { id } };
    }
    if (call.name === "write_summary") {
      this.deps.store.writeSummary(shanghaiDay(this.deps.now()), stringArg(args, "body"), this.deps.now());
      return { ok: true, body: { day: shanghaiDay(this.deps.now()) } };
    }
    if (call.name === "update_narrative") {
      const id = this.deps.store.updateNarrative(stringArg(args, "content"), stringArg(args, "reason"), this.deps.now());
      return { ok: true, body: { versionId: id } };
    }
    if (call.name === "sleep_until") {
      const at = new Date(stringArg(args, "at"));
      if (Number.isNaN(at.getTime()) || at.getTime() <= this.deps.now().getTime()) {
        return { ok: false, body: { error: "下次醒来的时间需要晚于现在" } };
      }
      return { ok: true, body: { sleeping: true }, sleepAt: at.toISOString() };
    }
    if (call.name === "finish_reflection") return { ok: true, body: { done: true } };
    return { ok: false, body: { error: `未知工具 ${call.name}` } };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const waiter = () => {
        clearTimeout(timer);
        finish();
      };
      const finish = () => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        resolve();
      };
      timer = setTimeout(finish, ms);
      this.waiters.push(waiter);
    });
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }
}

type DispatchContext = {
  phase: "explore" | "reflect" | "chat";
  latestDocumentId: number | null;
  latestChatId: number | null;
  seen: Map<string, number>;
};

function defaultSource(ctx: DispatchContext): Array<{ type: SourceType; id: number }> {
  if (ctx.phase === "chat" && ctx.latestChatId) return [{ type: "chat", id: ctx.latestChatId }];
  if (ctx.latestDocumentId) return [{ type: "document", id: ctx.latestDocumentId }];
  return [];
}

function readSources(value: unknown): Array<{ type: SourceType; id: number }> {
  if (!Array.isArray(value)) return [];
  const sources: Array<{ type: SourceType; id: number }> = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const type = (item as { type?: unknown }).type;
    const id = (item as { id?: unknown }).id;
    if ((type === "document" || type === "chat" || type === "diary") && typeof id === "number") {
      sources.push({ type, id });
    }
  }
  return sources;
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new StoreError(`缺少 ${key}`);
  return value.trim();
}

function numberArg(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isInteger(value)) throw new StoreError(`缺少 ${key}`);
  return value;
}

function enumArg(args: Record<string, unknown>, key: string, allowed: string[]): string {
  const value = stringArg(args, key);
  if (!allowed.includes(value)) throw new StoreError(`${key} 无效`);
  return value;
}

function trim(history: ChatMessage[]): ChatMessage[] {
  const kept = history.slice();
  while (kept.length > 16) {
    kept.shift();
    while (kept[0]?.role === "tool") kept.shift();
  }
  return kept;
}
