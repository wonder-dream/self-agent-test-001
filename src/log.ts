import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

export function logEvent(file: string, event: Record<string, unknown>): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const line = JSON.stringify({ t: new Date().toISOString(), ...event });
  appendFileSync(file, `${line}\n`);
}

export function readTail(file: string, maxBytes = 32_768): string[] {
  try {
    const text = readFileSync(file);
    const slice = text.byteLength > maxBytes ? text.subarray(text.byteLength - maxBytes) : text;
    return slice.toString("utf8").split("\n").filter((line) => line.trim().length > 0).slice(-40);
  } catch {
    return [];
  }
}

export function redact(text: string, secret: string): string {
  if (!secret) return text;
  return text.replaceAll(secret, "[redacted]");
}
