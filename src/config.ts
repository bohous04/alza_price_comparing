import type { AlzaAccount } from "./types.js";

export interface AppConfig {
  accounts: AlzaAccount[];
  apiKey: string;
  port: number;
  chromePath: string;
  chromeDebugPort: number;
  chromeUserDataDir: string;
}

export function loadConfig(): AppConfig {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    throw new Error("API_KEY environment variable is required");
  }

  const port = parseInt(process.env.PORT || "3000", 10);
  const chromePath = process.env.CHROME_PATH || findChrome();
  const chromeDebugPort = parseInt(process.env.CHROME_DEBUG_PORT || "9222", 10);
  const chromeUserDataDir = process.env.CHROME_USER_DATA_DIR || "/tmp/alza-chrome-profile";
  const accounts = loadAccounts();

  if (accounts.length === 0) {
    throw new Error(
      "At least one Alza account must be configured (ALZA_ACC1_EMAIL, ALZA_ACC1_PASSWORD, ALZA_ACC1_LABEL)"
    );
  }

  console.log(`Loaded ${accounts.length} Alza account(s): ${accounts.map((a) => a.label).join(", ")}`);

  return { accounts, apiKey, port, chromePath, chromeDebugPort, chromeUserDataDir };
}

function findChrome(): string {
  const paths = [
    // macOS
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    // Linux
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    // Docker/Playwright
    "/ms-playwright/chromium_headless_shell-*/chrome-linux/headless_shell",
  ];
  // Return first path that could exist; actual validation happens at launch time
  for (const p of paths) {
    if (!p.includes("*")) return p;
  }
  return "google-chrome";
}

function loadAccounts(): AlzaAccount[] {
  const accounts: AlzaAccount[] = [];

  for (let i = 1; ; i++) {
    const prefix = `ALZA_ACC${i}`;
    const email = process.env[`${prefix}_EMAIL`];
    const password = process.env[`${prefix}_PASSWORD`];
    const label = process.env[`${prefix}_LABEL`];

    // Stop when we hit a gap
    if (!email && !password && !label) {
      break;
    }

    // Validate completeness
    const missing: string[] = [];
    if (!email) missing.push(`${prefix}_EMAIL`);
    if (!password) missing.push(`${prefix}_PASSWORD`);
    if (!label) missing.push(`${prefix}_LABEL`);

    if (missing.length > 0) {
      throw new Error(
        `Incomplete account configuration for ${prefix}: missing ${missing.join(", ")}`
      );
    }

    accounts.push({ email: email!, password: password!, label: label! });
  }

  return accounts;
}
