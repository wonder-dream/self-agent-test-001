import assert from "node:assert/strict";
import test from "node:test";
import { extractHtml } from "../src/extract.ts";

test("html extraction keeps the article text and drops scripts", () => {
  const html = `<!doctype html><html><head><title>海边</title></head><body>
    <script>secret()</script>
    <article><h1>灯塔</h1><p>白灯照着海岸，夜里也能看见。</p></article>
  </body></html>`;
  const extracted = extractHtml(html, "https://example.com/light");
  assert.match(extracted.text, /白灯照着海岸/);
  assert.equal(extracted.text.includes("secret"), false);
});
