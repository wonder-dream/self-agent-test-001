import type { TokenUse } from "./pricing.ts";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
};

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ModelInput = {
  messages: ChatMessage[];
  tools: ToolDefinition[];
  thinking: "disabled" | "low";
  maxOutputTokens: number;
  category: "explore" | "chat";
};

export type ModelOutput = {
  content: string;
  toolCalls: ToolCall[];
  usage: TokenUse;
};

export interface Model {
  complete(input: ModelInput): Promise<ModelOutput>;
}
