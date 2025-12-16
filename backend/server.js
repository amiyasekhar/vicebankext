/**
 * ViceBank Backend — Weekly Settlement (In-Memory, CommonJS)
 * ----------------------------------------------------------
 * - Tracks per-user daily usage by category/domain via /api/track
 * - Applies daily grace per category, sums billable whole minutes over a week
 * - Charges once per week (1 PaymentIntent) with rollover if < $0.50
 *
 * ENV:
 *   STRIPE_SECRET_KEY=sk_test_...
 *   STRIPE_WEBHOOK_SECRET=whsec_...        (optional)
 *   PORT=4242
 */

import "dotenv/config";
import express from "express";
import morgan from "morgan";
import cors from "cors";
import Stripe from "stripe";
import bodyParser from "body-parser";
import path from "path";
import fs from "fs";
import os from "os";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* -------------------- local usage logging (append-only) -------------------- */
const VICEBANK_LOG_FILE =
  process.env.VICEBANK_LOG_FILE ||
  path.join(__dirname, "logs", "vicebank_usage.log");

function ensureLogDir() {
  const dir = path.dirname(VICEBANK_LOG_FILE);
  fs.mkdirSync(dir, { recursive: true });
}

function appendLogLine(obj) {
  try {
    ensureLogDir();
    fs.appendFileSync(VICEBANK_LOG_FILE, JSON.stringify(obj) + os.EOL, "utf8");
  } catch (e) {
    console.warn("[vicebank] failed to write usage log:", e?.message || e);
  }
}

/* -------------------- bootstrap -------------------- */
const app = express();
app.use(cors());
app.use(morgan("dev"));

// IMPORTANT: Stripe webhook must see the raw body.
// Register the webhook route BEFORE express.json().
const stripeSecret = process.env.STRIPE_SECRET_KEY || "";
console.log("stripe key ", stripeSecret);
let stripe = null;
if (stripeSecret) {
  stripe = new Stripe(stripeSecret);
  // stripe = new Stripe(stripeSecret, { apiVersion: "2024-10-28" });
} else {
  console.warn(
    "[vicebank] STRIPE_SECRET_KEY not set. Weekly settlement disabled."
  );
}

app.use((req, res, next) => {
  if (req.originalUrl === "/api/webhook") return next();
  express.json()(req, res, next);
});

app.post(
  "/api/webhook",
  bodyParser.raw({ type: "application/json" }), // Must be raw for Stripe signature verification
  async (req, res) => {
    console.log("[Webhook HIT]");
    console.log("Headers:", req.headers);
    console.log("Raw body:", req.body.toString()); // Buffer → string

    if (!stripe)
      return res.status(200).json({ received: true, disabled: true });

    const sig = req.headers["stripe-signature"];
    let event;
    console.log("secret = ", process.env.STRIPE_WEBHOOK_SECRET);
    try {
      if (process.env.STRIPE_WEBHOOK_SECRET) {
        // Production/verification mode
        event = stripe.webhooks.constructEvent(
          req.body, // raw Buffer
          sig, // stripe-signature header
          process.env.STRIPE_WEBHOOK_SECRET
        );
      } else {
        // Local dev: skip signature verification
        event = JSON.parse(req.body.toString());
        console.log(
          "[Webhook] STRIPE_WEBHOOK_SECRET not set; skipping signature verification."
        );
      }

      // ===== Handle events =====
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;
          const userId = session.metadata.userId;
          const customerId = session.customer;
          const snap = consents.get(userId) || {};
          consents.set(userId, { ...snap, customerId });
          console.log(`[Webhook] Saved customerId for user ${userId}`);
          break;
        }
        case "setup_intent.succeeded": {
          const setupIntent = event.data.object;
          const userId = setupIntent.metadata.userId;
          const customerId = setupIntent.customer;
          const paymentMethodId = setupIntent.payment_method;

          // Attach payment method
          await stripe.paymentMethods.attach(paymentMethodId, {
            customer: customerId,
          });

          // Make it default
          await stripe.customers.update(customerId, {
            invoice_settings: { default_payment_method: paymentMethodId },
          });

          const snap = consents.get(userId) || {};
          consents.set(userId, { ...snap, customerId, paymentMethodId });
          console.log(`[Webhook] SetupIntent succeeded for user ${userId}`);
          break;
        }
        default:
          console.log(`[Webhook] Unhandled event type: ${event.type}`);
      }

      return res.json({ received: true, type: event.type });
    } catch (err) {
      console.error("[Webhook Error]", err);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
  }
);

// JSON body parser for the rest
app.use(express.json({ type: "*/*" }));

// (optional) static for a landing preview
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

/* -------------------- small utils -------------------- */
function dayKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
} // YYYY-MM-DD
function keyUserDay(userId, ts = Date.now()) {
  return `${userId}::${dayKey(ts)}`;
}
function hostFromUrlSafe(u) {
  try {
    return new URL(u).hostname?.toLowerCase() || null;
  } catch {
    return null;
  }
}
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* -------------------- in-memory stores -------------------- */
// Replace with Firestore/SQL later
const consents = new Map(); // userId -> { grace, rates, categoriesOn, ... }
const sessions = new Map(); // sessionId -> { userId, startedAt, lastSeenAt, ... }
const counters = new Map(); // key(userId,day) -> { updatedAt, byCategory, byDomain }
const weeklyRolloversCents = new Map(); // userId -> cents (carry forward)

/* -------------------- categorization (robust) -------------------- */
const PORN_SEEDS = [
  "porn",
  "xvideos",
  "xnxx",
  "xhamster",
  "redtube",
  "pornhub",
  "brazzers",
  "onlyfans",
];
const GAMBLING_SEEDS = [
  "stake",
  "rollbit",
  "bet365",
  "pokerstars",
  "draftkings",
  "fanduel",
  "1xbet",
  "betway",
];

function makeDomainRegex(seeds) {
  const body = seeds.map(escapeRe).join("|");
  return new RegExp(`(?:^|\\.)(${body})\\.[a-z0-9.-]+$`, "i"); // matches sub.seed.tld or seed.tld
}

const CATEGORY_RULES = [
  { category: "porn", regex: makeDomainRegex(PORN_SEEDS) },
  { category: "gambling", regex: makeDomainRegex(GAMBLING_SEEDS) },
];

function categorizeDomain(host) {
  if (!host) return null;
  const h = host.toLowerCase().replace(/^www\./, "");
  for (const r of CATEGORY_RULES) {
    if (r.regex instanceof RegExp && r.regex.test(h)) return r.category;
    if (typeof r.test === "function" && r.test(h)) return r.category; // future-proof
  }
  return null;
}

/* -------------------- counters -------------------- */
function ensureCounterBucket(userId, ts = Date.now()) {
  const k = keyUserDay(userId, ts);
  if (!counters.has(k)) {
    counters.set(k, {
      updatedAt: ts,
      byCategory: {
        porn: { minutes: 0, seconds: 0 },
        gambling: { minutes: 0, seconds: 0 },
      },
      byDomain: {}, // domain -> { seconds, category }
    });
  }
  return counters.get(k);
}

function addUsage({ userId, domain, category, seconds, ts = Date.now() }) {
  if (!userId || !domain || !category || !seconds) return;
  const bucket = ensureCounterBucket(userId, ts);
  bucket.updatedAt = ts;

  // domain-level
  if (!bucket.byDomain[domain])
    bucket.byDomain[domain] = { seconds: 0, category };
  bucket.byDomain[domain].seconds += seconds;

  // category-level (seconds carry into whole minutes)
  const cat =
    bucket.byCategory[category] ||
    (bucket.byCategory[category] = { minutes: 0, seconds: 0 });
  cat.seconds += seconds;
  if (cat.seconds >= 60) {
    cat.minutes += Math.floor(cat.seconds / 60);
    cat.seconds = cat.seconds % 60;
  }
}

/* -------------------- consent (dispute defense) -------------------- */
function getConsentSnapshot(userId) {
  const snap = consents.get(userId) || {};
  // Grace should be per-category. Older clients may send a number; normalize.
  let grace = snap.grace;
  if (typeof grace === "number") grace = { porn: grace, gambling: grace };
  grace = grace || { porn: 1, gambling: 0 }; // minutes per day (defaults)
  const rates = snap.rates || { porn: 0.05, gambling: 0.5 }; // $/min (defaults)
  const categoriesOn = snap.categoriesOn || { porn: true, gambling: true };
  return { grace, rates, categoriesOn };
}

app.post("/api/consent", (req, res) => {
  const { userId, extensionVersion, grace, rates, categoriesOn, tosHash } =
    req.body || {};
  if (!userId) return res.status(400).json({ error: "userId required" });

  consents.set(userId, {
    ts: Date.now(),
    ip: req.ip,
    ua: req.get("user-agent"),
    extensionVersion,
    grace,
    rates,
    categoriesOn,
    tosHash,
  });

  return res.json({ ok: true });
});

/* -------------------- health + demo pages -------------------- */
app.get("/", (_req, res) =>
  res.json({ ok: true, service: "vicebank-backend-direct" })
);
app.get("/landing", (_req, res) =>
  res.sendFile(path.join(publicDir, "landing.html"))
);
app.get("/landing-dynamic", (_req, res) =>
  res.sendFile(path.join(publicDir, "landing-dynamic.html"))
);
app.get("/dashboard", (_req, res) =>
  res.sendFile(path.join(publicDir, "dashboard.html"))
);

app.post("/api/stripe/setup-intent", async (req, res) => {
  if (!stripe)
    return res
      .status(500)
      .json({ error: "Stripe not configured. Set STRIPE_SECRET_KEY." });

  try {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: "userId required" });

    // Create SetupIntent so user can add a payment method without charging
    const setupIntent = await stripe.setupIntents.create({
      payment_method_types: ["card"],
      metadata: { userId },
    });

    return res.json({ clientSecret: setupIntent.client_secret });
  } catch (err) {
    console.error("Failed to create SetupIntent:", err);
    return res.status(400).json({ error: String(err.message) });
  }
});

// Create a Stripe Checkout Session (for adding a payment method)
app.post("/api/stripe/checkout-session", async (req, res) => {
  if (!stripe) return res.status(500).json({ error: "Stripe not configured" });

  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: "userId required" });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "setup", // user is adding a payment method
      payment_method_types: ["card"],
      customer_creation: "always",
      success_url:
        "http://localhost:4242/checkout-success.html?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "http://localhost:4242/checkout-cancel.html",
      metadata: { userId },
    });

    console.log("session.intent", session.setup_intent);
    console.log("sesion.payment_status", session.payment_status);

    res.json({ url: session.url });
  } catch (err) {
    console.error("Checkout session failed:", err);
    res.status(400).json({ error: String(err.message) });
  }
});

app.post("/api/stripe/checkout-success", async (req, res) => {
  const { session_id } = req.body;
  if (!session_id)
    return res.status(400).json({ error: "session_id required" });

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ["setup_intent.payment_method"],
    });

    console.log("checkout session", session);

    const paymentMethodId = session.setup_intent?.payment_method?.id;
    const customerId = session.customer;
    const userId = session.metadata?.userId; // 🔹 get userId back

    if (!paymentMethodId || !customerId)
      return res.status(400).json({ error: "No payment method found" });

    // Attach payment method to customer
    await stripe.paymentMethods.attach(paymentMethodId, {
      customer: customerId,
    });

    // Set as default
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });

    // 🔹 Persist this in consents so getOrCreateCustomer() can find it later
    if (userId) {
      const snap = consents.get(userId) || {};
      consents.set(userId, {
        ...snap,
        customerId,
        paymentMethodId,
      });
      console.log(
        `[Checkout Success] Saved customerId/paymentMethodId for user ${userId}`
      );
    } else {
      console.warn(
        "[Checkout Success] No userId in session.metadata; cannot map customer to user"
      );
    }

    res.json({ ok: true, userId, customerId });
  } catch (err) {
    console.error("Checkout success processing failed:", err);
    res.status(500).json({ error: err.message });
  }
});

/* -------------------- session + tracking -------------------- */
app.post("/api/session/start", (req, res) => {
  const { userId, sessionId, extensionVersion, tzOffsetMinutes } =
    req.body || {};
  if (!userId || !sessionId)
    return res.status(400).json({ error: "userId and sessionId required" });

  const now = Date.now();
  sessions.set(sessionId, {
    userId,
    sessionId,
    startedAt: sessions.get(sessionId)?.startedAt ?? now,
    lastSeenAt: now,
    ua: req.get("user-agent"),
    ip: req.ip,
    extVer: extensionVersion,
    tzOffsetMinutes: Number.isFinite(tzOffsetMinutes)
      ? tzOffsetMinutes
      : undefined,
  });

  return res.json({
    ok: true,
    sessionId,
    userId,
    startedAt: sessions.get(sessionId).startedAt,
  });
});

app.post("/api/track", (req, res) => {
  const { userId, sessionId, events } = req.body || {};
  console.log("user id in backend = ", userId);
  console.log("session id in backend = ", sessionId);
  console.log("is events an array = ", Array.isArray(events));
  if (!userId || !sessionId || !Array.isArray(events)) {
    return res
      .status(400)
      .json({ error: "userId, sessionId, events[] required" });
  }
  const sess = sessions.get(sessionId);
  if (!sess || sess.userId !== userId) {
    return res.status(400).json({ error: "unknown or mismatched sessionId" });
  }

  let accepted = 0;
  const acceptedEvents = [];
  for (const ev of events) {
    if (!ev) continue;
    const ts = Number.isFinite(ev.ts) ? ev.ts : Date.now();
    const domain =
      (ev.domain || hostFromUrlSafe(ev.url))?.replace(/^www\./, "") || null;
    const category = ev.category || categorizeDomain(domain);
    const seconds = Number(ev.seconds) || 0;
    if (category && seconds > 0 && domain) {
      addUsage({ userId, domain, category, seconds, ts });
      accepted++;
      acceptedEvents.push({ ts, domain, category, seconds });
    }
  }

  sess.lastSeenAt = Date.now();
  const bucket = ensureCounterBucket(userId);

  // Append a durable log line for each /api/track tick
  try {
    const today = dayKey(); // UTC day string
    const daily = computeDailyBillable({ userId, dayStr: today });

    // "Wallet" preview (weekly billable + rollover). Uses session tzOffset if present.
    const tzOffsetMinutes = Number(sess?.tzOffsetMinutes ?? 0);
    const { weekStartUTC, weekEndUTC, weekStartStr, weekEndStr } = getWeekBounds({
      tzOffsetMinutes,
    });
    const { totalCents } = collectWeeklyBillableMinutes({
      userId,
      weekStartUTC,
      weekEndUTC,
      tzOffsetMinutes,
    });
    const rollover = weeklyRolloversCents.get(userId) || 0;

    // Make grace-vs-billable explicit (per day, per category)
    const minutes = daily?.minutes || {};
    const billableMinutes = daily?.billableMinutes || {};
    const graceAppliedMinutesByCategory = {
      porn: Math.max(0, Number(minutes.porn || 0) - Number(billableMinutes.porn || 0)),
      gambling: Math.max(
        0,
        Number(minutes.gambling || 0) - Number(billableMinutes.gambling || 0)
      ),
    };

    appendLogLine({
      ts: new Date().toISOString(),
      userId,
      sessionId,
      day: today,
      weekStart: weekStartStr,
      weekEnd: weekEndStr,
      accepted,
      events: acceptedEvents,
      graceAppliedMinutesByCategory,
      graceAppliedMinutes:
        (graceAppliedMinutesByCategory.porn || 0) +
        (graceAppliedMinutesByCategory.gambling || 0),
      todayBillableCents: daily.billableCents,
      walletCents: totalCents + rollover,
      rolloverCents: rollover,
      byCategory: bucket.byCategory,
      topDomain: Object.entries(bucket.byDomain)
        .sort((a, b) => b[1].seconds - a[1].seconds)
        .slice(0, 1)
        .map(([d, v]) => ({ domain: d, seconds: v.seconds, category: v.category }))[0] || null,
    });
  } catch (e) {
    console.warn("[vicebank] log tick error:", e?.message || e);
  }

  return res.json({
    ok: true,
    accepted,
    snapshot: {
      day: dayKey(),
      byCategory: bucket.byCategory,
      topDomains: Object.entries(bucket.byDomain)
        .sort((a, b) => b[1].seconds - a[1].seconds)
        .slice(0, 10)
        .map(([d, v]) => ({
          domain: d,
          seconds: v.seconds,
          category: v.category,
        })),
    },
  });
});

app.post("/api/session/stop", (req, res) => {
  const { userId, sessionId } = req.body || {};
  const sess = sessions.get(sessionId);
  if (!sess || sess.userId !== userId) {
    return res.status(400).json({ error: "unknown or mismatched sessionId" });
  }
  sessions.set(sessionId, { ...sess, stoppedAt: Date.now() });
  return res.json({
    ok: true,
    sessionId,
    stoppedAt: sessions.get(sessionId).stoppedAt,
  });
});

app.get("/api/counters/today", (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: "userId required" });
  const bucket = ensureCounterBucket(userId);
  return res.json({
    ok: true,
    day: dayKey(),
    updatedAt: bucket.updatedAt,
    byCategory: bucket.byCategory,
    byDomain: bucket.byDomain,
  });
});

/* -------------------- dashboard stats -------------------- */
function daysAgoUTCStr(daysAgo = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

function getBucketByDay(userId, dayStr) {
  const k = `${userId}::${dayStr}`;
  return counters.get(k) || null;
}

function computeDailyBillable({ userId, dayStr }) {
  const { grace, rates, categoriesOn } = getConsentSnapshot(userId);
  const bucket = getBucketByDay(userId, dayStr);
  if (!bucket) return { exists: false, billableCents: 0, minutes: {}, billableMinutes: {} };

  const minutes = {};
  const billableMinutes = {};
  let billableCents = 0;

  for (const cat of ["porn", "gambling"]) {
    const m = Number(bucket?.byCategory?.[cat]?.minutes || 0);
    minutes[cat] = m;

    if (!categoriesOn?.[cat]) {
      billableMinutes[cat] = 0;
      continue;
    }

    const g = Math.max(0, Number(grace?.[cat] ?? 0));
    const billable = Math.max(0, m - g);
    billableMinutes[cat] = billable;

    const configured = Number(rates?.[cat] ?? 0);
    const dollarsPerMin = Math.max(CATEGORY_FLOORS[cat] ?? 0, configured);
    const centsPerMin = Math.round(dollarsPerMin * 100);
    billableCents += billable * centsPerMin;
  }

  return { exists: true, billableCents, minutes, billableMinutes };
}

function computeStreakDays(userId, { maxLookbackDays = 365 } = {}) {
  // Consecutive days ending today with 0 billable minutes (after grace).
  let streak = 0;
  for (let i = 0; i < maxLookbackDays; i++) {
    const dayStr = daysAgoUTCStr(i);
    const d = computeDailyBillable({ userId, dayStr });
    if (!d.exists) break; // no data -> streak breaks (conservative)
    if (d.billableCents > 0) break;
    streak++;
  }
  return streak;
}

function parseYYYYMMDDToUTC(dayStr) {
  // dayStr: YYYY-MM-DD
  return new Date(dayStr + "T00:00:00.000Z");
}

function addDaysUTC(dayStr, days) {
  const d = parseYYYYMMDDToUTC(dayStr);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function listUserDays(userId) {
  // returns sorted ascending YYYY-MM-DD for days that exist in counters
  const days = [];
  for (const key of counters.keys()) {
    const idx = key.lastIndexOf("::");
    if (idx < 0) continue;
    const uid = key.slice(0, idx);
    if (uid !== userId) continue;
    const day = key.slice(idx + 2);
    if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) days.push(day);
  }
  days.sort();
  return days;
}

function computeStreakStats(userId) {
  const days = listUserDays(userId);
  const byDay = new Map(); // day -> { exists, billableCents }
  for (const day of days) {
    const d = computeDailyBillable({ userId, dayStr: day });
    byDay.set(day, d);
  }

  let totalDaysWithData = days.length;
  let totalCleanDays = 0;
  for (const day of days) {
    const d = byDay.get(day);
    if (d?.exists && (d.billableCents || 0) === 0) totalCleanDays++;
  }

  // Build clean streak runs (consecutive days with exists + billableCents==0)
  const runs = []; // { start, end, length }
  let cur = null;
  for (const day of days) {
    const d = byDay.get(day);
    const isClean = d?.exists && (d.billableCents || 0) === 0;
    if (!isClean) {
      if (cur) runs.push(cur);
      cur = null;
      continue;
    }

    if (!cur) {
      cur = { start: day, end: day, length: 1 };
      continue;
    }

    const expected = addDaysUTC(cur.end, 1);
    if (day === expected) {
      cur.end = day;
      cur.length += 1;
    } else {
      // gap breaks streak
      runs.push(cur);
      cur = { start: day, end: day, length: 1 };
    }
  }
  if (cur) runs.push(cur);

  // Current streak run is the run whose end is "today" (UTC) if today exists+clean
  const today = dayKey(); // UTC day string used by counters
  const todayData = computeDailyBillable({ userId, dayStr: today });
  const currentStreakDays =
    todayData.exists && (todayData.billableCents || 0) === 0
      ? (runs.find((r) => r.end === today)?.length || 0)
      : 0;

  // Last streak: the most recent run BEFORE the current streak (if current streak exists),
  // otherwise the most recent run overall.
  let lastRun = null;
  if (runs.length > 0) {
    if (currentStreakDays > 0) {
      // find index of current run and pick previous
      const idx = runs.findIndex((r) => r.end === today);
      lastRun = idx > 0 ? runs[idx - 1] : null;
    } else {
      lastRun = runs[runs.length - 1];
    }
  }

  // Break day: the first billable day after lastRun.end (only if that day exists and is billable)
  let lastBreakDay = null;
  if (lastRun) {
    const candidate = addDaysUTC(lastRun.end, 1);
    const candData = byDay.get(candidate) || computeDailyBillable({ userId, dayStr: candidate });
    if (candData?.exists && (candData.billableCents || 0) > 0) lastBreakDay = candidate;
  }

  return {
    totalDaysWithData,
    totalCleanDays,
    currentStreakDays,
    lastStreak: lastRun ? { length: lastRun.length, start: lastRun.start, end: lastRun.end } : null,
    lastBreakDay,
  };
}

app.get("/api/dashboard", (req, res) => {
  const userId = req.query.userId?.toString();
  if (!userId) return res.status(400).json({ error: "userId required" });

  const tzOffsetMinutes = Number(req.query.tzOffsetMinutes ?? 0);
  const { weekStartUTC, weekEndUTC, weekStartStr, weekEndStr } = getWeekBounds({
    tzOffsetMinutes,
  });
  const { perCat, totalCents } = collectWeeklyBillableMinutes({
    userId,
    weekStartUTC,
    weekEndUTC,
    tzOffsetMinutes,
  });
  const rollover = weeklyRolloversCents.get(userId) || 0;
  const wouldChargeCents = totalCents + rollover >= STRIPE_MIN_CENTS ? totalCents + rollover : 0;
  const wouldCarryCents = totalCents + rollover < STRIPE_MIN_CENTS ? totalCents + rollover : 0;

  const streakStats = computeStreakStats(userId);

  const lastDays = [];
  for (let i = 13; i >= 0; i--) {
    const dayStr = daysAgoUTCStr(i);
    const d = computeDailyBillable({ userId, dayStr });
    const status = !d.exists ? "no_data" : d.billableCents > 0 ? "billable" : "clean";
    lastDays.push({
      day: dayStr,
      status,
      billableCents: d.billableCents,
      minutes: d.minutes,
      billableMinutes: d.billableMinutes,
    });
  }

  return res.json({
    ok: true,
    userId,
    wallet: {
      weekStart: weekStartStr,
      weekEnd: weekEndStr,
      perCategory: perCat,
      totalCents,
      rolloverCents: rollover,
      wouldChargeCents,
      wouldCarryCents,
    },
    streak: {
      days: streakStats.currentStreakDays,
      totalCleanDays: streakStats.totalCleanDays,
      totalDaysWithData: streakStats.totalDaysWithData,
      lastStreak: streakStats.lastStreak,
      lastBreakDay: streakStats.lastBreakDay,
      last14: lastDays,
    },
  });
});

/* -------------------- weekly settlement -------------------- */
const STRIPE_MIN_CENTS = 50;
const CATEGORY_FLOORS = { porn: 0.05, gambling: 0.5 }; // $/min floors

async function getOrCreateCustomer(userId) {
  if (!stripe) throw new Error("Stripe not configured");
  let snap = consents.get(userId);
  if (snap?.customerId) {
    return snap.customerId;
  }

  const customer = await stripe.customers.create({
    metadata: { userId },
  });
  consents.set(userId, { ...snap, customerId: customer.id });
  return customer.id;
}

function parseUserIdAndDay(key) {
  const idx = key.lastIndexOf("::");
  if (idx < 0) return { userId: null, day: null };
  return { userId: key.slice(0, idx), day: key.slice(idx + 2) };
}

// Local-time-aware ISO week bounds (Mon–Sun); weekEndStr optional (YYYY-MM-DD)
function getWeekBounds({ weekEndStr, tzOffsetMinutes = 0 }) {
  const toLocalMidnightUTC = (d) => {
    const shifted = new Date(d.getTime() + tzOffsetMinutes * 60000);
    shifted.setHours(0, 0, 0, 0);
    return new Date(shifted.getTime() - tzOffsetMinutes * 60000);
  };
  const endDate = weekEndStr ? new Date(weekEndStr + "T00:00:00Z") : new Date();
  let endUTC = toLocalMidnightUTC(endDate);

  const local = new Date(endUTC.getTime() + tzOffsetMinutes * 60000);
  const dow = local.getDay(); // 0=Sun..6=Sat
  const daysToSunday = (7 - dow) % 7;
  const weekEndLocal = new Date(local);
  weekEndLocal.setDate(local.getDate() + daysToSunday);
  const weekStartLocal = new Date(weekEndLocal);
  weekStartLocal.setDate(weekEndLocal.getDate() - 6);

  weekStartLocal.setHours(0, 0, 0, 0);
  weekEndLocal.setHours(23, 59, 59, 999);

  const weekStartUTC = new Date(
    weekStartLocal.getTime() - tzOffsetMinutes * 60000
  );
  const weekEndUTC = new Date(weekEndLocal.getTime() - tzOffsetMinutes * 60000);

  const fmt = (d) => d.toISOString().slice(0, 10);
  return {
    weekStartUTC,
    weekEndUTC,
    weekStartStr: fmt(weekStartUTC),
    weekEndStr: fmt(weekEndUTC),
  };
}

function isDayInRange(dayStr, startUTC, endUTC, tzOffsetMinutes = 0) {
  const asLocalMidnightUTC = new Date(
    new Date(dayStr + "T00:00:00Z").getTime() - tzOffsetMinutes * 60000
  );
  return asLocalMidnightUTC >= startUTC && asLocalMidnightUTC <= endUTC;
}

// Sum weekly billable whole minutes per category (daily grace applied per day)
function collectWeeklyBillableMinutes({
  userId,
  weekStartUTC,
  weekEndUTC,
  tzOffsetMinutes = 0,
}) {
  const { grace, rates, categoriesOn } = getConsentSnapshot(userId);
  const totalsMinutes = {}; // cat -> minutes

  for (const [key, bucket] of counters.entries()) {
    const { userId: uid, day } = parseUserIdAndDay(key);
    if (uid !== userId || !day) continue;
    if (!isDayInRange(day, weekStartUTC, weekEndUTC, tzOffsetMinutes)) continue;

    for (const [cat, v] of Object.entries(bucket.byCategory || {})) {
      if (!categoriesOn?.[cat]) continue;
      const wholeMins = Number(v?.minutes || 0);
      const g = Math.max(0, Number(grace?.[cat] ?? 0));
      const billable = Math.max(0, wholeMins - g);
      totalsMinutes[cat] = (totalsMinutes[cat] || 0) + billable;
    }
  }

  const perCat = {};
  let totalCents = 0;
  for (const [cat, mins] of Object.entries(totalsMinutes)) {
    const configured = Number(rates?.[cat] ?? 0);
    const dollarsPerMin = Math.max(CATEGORY_FLOORS[cat] ?? 0, configured);
    const centsPerMin = Math.round(dollarsPerMin * 100);
    const cents = centsPerMin * mins;
    perCat[cat] = { minutes: mins, centsPerMin, centsTotal: cents };
    totalCents += cents;
  }
  return { perCat, totalCents };
}

async function chargeWeeklyIfEligible({
  userId,
  weekStartStr,
  weekEndStr,
  perCat,
  totalCents,
  paymentMethodId,
}) {
  if (!stripe) throw new Error("Stripe not configured");

  const rollover = weeklyRolloversCents.get(userId) || 0;
  const grandTotal = totalCents + rollover;

  if (grandTotal < STRIPE_MIN_CENTS) {
    weeklyRolloversCents.set(userId, grandTotal);
    return {
      ok: true,
      charged: 0,
      carriedCents: grandTotal,
      reason: "below_minimum",
    };
  }

  const idemKey = `vb_weekly_${userId}_${weekStartStr}_${weekEndStr}_${grandTotal}`;
  const pm = paymentMethodId || "pm_card_visa";

  const meta = {};
  for (const [cat, v] of Object.entries(perCat)) {
    meta[`minutes_${cat}`] = String(v.minutes);
    meta[`centsPerMin_${cat}`] = String(v.centsPerMin);
    meta[`cents_${cat}`] = String(v.centsTotal);
  }
  if (rollover > 0) meta["cents_rollover_applied"] = String(rollover);

  const pi = await stripe.paymentIntents.create(
    {
      amount: grandTotal,
      currency: "usd",
      //payment_method: snap.customerId, //pm,
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      metadata: {
        userId,
        weekStart: weekStartStr,
        weekEnd: weekEndStr,
        reason: "ViceBank weekly settlement",
        ...meta,
      },
    },
    { idempotencyKey: idemKey }
  );

  weeklyRolloversCents.set(userId, 0);
  return {
    ok: true,
    charged: grandTotal,
    paymentIntentId: pi.id,
    status: pi.status,
  };
}

/* -------------------- weekly endpoints -------------------- */

// Preview (no charge)
app.get("/api/preview/week", (req, res) => {
  const userId = req.query.userId?.toString();
  if (!userId) return res.status(400).json({ error: "userId required" });

  const tzOffsetMinutes = Number(req.query.tzOffsetMinutes ?? 0);
  const { weekStartUTC, weekEndUTC, weekStartStr, weekEndStr } = getWeekBounds({
    weekEndStr: req.query.weekEnd?.toString(),
    tzOffsetMinutes,
  });

  const { perCat, totalCents } = collectWeeklyBillableMinutes({
    userId,
    weekStartUTC,
    weekEndUTC,
    tzOffsetMinutes,
  });
  const rollover = weeklyRolloversCents.get(userId) || 0;
  const withRollover = totalCents + rollover;

  return res.json({
    ok: true,
    weekStart: weekStartStr,
    weekEnd: weekEndStr,
    perCategory: perCat,
    totalCents,
    rolloverCents: rollover,
    wouldChargeCents: withRollover >= STRIPE_MIN_CENTS ? withRollover : 0,
    wouldCarryCents: withRollover < STRIPE_MIN_CENTS ? withRollover : 0,
  });
});

// Settle (charge once)
app.post("/api/settle/week", async (req, res) => {
  try {
    const {
      userId,
      weekEnd,
      tzOffsetMinutes = 0,
      paymentMethodId = null,
    } = req.body || {};
    if (!userId) return res.status(400).json({ error: "userId required" });
    if (!stripe)
      return res
        .status(500)
        .json({ error: "Stripe not configured. Set STRIPE_SECRET_KEY." });

    const { weekStartUTC, weekEndUTC, weekStartStr, weekEndStr } =
      getWeekBounds({ weekEndStr: weekEnd, tzOffsetMinutes });
    const { perCat, totalCents } = collectWeeklyBillableMinutes({
      userId,
      weekStartUTC,
      weekEndUTC,
      tzOffsetMinutes,
    });

    const result = await chargeWeeklyIfEligible({
      userId,
      weekStartStr,
      weekEndStr,
      perCat,
      totalCents,
      paymentMethodId,
    });

    return res.json({
      ok: true,
      weekStart: weekStartStr,
      weekEnd: weekEndStr,
      perCategory: perCat,
      totalCents,
      settlement: result,
    });
  } catch (err) {
    return res.status(400).json({ error: String(err?.message || err) });
  }
});

// TEST: monitor for 30s then auto charge
app.post("/api/test/auto-charge", async (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: "userId required" });

  try {
    const customerId = await getOrCreateCustomer(userId);
    // Immediately tell frontend "started"
    res.json({ ok: true, message: "Monitoring started, will charge in 30s" });

    const customer = await stripe.customers.retrieve(customerId);
    console.log("customer in auto charge test route ", customer);
    const paymentMethods = await stripe.paymentMethods.list({
      customer: customerId,
      type: "card",
    });

    console.log(
      "Customer default payment method:",
      customer.invoice_settings.default_payment_method
    );
    console.log("All saved cards:", paymentMethods.data);

    // After 15 seconds, create a $0.51 charge (for testing)
    setTimeout(async () => {
      try {
        const pi = await stripe.paymentIntents.create({
          amount: 51, // $0.51
          currency: "usd",
          customer: customerId,
          payment_method: customer.invoice_settings.default_payment_method,
          off_session: true,
          confirm: true,
          automatic_payment_methods: { enabled: true },
          metadata: { userId, reason: "ViceBank test auto-charge" },
        });
        console.log(
          `[TEST] Charged user ${userId}: PaymentIntent ${pi.id}, status=${pi.status}`
        );
      } catch (err) {
        console.error("[TEST] Auto-charge failed:", err.message);
      }
    }, 15_000);
  } catch (err) {
    console.error(err);
    return; // response already sent
  }
});
/* -------------------- start -------------------- */
const port = process.env.PORT || 4242;
app.listen(port, () =>
  console.log(`vicebank-backend (weekly) listening on http://localhost:${port}`)
);
