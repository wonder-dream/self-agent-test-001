export type AppConfig = {
  dataDir: string;
  panelHost: string;
  panelPort: number;
  apiKey: string;
  baseUrl: string;
  model: string;
  dailyBudgetCny: string;
  pricingPath: string;
  chromiumNoSandbox: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const port = Number(env.PANEL_PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PANEL_PORT 无效");
  }
  return {
    dataDir: env.DATA_DIR || "data",
    panelHost: env.PANEL_HOST || "127.0.0.1",
    panelPort: port,
    apiKey: env.DEEPSEEK_API_KEY || "",
    baseUrl: (env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, ""),
    model: env.DEEPSEEK_MODEL || "deepseek-flash",
    dailyBudgetCny: env.DAILY_BUDGET_CNY || "10",
    pricingPath: env.PRICING_PATH || "config/pricing.json",
    chromiumNoSandbox: env.CHROMIUM_NO_SANDBOX !== "0",
  };
}
