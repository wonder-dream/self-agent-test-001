import { Guard } from "./guard.ts";
import { extractHtml, extractPdf } from "./extract.ts";
import { startGuardProxy } from "./proxy.ts";
import { safeGet } from "./safeget.ts";
import type { Store } from "./store.ts";
import type { LookResult, OpenResult } from "./loop.ts";

const MAX_BYTES = 15_000_000;

export class BrowserSession {
  private guard: Guard;
  private noSandbox: boolean;
  private browser: import("playwright").Browser | null = null;
  private context: import("playwright").BrowserContext | null = null;
  private page: import("playwright").Page | null = null;
  private proxy: { port: number; close: () => Promise<void> } | null = null;
  private blockReason: string | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(guard: Guard, noSandbox: boolean) {
    this.guard = guard;
    this.noSandbox = noSandbox;
  }

  open(url: string, store: Store): Promise<OpenResult> {
    return this.exclusive(() => this.openLocked(url, store));
  }

  look(url: string, store: Store): Promise<LookResult> {
    return this.exclusive(() => this.lookLocked(url, store));
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => {});
    await this.proxy?.close().catch(() => {});
    this.browser = null;
    this.context = null;
    this.page = null;
    this.proxy = null;
  }

  private async openLocked(url: string, store: Store): Promise<OpenResult> {
    const decision = await this.guard.checkRequest(url, "GET");
    if (!decision.allow) return { ok: false, error: decision.reason };
    const page = await this.ensurePage();
    this.blockReason = null;
    try {
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25_000 });
      const contentType = (response?.headers()["content-type"] ?? "").toLowerCase();
      const finalUrl = page.url() || url;
      if (contentType.includes("application/pdf")) {
        const body = await response?.body();
        if (!body || body.length > MAX_BYTES) return { ok: false, error: "PDF 无法读取" };
        const text = await extractPdf(body);
        return this.saved(store, url, finalUrl, "pdf", finalUrl, text);
      }
      const html = await page.content();
      const extracted = extractHtml(html, finalUrl);
      if (!extracted.text) return { ok: false, error: "这一页没有读到正文" };
      return this.saved(store, url, finalUrl, "html", extracted.title, extracted.text);
    } catch (error) {
      if (this.blockReason) return { ok: false, error: this.blockReason };
      return { ok: false, error: error instanceof Error ? error.message : "页面没有打开" };
    }
  }

  private async lookLocked(url: string, store: Store): Promise<LookResult> {
    const fetched = await safeGet(url, this.guard, 8_000_000);
    if (!fetched.ok) return fetched;
    if (!fetched.fetched.contentType.toLowerCase().startsWith("image/")) {
      return { ok: false, error: "这不是图片" };
    }
    const sharp = (await import("sharp")).default;
    let jpeg = await sharp(fetched.fetched.body, { limitInputPixels: 20_000_000 })
      .rotate()
      .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toBuffer();
    if (jpeg.length > 400_000) {
      jpeg = await sharp(jpeg).jpeg({ quality: 40 }).toBuffer();
    }
    if (jpeg.length > 500_000) return { ok: false, error: "图片太大，不送给模型" };
    const now = new Date();
    const documentId = store.addDocument({
      url,
      finalUrl: fetched.fetched.finalUrl,
      title: "图片",
      kind: "image",
      text: "查看了一张图片",
      now,
    });
    return {
      ok: true,
      documentId,
      note: "图片已附上",
      dataUrl: `data:image/jpeg;base64,${jpeg.toString("base64")}`,
    };
  }

  private saved(store: Store, url: string, finalUrl: string, kind: string, title: string, text: string): OpenResult {
    const documentId = store.addDocument({ url, finalUrl, title, kind, text, now: new Date() });
    return { ok: true, documentId, title, finalUrl, excerpt: text.slice(0, 3500) };
  }

  private async ensurePage(): Promise<import("playwright").Page> {
    if (this.page) return this.page;
    const { chromium } = await import("playwright");
    this.proxy = await startGuardProxy(this.guard);
    this.browser = await chromium.launch({
      headless: true,
      args: [
        this.noSandbox ? "--no-sandbox" : "",
        "--disable-dev-shm-usage",
        `--proxy-server=http://127.0.0.1:${this.proxy.port}`,
      ].filter((arg) => arg.length > 0),
    });
    this.context = await this.browser.newContext({
      acceptDownloads: false,
      serviceWorkers: "block",
      locale: "zh-CN",
    });
    await this.context.route("**/*", (route) => this.onRoute(route));
    this.page = await this.context.newPage();
    return this.page;
  }

  private async onRoute(route: import("playwright").Route): Promise<void> {
    const request = route.request();
    const target = request.url();
    const method = request.method();
    const protocol = target.split(":")[0] ?? "";
    if (protocol === "javascript" || protocol === "file" || protocol === "chrome" || protocol === "chrome-extension") {
      await route.abort();
      return;
    }
    if (request.resourceType() === "websocket") {
      await route.abort();
      return;
    }
    if (target.startsWith("data:") || target.startsWith("blob:")) {
      if (request.resourceType() === "document") await route.abort();
      else await route.continue();
      return;
    }
    if (method !== "GET" && method !== "HEAD") {
      this.blockReason = "只允许读取，不能提交";
      await route.abort();
      return;
    }
    const decision = await this.guard.checkRequest(target, method);
    if (!decision.allow) {
      this.blockReason = decision.reason;
      await route.abort();
      return;
    }
    await route.continue();
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(() => {}, () => {});
    return run;
  }
}
