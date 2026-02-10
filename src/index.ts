import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { loadConfig } from "./config.js";
import { initLogin, submitVerificationCode, getSessionStatus, scrapePrice } from "./scraper.js";
import type { AccountResult, CompareResponse, ErrorResponse, AuthInitResponse } from "./types.js";

const config = loadConfig();

const app = new Hono();

// Auth middleware for protected endpoints
import type { Context, Next } from "hono";

const authMiddleware = async (c: Context, next: Next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json(
      { error: "UNAUTHORIZED", message: "Invalid or missing API key" },
      401
    );
  }
  if (authHeader.slice(7) !== config.apiKey) {
    return c.json(
      { error: "UNAUTHORIZED", message: "Invalid or missing API key" },
      401
    );
  }
  await next();
};

app.use("/compare", authMiddleware);
app.use("/auth/*", authMiddleware);

// Health check
app.get("/health", (c) => {
  return c.json({ status: "ok" });
});

// Auth: get session status for all accounts
app.get("/auth/status", (c) => {
  const accounts = config.accounts.map((a) => getSessionStatus(a));
  return c.json({ accounts });
});

// Auth: initiate login for all accounts
app.post("/auth/init", async (c) => {
  console.log("Initiating login for all accounts (sequentially)...");

  // Login sequentially — accounts share one Chrome instance and
  // Cloudflare may rate-limit parallel attempts
  const accounts = [];
  for (const account of config.accounts) {
    try {
      const result = await initLogin(account, config);
      accounts.push(result);
    } catch (e) {
      accounts.push({
        label: account.label,
        status: "failed" as const,
        error: e instanceof Error ? e.message : "Unknown error",
      });
    }
  }

  const response: AuthInitResponse = { accounts };
  return c.json(response);
});

// Auth: submit SMS verification code
app.post("/auth/verify", async (c) => {
  const body = await c.req.json();
  const { label, code } = body;

  if (!label || !code) {
    return c.json<ErrorResponse>(
      { error: "BAD_REQUEST", message: "Missing label or code in request body" },
      400
    );
  }

  const account = config.accounts.find((a) => a.label === label);
  if (!account) {
    return c.json<ErrorResponse>(
      { error: "NOT_FOUND", message: `Account with label "${label}" not found` },
      404
    );
  }

  const result = await submitVerificationCode(account, code);
  return c.json(result);
});

// Price comparison
app.get("/compare", async (c) => {
  const url = c.req.query("url");

  if (!url) {
    return c.json<ErrorResponse>(
      { error: "INVALID_URL", message: "Missing url query parameter" },
      400
    );
  }

  try {
    new URL(url);
  } catch {
    return c.json<ErrorResponse>(
      { error: "INVALID_URL", message: "URL must be a valid URL" },
      400
    );
  }

  if (!url.includes("alza.cz")) {
    return c.json<ErrorResponse>(
      { error: "INVALID_URL", message: "URL must be from alza.cz" },
      400
    );
  }

  // Check if any accounts are logged in
  const statuses = config.accounts.map((a) => getSessionStatus(a));
  const loggedIn = statuses.filter((s) => s.status === "logged_in");
  if (loggedIn.length === 0) {
    const needsVerify = statuses.filter((s) => s.status === "verification_required");
    if (needsVerify.length > 0) {
      return c.json({
        error: "VERIFICATION_REQUIRED",
        message: "Accounts need SMS verification. Call POST /auth/verify with the code.",
        accounts: statuses,
      }, 428);
    }
    return c.json({
      error: "NO_SESSION",
      message: "No active sessions. Call POST /auth/init first.",
      accounts: statuses,
    }, 428);
  }

  console.log(`Comparing prices for: ${url}`);

  // Only fetch from logged-in accounts
  const activeAccounts = config.accounts.filter((a) => {
    const s = getSessionStatus(a);
    return s.status === "logged_in";
  });

  const results = await Promise.allSettled(
    activeAccounts.map((account) => scrapePrice(account, url))
  );

  let productName = "Unknown Product";
  const accounts: AccountResult[] = results.map((result, i) => {
    const account = activeAccounts[i];

    if (result.status === "fulfilled") {
      if (productName === "Unknown Product") {
        productName = result.value.product;
      }
      return {
        label: account.label,
        price: result.value.price,
        priceFormatted: result.value.priceFormatted,
        available: true as const,
      };
    }

    const errorMessage =
      result.reason instanceof Error ? result.reason.message : "Unknown error";
    console.error(`Failed to scrape for ${account.label}: ${errorMessage}`);

    return {
      label: account.label,
      price: null,
      priceFormatted: null,
      available: false as const,
      error: errorMessage,
    };
  });

  const availableResults = accounts.filter(
    (a): a is AccountResult & { available: true } => a.available
  );

  let cheapest: string | null = null;
  let difference: number | null = null;
  let differenceFormatted: string | null = null;

  if (availableResults.length > 0) {
    const sorted = [...availableResults].sort((a, b) => a.price - b.price);
    cheapest = sorted[0].label;

    if (sorted.length >= 2) {
      difference = sorted[sorted.length - 1].price - sorted[0].price;
      differenceFormatted = `${difference.toLocaleString("cs-CZ")} Kč`;
    }
  }

  const response: CompareResponse = {
    product: productName,
    url,
    accounts,
    cheapest,
    difference,
    differenceFormatted,
  };

  return c.json(response);
});

serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(`Server running on port ${config.port}`);
});
