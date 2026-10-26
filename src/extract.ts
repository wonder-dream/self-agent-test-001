import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { extractText } from "unpdf";

export function extractHtml(html: string, url: string): { title: string; text: string } {
  const { document } = parseHTML(html);
  for (const node of document.querySelectorAll("script, style, noscript")) node.remove();
  const reader = new Readability(document as unknown as Document, { charThreshold: 80 });
  const article = reader.parse();
  const title = (article?.title || document.querySelector("title")?.textContent || url).trim();
  const text = (article?.textContent || document.body?.textContent || "").replace(/\s+/g, " ").trim();
  return { title, text };
}

export async function extractPdf(data: Uint8Array): Promise<string> {
  const result = await extractText(data, { mergePages: true });
  return result.text.replace(/\s+/g, " ").trim();
}
