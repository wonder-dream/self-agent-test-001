import type { ToolDefinition } from "./types.ts";

const object = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

function tool(name: string, description: string, parameters: Record<string, unknown>): ToolDefinition {
  return { type: "function", function: { name, description, parameters } };
}

const url = { type: "string", description: "http 或 https 网址" };
const source = {
  type: "object",
  additionalProperties: false,
  required: ["type", "id"],
  properties: {
    type: { type: "string", enum: ["document", "chat", "diary"] },
    id: { type: "integer" },
  },
};

export const browseTool = tool("browse_page", "打开一个公开网页并阅读正文。", object({ url }, ["url"]));
export const lookTool = tool("look_image", "查看一张公开图片。只在画面本身重要时使用。", object({ url }, ["url"]));
export const searchTool = tool("search_archive", "检索已经归档的原文和记忆。日常回忆不会自动带上它们。", object({
  query: { type: "string", description: "至少三个字" },
}, ["query"]));
export const rememberTool = tool("remember", "记下一条记忆。重要度由你判断，并写下来源和原因。", object({
  layer: { type: "string", enum: ["episodic", "semantic", "self"] },
  content: { type: "string" },
  importance: { type: "string", enum: ["high", "medium", "low"] },
  reason: { type: "string" },
  sources: { type: "array", items: source },
}, ["layer", "content", "importance", "reason"]));
export const archiveTool = tool("archive_memory", "让一条活跃记忆退出日常回忆。原文仍保留。", object({
  id: { type: "integer" },
}, ["id"]));
export const diaryTool = tool("write_diary", "写下这次漫游的日记。", object({
  title: { type: "string" },
  body: { type: "string" },
}, ["title", "body"]));
export const summaryTool = tool("write_summary", "写下或改写今天的摘要。", object({
  body: { type: "string" },
}, ["body"]));
export const narrativeTool = tool("update_narrative", "小幅更新自我叙事。不要改写核心人格里的身份和价值观。", object({
  content: { type: "string" },
  reason: { type: "string" },
}, ["content", "reason"]));
export const sleepTool = tool("sleep_until", "结束这次漫游，并决定下次醒来的时间。", object({
  at: { type: "string", description: "ISO 8601 时间，必须晚于现在" },
}, ["at"]));
export const finishReflectionTool = tool("finish_reflection", "整理已经写完。", object({}, []));

export const exploreTools = [browseTool, lookTool, searchTool, rememberTool, archiveTool, diaryTool, summaryTool, narrativeTool, sleepTool];
export const reflectTools = [diaryTool, summaryTool, narrativeTool, sleepTool, finishReflectionTool];
export const chatTools = [searchTool, rememberTool, narrativeTool];
