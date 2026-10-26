import { BudgetExceeded, ModelError, NeedKey } from "./errors.ts";
import { redact } from "./log.ts";
import type { PriceCard, TokenUse } from "./pricing.ts";
import type { ChatMessage, Model, ModelInput, ModelOutput, ToolCall } from "./types.ts";
import { Budget } from "./budget.ts";

export function estimateUsage(messages: unknown, tools: unknown, maxOutputTokens: number): TokenUse {
  const text = JSON.stringify(messages) + JSON.stringify(tools);
  return { cacheHit: 0, cacheMiss: Array.from(text).length, output: maxOutputTokens };
}

export class Gate {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release: () => void = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(fn).finally(release);
  }
}

export class DeepseekModel implements Model {
  private readonly gate = new Gate();
  private opts: {
    budget: Budget;
    apiKey: string;
    baseUrl: string;
    model: string;
    now?: () => Date;
    fetchImpl?: typeof fetch;
  };

  constructor(opts: {
    budget: Budget;
    apiKey: string;
    baseUrl: string;
    model: string;
    now?: () => Date;
    fetchImpl?: typeof fetch;
  }) {
    this.opts = opts;
  }

  complete(input: ModelInput): Promise<ModelOutput> {
    return this.gate.run(() => this.call(input));
  }

  private async call(input: ModelInput): Promise<ModelOutput> {
    if (!this.opts.apiKey) throw new NeedKey();
    const at = (this.opts.now ?? (() => new Date()))();
    const estimate = estimateUsage(input.messages, input.tools, input.maxOutputTokens);
    const allowed = this.opts.budget.authorize(estimate, at);
    if (!allowed.ok) throw new BudgetExceeded();
    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages: input.messages.map(toApi),
      tools: input.tools,
      tool_choice: "auto",
      max_tokens: input.maxOutputTokens,
      thinking: { type: input.thinking === "disabled" ? "disabled" : "enabled" },
    };
    if (input.thinking === "low") body.reasoning_effort = "low";
    let response: Response;
    try {
      response = await (this.opts.fetchImpl ?? fetch)(`${this.opts.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new ModelError(redact(error instanceof Error ? error.message : "网络错误", this.opts.apiKey));
    }
    if (!response.ok) {
      const detail = redact(await response.text(), this.opts.apiKey).slice(0, 300);
      throw new ModelError(`DeepSeek HTTP ${response.status} ${detail}`);
    }
    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: string | null; tool_calls?: ApiToolCall[] } }>;
      usage?: Record<string, unknown>;
    };
    const usage = readUsage(payload.usage, estimate);
    this.opts.budget.commit({ at, category: input.category, model: this.opts.model, usage });
    const message = payload.choices?.[0]?.message;
    return {
      content: message?.content ?? "",
      toolCalls: (message?.tool_calls ?? []).map(readToolCall),
      usage,
    };
  }
}

type ApiToolCall = { id?: string; function?: { name?: string; arguments?: string } };

function toApi(message: ChatMessage): unknown {
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: typeof message.content === "string" ? message.content : "",
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    };
  }
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    };
  }
  return { role: message.role, content: message.content };
}

function readToolCall(call: ApiToolCall): ToolCall {
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(call.function?.arguments || "{}") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
  } catch {
    args = {};
  }
  return { id: call.id || `call_${Math.random().toString(36).slice(2)}`, name: call.function?.name || "", arguments: args };
}

function readUsage(usage: Record<string, unknown> | undefined, estimate: TokenUse): TokenUse {
  if (!usage) return estimate;
  const prompt = numberOrUndefined(usage.prompt_tokens);
  const output = numberOrUndefined(usage.completion_tokens);
  const hit = numberOrUndefined(usage.prompt_cache_hit_tokens);
  const miss = numberOrUndefined(usage.prompt_cache_miss_tokens);
  if (output === undefined) return estimate;
  if (hit === undefined && miss === undefined) {
    return { cacheHit: 0, cacheMiss: prompt ?? estimate.cacheMiss, output };
  }
  const cacheHit = hit ?? 0;
  const cacheMiss = miss ?? Math.max(0, (prompt ?? cacheHit) - cacheHit);
  return { cacheHit, cacheMiss, output };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function zeroUsage(): TokenUse {
  return { cacheHit: 0, cacheMiss: 0, output: 0 };
}

export type { PriceCard };
