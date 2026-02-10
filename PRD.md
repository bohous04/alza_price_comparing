# Alza.cz – Multi-Account Price Comparison API

## PRD (Product Requirements Document)

### Problem
Users with multiple Alza.cz accounts (e.g. personal + business) may see different prices for the same product due to loyalty programs, business discounts, or promotional offers. There's no easy way to compare prices across accounts without manually logging in and out.

### Solution
A self-hosted API that accepts an Alza.cz product URL, logs into multiple configured accounts, scrapes the product price from each, and returns a JSON comparison. Designed to be called from an iPhone Shortcut, browser extension, or any HTTP client.

### Architecture
- **Backend:** Node.js + TypeScript + Hono (lightweight HTTP framework)
- **Scraping:** Login via Alza's authentication endpoint, fetch product page with session cookies, parse price from HTML
- **Config:** All sensitive data (credentials, API key) via `.env` file
- **Deployment:** Docker container (Coolify / Docker Compose / any container platform)
- **Client:** iPhone Shortcut, curl, or any HTTP client

---

### API Endpoints

#### `GET /health`
Health check endpoint.

**Response (200)**
```json
{ "status": "ok" }
```

#### `GET /compare?url={alza_product_url}`
Compare product price across all configured accounts.

**Headers:**
```
Authorization: Bearer {API_KEY}
```

**Response (200)**
```json
{
  "product": "iPhone 16 Pro 256GB",
  "url": "https://www.alza.cz/iphone-16-pro-d12345.htm",
  "accounts": [
    {
      "label": "Personal",
      "price": 29990,
      "priceFormatted": "29 990 Kč",
      "available": true
    },
    {
      "label": "Business",
      "price": 28490,
      "priceFormatted": "28 490 Kč",
      "available": true
    }
  ],
  "cheapest": "Business",
  "difference": 1500,
  "differenceFormatted": "1 500 Kč"
}
```

**Error Responses:**
```json
{ "error": "INVALID_URL", "message": "URL must be from alza.cz" }
{ "error": "UNAUTHORIZED", "message": "Invalid or missing API key" }
{ "error": "SCRAPE_FAILED", "message": "Could not extract price from account: Personal" }
```

---

### Configuration

All configuration is done via environment variables (`.env` file).

The app supports a dynamic number of accounts using a numbered naming convention:

```env
# Account 1
ALZA_ACC1_EMAIL=your@email.com
ALZA_ACC1_PASSWORD=your-password
ALZA_ACC1_LABEL=Personal

# Account 2
ALZA_ACC2_EMAIL=your-second@email.com
ALZA_ACC2_PASSWORD=your-second-password
ALZA_ACC2_LABEL=Business

# Add more accounts by incrementing the number:
# ALZA_ACC3_EMAIL=...
# ALZA_ACC3_PASSWORD=...
# ALZA_ACC3_LABEL=...

# API Security
API_KEY=generate-a-random-string-here

# Server
PORT=3000
```

The app should parse env vars on startup, dynamically detecting all `ALZA_ACCn_*` groups (n = 1, 2, 3, ...). It must validate that each account group has all three fields (EMAIL, PASSWORD, LABEL) and fail fast on startup if any are missing. Minimum 1 account required.

---

### Implementation Requirements

1. **Account config loader:** On startup, scan env vars for `ALZA_ACC{n}_EMAIL/PASSWORD/LABEL` pattern. Collect all valid account groups into an array. Validate completeness, log how many accounts were loaded.

2. **Login flow:** Alza uses a POST request to `https://www.alza.cz/Services/EShopService.svc/LoginUser` with JSON body `{ userName, password }`. The response sets session cookies that must be captured and forwarded with subsequent requests.

3. **Isolated cookie jars:** Each account login MUST use its own cookie store so sessions don't leak between accounts. Use `tough-cookie` or manual `Set-Cookie` / `Cookie` header management.

4. **Price parsing:** Extract product price from the HTML page. Use multiple fallback strategies in order:
   - JSON-LD structured data (`application/ld+json` script tags → `offers.price`)
   - `data-price` attribute
   - Meta tags (`og:price:amount` etc.)
   - CSS class-based selectors (`.price-box__price`, `.c2` etc.)
   - Regex fallbacks for common Alza price patterns
   
   Price must be returned as a number (float). Parse Czech formatting (spaces as thousand separators, comma as decimal separator).

5. **Product name parsing:** Extract from `og:title` meta tag, falling back to `<title>` tag (strip " | Alza.cz" suffix), then `<h1>`.

6. **Parallel fetching:** Use `Promise.allSettled()` to fetch all accounts in parallel. If one account fails, still return results from the others (mark failed ones with `available: false` and an error message).

7. **Comparison logic:** After collecting all prices, determine the cheapest account and calculate the difference between cheapest and most expensive.

8. **Auth middleware:** Simple Bearer token validation against `API_KEY` env var. Applied to `/compare` endpoint only (not `/health`).

9. **Error handling:** Validate URL format (must contain `alza.cz`), handle login failures gracefully, set reasonable timeouts (15s per request), catch and wrap all errors into consistent JSON error responses.

10. **Logging:** Basic console logging for requests, login attempts (no passwords), and errors.

11. **Docker:** Multi-stage Dockerfile (install deps + build → copy dist to slim runtime image). Include `docker-compose.yml` with env_file reference.

---

### Risks & Limitations
- Alza may rate-limit or CAPTCHA repeated logins → consider short-lived session caching (5–10 min TTL)
- 2FA-enabled accounts won't work with password login → document as known limitation
- HTML structure may change over time → price parsing strategies need periodic updates
- This tool is for personal use / comparison only; respect Alza's ToS

---

### File Structure
```
alza-price-compare/
├── src/
│   ├── index.ts          # Hono server, routing, auth middleware
│   ├── config.ts         # Env var parsing, account loader, validation
│   ├── scraper.ts        # Login + fetch + price parsing logic
│   └── types.ts          # TypeScript type definitions
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── .gitignore            # Must include .env
├── package.json
├── tsconfig.json
└── README.md             # Setup instructions, API docs, Shortcut guide
```
