# ViceBank — Chrome Extension (MV3) + Stripe Backend (MVP)

**What this is**
- A working Chrome Extension that monitors Porn/Gambling domains, enforces a daily grace (0–3 min/category), and charges per-minute past grace using **Stripe Billing metered usage**.
- A minimal Node/Express backend wired to Stripe for **real invoices** (no CSV exports).

## Quickstart

### 1) Stripe setup
- Create two **metered** prices in Stripe:
  - `STRIPE_PRICE_PORN`  (e.g., product "ViceBank Porn Minutes")
  - `STRIPE_PRICE_GAMBLING` (e.g., product "ViceBank Gambling Minutes")
- Copy their `price_...` IDs.
- Create a webhook endpoint in Stripe (events: `invoice.paid`, `invoice.finalized`, `customer.subscription.*`, `charge.dispute.created`).
- Copy the Webhook Signing Secret.

### 2) Backend
```bash
cd backend
cp .env.example .env
# Fill in STRIPE_SECRET_KEY, STRIPE_PRICE_PORN, STRIPE_PRICE_GAMBLING, STRIPE_WEBHOOK_SECRET
npm i
npm run dev
```

This starts the API at `http://localhost:4242`.

### 3) Extension
- In `extension/options/options.html` set the backend URL if different (defaults to `http://localhost:4242`).
- Load the unpacked extension:
  - Chrome → `chrome://extensions` → Enable **Developer mode** → **Load unpacked** → choose `extension/` folder.
- On first run, the options (consent) page opens:
  - Check all boxes → set grace and rates → **Agree & Continue**.
  - You’ll be redirected to Stripe Billing Portal to add a card.
- Browse target sites. After grace is used, you’ll see an intercept modal with **Continue Paid** / **Stop & Leave**.
- Minutes billed are reported to Stripe usage records in real time (1/min).

## Notes
- Storage is local; daily counters reset at your local midnight.
- This demo backend keeps users & consents **in-memory**. Swap for Postgres/Prisma in production.
- We **never** record page content—only domain & minutes for billing.
- Badge text shows the number of paid minutes **today** (current category).

## Files
- `extension/manifest.json` — MV3 manifest
- `extension/background/service_worker.js` — timers, detection, billing calls
- `extension/content/intercept.js` — in-page modal
- `extension/options/*` — consent & settings
- `extension/popup/*` — dashboard
- `backend/server.js` — minimal Stripe integration

