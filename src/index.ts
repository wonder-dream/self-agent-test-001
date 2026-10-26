import path from "node:path";
import { Budget } from "./budget.ts";
import { BrowserSession } from "./browser.ts";
import { loadConfig } from "./config.ts";
import { backupDatabase, openDatabase } from "./db.ts";
import { Guard } from "./guard.ts";
import { Explorer } from "./loop.ts";
import { logEvent } from "./log.ts";
import { DeepseekModel } from "./model.ts";
import { startPanel } from "./panel.ts";
import { loadPriceCardFile } from "./pricing.ts";
import { Store } from "./store.ts";

const config = loadConfig(process.env);
const db = openDatabase(path.join(config.dataDir, "wander.sqlite"));
const store = new Store(db);
const budget = Budget.fromCny(db, loadPriceCardFile(config.pricingPath), config.dailyBudgetCny);
const guard = new Guard();
const browser = new BrowserSession(guard, config.chromiumNoSandbox);
const logFile = path.join(config.dataDir, "agent.jsonl");
const explorer = new Explorer({
  store,
  budget,
  model: new DeepseekModel({
    budget,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
  }),
  now: () => new Date(),
  hasApiKey: config.apiKey.length > 0,
  openUrl: (url) => browser.open(url, store),
  lookImage: (url) => browser.look(url, store),
  guard,
  log: (event) => logEvent(logFile, event),
});
const panel = await startPanel({
  store,
  budget,
  explorer,
  now: () => new Date(),
  logFile,
  host: config.panelHost,
  port: config.panelPort,
});
const backupDir = path.join(config.dataDir, "backups");
const backups = setInterval(() => {
  void backupDatabase(db, backupDir).catch((error: unknown) => {
    logEvent(logFile, { event: "backup_error", message: error instanceof Error ? error.message : "backup" });
  });
}, 6 * 60 * 60 * 1000);
backups.unref();
void explorer.run();

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  clearInterval(backups);
  explorer.halt();
  await backupDatabase(db, backupDir).catch(() => {});
  await browser.close();
  await panel.close();
  store.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
logEvent(logFile, { event: "boot", panel: panel.url });
console.log(`面板 ${panel.url}`);
