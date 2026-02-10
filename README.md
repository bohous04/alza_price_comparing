# Alza.cz Multi-Account Price Comparison API

Self-hosted API that compares product prices across multiple Alza.cz accounts. Useful for seeing different prices due to loyalty programs, business discounts, or promotional offers.

## Setup

1. Copy the example env file and fill in your credentials:

```bash
cp .env.example .env
```

2. Install dependencies and run:

```bash
bun install
bun run dev
```

## Docker

```bash
docker compose up -d
```

## API

### `GET /health`

Returns `{ "status": "ok" }`.

### `GET /compare?url={alza_product_url}`

Requires `Authorization: Bearer {API_KEY}` header.

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" \
  "http://localhost:3000/compare?url=https://www.alza.cz/iphone-16-pro-d12345.htm"
```

Response:

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

## Configuration

Accounts are configured via environment variables with numbered prefixes:

```
ALZA_ACC1_EMAIL=...
ALZA_ACC1_PASSWORD=...
ALZA_ACC1_LABEL=Personal
ALZA_ACC2_EMAIL=...
ALZA_ACC2_PASSWORD=...
ALZA_ACC2_LABEL=Business
```

Add as many accounts as needed by incrementing the number.

## iPhone Shortcut

1. Create a new Shortcut
2. Add "Get Contents of URL" action
3. Set URL to `https://your-server/compare?url=` + Shortcut Input (the shared Alza URL)
4. Add Header: `Authorization: Bearer YOUR_API_KEY`
5. Parse the JSON response and display the comparison

## Limitations

- 2FA-enabled accounts are not supported
- Alza may rate-limit or CAPTCHA repeated logins (sessions are cached for 10 minutes)
- HTML structure changes may require updates to price parsing strategies
- For personal use only — respect Alza's Terms of Service
