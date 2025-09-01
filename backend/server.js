/**
 * ViceBank Backend — Direct Charges (PaymentIntents)
 * --------------------------------------------------
 * Charges immediately: amount = ceil(max(0, minutes - grace)) * rate
 * - No subscriptions, no metered usage.
 * - Keeps /api/consent for dispute defense.
 *
 * ENV required:
 *   STRIPE_SECRET_KEY=sk_test_...
 *   PORT=4242
 *   BASE_URL=http://localhost:4242   (used if you add a return_url later)
 */

import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import cors from 'cors';
import Stripe from 'stripe';

const app = express();
app.use(express.json({ type: '*/*' }));
app.use(cors());
app.use(morgan('dev'));

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2023-10-16',
});

/* -------------------- helpers -------------------- */
function computeChargeCents({ minutes, graceMinutes, rateDollarsPerMin, roundUpPerMinute = true }) {
  const m = Math.max(0, Number(minutes) - Number(graceMinutes));
  const billable = roundUpPerMinute ? Math.ceil(m) : m;
  const centsPerMin = Math.round(Number(rateDollarsPerMin) * 100);
  return Math.max(0, billable * centsPerMin);
}

// simple in-memory consent store (replace with DB in prod)
const consents = new Map(); // userId -> snapshot

/* -------------------- routes --------------------- */

// Health
app.get('/', (_req, res) => res.json({ ok: true, service: 'vicebank-backend-direct' }));

/**
 * POST /api/consent
 * Capture consent snapshot (ToS hash, rates, grace, etc.) for disputes.
 */
app.post('/api/consent', (req, res) => {
  const { userId, extensionVersion, grace, rates, categoriesOn, tosHash } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });

  consents.set(userId, {
    ts: Date.now(),
    ip: req.ip,
    ua: req.get('user-agent'),
    extensionVersion,
    grace,
    rates,
    categoriesOn,
    tosHash,
  });

  // TODO: persist to append-only DB with hash chaining
  return res.json({ ok: true });
});

/**
 * POST /api/charge
 * Immediate charge using PaymentIntents.
 *
 * Body:
 *  {
 *    userId: "uuid",              // used in metadata only (you can also map to a Stripe customer)
 *    category: "porn"|"gambling", // for metadata/audit
 *    minutes: 11,
 *    grace: 3,
 *    rate: 0.05,                  // dollars per minute the user set
 *    paymentMethodId?: "pm_..."   // optional; if absent we use pm_card_visa (test)
 *  }
 *
 * Response: { ok, amountCents, paymentIntentId, status }
 */
app.post('/api/charge', async (req, res) => {
  try {
    const { userId, category, minutes, grace, rate, paymentMethodId } = req.body || {};
    if (!userId || !category || minutes == null || grace == null || rate == null) {
      return res
        .status(400)
        .json({ error: 'userId, category, minutes, grace, rate required' });
    }

    // (optional) enforce floors by category
    const floors = { porn: 0.05, gambling: 0.25 };
    const effectiveRate =
      Math.max(floors[category] ?? 0, Number(rate));

    const amountCents = computeChargeCents({
      minutes,
      graceMinutes: grace,
      rateDollarsPerMin: effectiveRate,
      roundUpPerMinute: true,
    });

    if (amountCents <= 0) {
      return res.json({ ok: true, amountCents: 0, paymentIntentId: null, status: 'no_charge' });
    }

    // Idempotency: avoid accidental double charges for the same session/day
    const dayKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const idemKey = `vb_pi_${userId}_${category}_${dayKey}_${amountCents}`;

    // Use provided PM if you collected it; otherwise default to Stripe test card
    const pm = paymentMethodId || 'pm_card_visa'; // test mode convenience

    // ---- Your requested pattern: confirm=true, immediate charge ----
    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: amountCents, // in cents
        currency: 'usd',
        payment_method: pm,                  // or saved PM id from your UI
        confirm: true,                       // confirm immediately
        automatic_payment_methods: { enabled: true }, // okay with explicit PM in test
        // optional: customer: 'cus_...' if you create/keep customers
        metadata: {
          userId,
          category,
          minutes: String(minutes),
          grace: String(grace),
          rate: String(effectiveRate),
          reason: 'ViceBank direct per-minute charge',
        },
      },
      { idempotencyKey: idemKey }
    );

    return res.json({
      ok: true,
      amountCents,
      paymentIntentId: paymentIntent.id,
      status: paymentIntent.status,
    });
  } catch (e) {
    // If SCA required and pm_card_visa isn’t enough, Stripe may return 402 with next_action
    return res.status(400).json({ error: e.message });
  }
});

/* --------------- (optional) webhook stub --------------- */
/* If you still want Stripe events (refunds, disputes), keep this.
   Not required for creating charges, but recommended for observability. */
import bodyParser from 'body-parser';
app.post('/api/webhook', bodyParser.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  try {
    const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    // TODO: handle charge.succeeded, charge.refunded, charge.dispute.created, etc.
    return res.json({ received: true, type: event.type });
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

/* -------------------- start -------------------- */
const port = process.env.PORT || 4242;
app.listen(port, () => console.log(`vicebank-backend (direct charges) listening on ${port}`));