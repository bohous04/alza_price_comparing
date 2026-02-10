import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { parse as parseHTML } from "node-html-parser";
import { spawn, execSync } from "child_process";
import type { AppConfig } from "./config.js";
import type { AlzaAccount, ScrapedData, AccountSessionStatus, SessionStatus } from "./types.js";

const ALZA_BASE = "https://www.alza.cz";
const CF_TIMEOUT = 90_000;
const SESSION_TTL = 10 * 60 * 1000; // 10 minutes

interface AccountSession {
  context: BrowserContext;
  status: SessionStatus;
  phone?: string;
  error?: string;
  /** Page kept open on the verify form so we can submit the code */
  verifyPage?: Page;
  expires: number;
}

let browser: Browser | null = null;
let chromeProcess: ReturnType<typeof spawn> | null = null;
let browserInitPromise: Promise<Browser> | null = null;
const sessions = new Map<string, AccountSession>();

/**
 * Launch Chrome with a specific URL.
 * Cloudflare Turnstile detects Playwright's CDP connection, so we launch
 * Chrome and let it navigate BEFORE connecting Playwright. Once CF resolves
 * (verified via HTTP polling of the /json endpoint), we connect Playwright.
 */
async function launchChromeAndWaitForCF(
  config: AppConfig,
  url: string,
  titleCheck: (title: string) => boolean,
  timeoutMs = 120_000
): Promise<void> {
  const { chromeDebugPort } = config;

  // Poll via CDP HTTP API for the page title to change
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${chromeDebugPort}/json`);
      const targets = await res.json();
      for (const t of targets) {
        if (t.type === "page" && titleCheck(t.title || "")) {
          return; // CF resolved
        }
      }
    } catch {
      // Chrome not ready yet
    }
    await sleep(2000);
  }
  throw new Error(`Cloudflare did not resolve within ${timeoutMs / 1000}s`);
}

export async function ensureBrowser(config: AppConfig): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  if (browserInitPromise) return browserInitPromise;
  browserInitPromise = initBrowser(config);
  try {
    return await browserInitPromise;
  } finally {
    browserInitPromise = null;
  }
}

async function initBrowser(config: AppConfig): Promise<Browser> {
  if (browser?.isConnected()) return browser;

  const { chromePath, chromeDebugPort, chromeUserDataDir } = config;

  // Kill any existing process on the debug port
  try { execSync(`lsof -ti:${chromeDebugPort} | xargs kill -9 2>/dev/null`); } catch {}
  await sleep(1000);

  const useXvfb = process.env.USE_XVFB === "true";
  const cmd = useXvfb ? "xvfb-run" : chromePath;
  const args = useXvfb
    ? ["--auto-servernum", "--server-args=-screen 0 1280x720x24", chromePath]
    : [];

  // Build OIDC authorize URL — this redirects to login page with proper ReturnUrl
  const oidcUrl = "https://identity.alza.cz/connect/authorize?" + new URLSearchParams({
    client_id: "alza",
    response_type: "code id_token",
    scope: "email openid profile alza offline_access",
    redirect_uri: "https://www.alza.cz/external/callback",
    response_mode: "form_post",
    nonce: `nonce_${Date.now()}`,
    culture: "cs-CZ",
    acr_values: "country:CZ regLink:Production_registration source:Web",
  }).toString();

  args.push(
    `--remote-debugging-port=${chromeDebugPort}`,
    `--user-data-dir=${chromeUserDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    "--window-size=1280,720",
    // Navigate to OIDC authorize URL on startup — CF Turnstile resolves when Playwright is NOT connected
    oidcUrl,
  );

  console.log(`Launching Chrome from ${chromePath}${useXvfb ? " (via Xvfb)" : ""}...`);
  chromeProcess = spawn(cmd, args, { detached: true, stdio: "ignore" });
  chromeProcess.unref();

  // Wait for Chrome to start
  await sleep(5000);

  // Wait for CF Turnstile to resolve on the login page (no Playwright connected!)
  console.log("Waiting for Cloudflare Turnstile to resolve (without Playwright)...");
  await launchChromeAndWaitForCF(
    config,
    oidcUrl,
    (title) => {
      const t = title.toLowerCase();
      // Login page title or redirect means CF cleared
      return t.length > 0 && !t.includes("okamžik") && !t.includes("just a moment");
    },
    120_000
  );
  console.log("Cloudflare resolved! Connecting Playwright...");

  // NOW connect Playwright — CF already cleared
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${chromeDebugPort}`);
  console.log("Connected to Chrome via CDP");
  return browser;
}

export async function initLogin(
  account: AlzaAccount,
  config: AppConfig
): Promise<AccountSessionStatus> {
  // Check for valid cached session
  const cached = sessions.get(account.email);
  if (cached && cached.status === "logged_in" && cached.expires > Date.now()) {
    console.log(`Session still valid for ${account.label}`);
    return { label: account.label, status: "logged_in" };
  }

  // Clean up old session
  if (cached) {
    await cached.verifyPage?.close().catch(() => {});
    await cached.context?.close().catch(() => {});
    sessions.delete(account.email);
  }

  try {
    const b = await ensureBrowser(config);

    // Find the existing login page in the default context (opened at Chrome launch)
    // or create a new context for subsequent accounts
    let context: BrowserContext;
    let page: Page | null = null;

    const defaultCtx = b.contexts()[0];
    if (defaultCtx && !sessions.size) {
      // First account: use the page already open from Chrome launch
      context = defaultCtx;
      for (const p of context.pages()) {
        if (p.url().includes("identity.alza.cz")) {
          page = p;
          break;
        }
      }
    }

    if (!page) {
      // Subsequent accounts or if the initial page wasn't found
      context = defaultCtx || await b.newContext({
        locale: "cs-CZ",
        viewport: { width: 1280, height: 720 },
      });
      page = await context.newPage();

      // Navigate to login page
      console.log(`[${account.label}] Navigating to login page...`);
      await page.goto("https://identity.alza.cz/Account/Login", {
        waitUntil: "domcontentloaded",
        timeout: CF_TIMEOUT,
      });
      await waitForCloudflare(page);
    } else {
      context = defaultCtx;
    }

    console.log(`[${account.label}] Login page ready: ${await page.title()}`);
    await humanDelay(500, 1000);

    // Wait for login form
    await page.waitForSelector("#userName", { state: "visible", timeout: 30_000 });

    // Fill login form
    console.log(`[${account.label}] Filling login form...`);
    await page.locator("#userName").click();
    await humanDelay(200, 400);
    await page.locator("#userName").fill(account.email);
    await humanDelay(300, 600);
    await page.locator("#password").click();
    await humanDelay(200, 400);
    await page.locator("#password").fill(account.password);
    await humanDelay(500, 1000);

    await page.locator('button[type="submit"]').first().click();
    console.log(`[${account.label}] Login form submitted`);

    // Wait for navigation after login
    await page.waitForTimeout(5000);
    const afterLoginUrl = page.url();
    console.log(`[${account.label}] After login URL: ${afterLoginUrl}`);

    // Check result
    if (afterLoginUrl.includes("/Account/Verify") || afterLoginUrl.toLowerCase().includes("/account/verify")) {
      console.log(`[${account.label}] SMS verification required`);

      const phone = await page.evaluate(() => {
        const text = document.body?.innerText || "";
        const match = text.match(/[\*\d][\*\d\s]+\d{3}/);
        return match?.[0]?.trim() || undefined;
      });

      sessions.set(account.email, {
        context,
        status: "verification_required",
        phone,
        verifyPage: page,
        expires: Date.now() + SESSION_TTL,
      });

      return { label: account.label, status: "verification_required", phone };
    }

    if (afterLoginUrl.includes("alza.cz") && !afterLoginUrl.includes("identity.alza.cz")) {
      console.log(`[${account.label}] Login successful (no 2FA)`);
      await page.close();
      sessions.set(account.email, {
        context,
        status: "logged_in",
        expires: Date.now() + SESSION_TTL,
      });
      return { label: account.label, status: "logged_in" };
    }

    // Try waiting for redirect
    try {
      await page.waitForURL(/www\.alza\.cz/, { timeout: 30_000 });
      console.log(`[${account.label}] Login successful (delayed redirect)`);
      await page.close();
      sessions.set(account.email, {
        context,
        status: "logged_in",
        expires: Date.now() + SESSION_TTL,
      });
      return { label: account.label, status: "logged_in" };
    } catch {
      if (page.url().includes("/Account/Verify")) {
        console.log(`[${account.label}] SMS verification required (delayed)`);
        const phone = await page.evaluate(() => {
          const text = document.body?.innerText || "";
          const match = text.match(/[\*\d][\*\d\s]+\d{3}/);
          return match?.[0]?.trim() || undefined;
        });
        sessions.set(account.email, {
          context,
          status: "verification_required",
          phone,
          verifyPage: page,
          expires: Date.now() + SESSION_TTL,
        });
        return { label: account.label, status: "verification_required", phone };
      }
    }

    const pageTitle = await page.title();
    const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 500));
    await page.close();

    const error = `Unexpected state: ${pageTitle} (${afterLoginUrl})`;
    console.error(`[${account.label}] ${error}`);
    console.error(`[${account.label}] Page content: ${bodyText}`);
    return { label: account.label, status: "failed", error };

  } catch (e) {
    const error = e instanceof Error ? e.message : "Unknown error";
    console.error(`[${account.label}] Login failed: ${error}`);
    return { label: account.label, status: "failed", error };
  }
}

export async function submitVerificationCode(
  account: AlzaAccount,
  code: string
): Promise<AccountSessionStatus> {
  const session = sessions.get(account.email);
  if (!session || session.status !== "verification_required" || !session.verifyPage) {
    return { label: account.label, status: "failed", error: "No pending verification for this account" };
  }

  const page = session.verifyPage;

  try {
    // If the verify page has navigated away, go back to it
    const currentUrl = page.url();
    if (!currentUrl.toLowerCase().includes("/account/verify")) {
      console.log(`[${account.label}] Verify page navigated away (${currentUrl}), going back...`);
      await page.goto("https://identity.alza.cz/Account/Verify", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await waitForCloudflare(page);
    }

    // Fill the code input — the form auto-submits after filling
    const codeInput = page.locator("#code");
    await codeInput.waitFor({ state: "visible", timeout: 10_000 });
    await codeInput.fill(code);
    console.log(`[${account.label}] Code filled, waiting for auto-submit...`);

    // Wait for redirect to alza.cz (form auto-submits via JS)
    await page.waitForURL(/www\.alza\.cz/, { timeout: 30_000 });
    console.log(`[${account.label}] Verification successful`);

    await page.close();
    session.verifyPage = undefined;
    session.status = "logged_in";
    session.expires = Date.now() + SESSION_TTL;

    return { label: account.label, status: "logged_in" };
  } catch (e) {
    const error = e instanceof Error ? e.message : "Verification failed";
    console.error(`[${account.label}] Verification failed: ${error}`);

    const currentUrl = page.url();
    if (currentUrl.includes("/Account/Verify")) {
      return { label: account.label, status: "verification_required", phone: session.phone, error: "Invalid code, try again" };
    }

    await page.close().catch(() => {});
    session.verifyPage = undefined;
    session.status = "failed";
    session.error = error;
    return { label: account.label, status: "failed", error };
  }
}

export function getSessionStatus(account: AlzaAccount): AccountSessionStatus {
  const session = sessions.get(account.email);
  if (!session) return { label: account.label, status: "not_started" };
  if (session.status === "logged_in" && session.expires <= Date.now()) {
    return { label: account.label, status: "not_started" };
  }
  return {
    label: account.label,
    status: session.status,
    phone: session.phone,
    error: session.error,
  };
}

export async function scrapePrice(
  account: AlzaAccount,
  url: string
): Promise<ScrapedData> {
  const session = sessions.get(account.email);
  if (!session || session.status !== "logged_in") {
    throw new Error(`No active session for ${account.label}. Call /auth/init first.`);
  }

  if (session.expires <= Date.now()) {
    sessions.delete(account.email);
    throw new Error(`Session expired for ${account.label}. Call /auth/init to re-login.`);
  }

  const page = await session.context.newPage();
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: CF_TIMEOUT });
    await waitForCloudflare(page);

    const html = await page.content();
    const priceData = parsePrice(html);
    if (!priceData) {
      throw new Error(`Could not extract price from account: ${account.label}`);
    }

    const product = parseProductName(html);
    return { product, price: priceData.price, priceFormatted: priceData.priceFormatted };
  } finally {
    await page.close();
  }
}

// --- Price parsing ---

function parsePrice(html: string): { price: number; priceFormatted: string } | null {
  const root = parseHTML(html);

  // Strategy 1: JSON-LD structured data
  const jsonLdScripts = root.querySelectorAll('script[type="application/ld+json"]');
  for (const script of jsonLdScripts) {
    try {
      const data = JSON.parse(script.textContent);
      const offers = data.offers || data?.mainEntity?.offers;
      if (offers) {
        const offer = Array.isArray(offers) ? offers[0] : offers;
        if (offer.price !== undefined) {
          const price = parseFloat(String(offer.price));
          if (!isNaN(price) && price > 0) {
            return { price, priceFormatted: formatCzechPrice(price) };
          }
        }
      }
    } catch {
      // Skip invalid JSON-LD
    }
  }

  // Strategy 2: Meta tags
  const metaSelectors = [
    'meta[property="og:price:amount"]',
    'meta[property="product:price:amount"]',
  ];
  for (const selector of metaSelectors) {
    const meta = root.querySelector(selector);
    if (meta) {
      const price = parseCzechNumber(meta.getAttribute("content") || "");
      if (price !== null) {
        return { price, priceFormatted: formatCzechPrice(price) };
      }
    }
  }

  // Strategy 3: CSS class-based selectors
  const priceSelectors = [
    ".price-box__price",
    ".c2",
    ".price_withVat",
    "#prices .js-price-box .price-box__paragraph--price",
  ];
  for (const selector of priceSelectors) {
    const el = root.querySelector(selector);
    if (el) {
      const price = parseCzechNumber(el.textContent);
      if (price !== null) {
        return { price, priceFormatted: formatCzechPrice(price) };
      }
    }
  }

  // Strategy 4: Regex fallbacks
  const pricePatterns = [
    /(\d[\d\s]*\d)\s*Kč/,
    /(\d[\d\s]*\d),[-–]\s*Kč/,
    /(\d[\d\s,.]*\d)\s*CZK/,
  ];
  for (const pattern of pricePatterns) {
    const match = html.match(pattern);
    if (match) {
      const price = parseCzechNumber(match[1]);
      if (price !== null) {
        return { price, priceFormatted: formatCzechPrice(price) };
      }
    }
  }

  return null;
}

function parseProductName(html: string): string {
  const root = parseHTML(html);

  const clean = (name: string): string =>
    name
      .replace(/\s*\|\s*Alza\.\w+$/i, "")
      .replace(/\s+za\s+[\d\s\u00a0]+K[čc]/i, "")
      .replace(/\s+-\s+[^-]+$/, "")
      .trim();

  const ogTitle = root.querySelector('meta[property="og:title"]');
  if (ogTitle) {
    const content = ogTitle.getAttribute("content")?.trim();
    if (content) return clean(content);
  }

  const title = root.querySelector("title");
  if (title) {
    const text = title.textContent.trim();
    if (text) return clean(text);
  }

  const h1 = root.querySelector("h1");
  if (h1) return h1.textContent.trim();

  return "Unknown Product";
}

function parseCzechNumber(text: string): number | null {
  if (!text) return null;
  const cleaned = text
    .replace(/Kč|CZK|&nbsp;/gi, "")
    .replace(/\s/g, "")
    .replace(/,/g, ".")
    .replace(/[-–]$/, "")
    .trim();
  if (!cleaned) return null;
  const num = parseFloat(cleaned);
  return !isNaN(num) && num > 0 ? num : null;
}

function formatCzechPrice(price: number): string {
  const formatted = price.toLocaleString("cs-CZ", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  return `${formatted} Kč`;
}

async function waitForCloudflare(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const t = document.title.toLowerCase();
      return !t.includes("just a moment") && !t.includes("okamžik");
    },
    undefined,
    { timeout: CF_TIMEOUT }
  );
}

function humanDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function closeBrowser(): Promise<void> {
  for (const [, session] of sessions) {
    await session.verifyPage?.close().catch(() => {});
    await session.context?.close().catch(() => {});
  }
  sessions.clear();
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
  if (chromeProcess) {
    chromeProcess.kill();
    chromeProcess = null;
  }
}
