// server_full_test.js — exercise all endpoints (CommonJS)
// Usage: node server_full_test.js http://localhost:4242
//
// Requires Node 18+ for global fetch. If using Node <18, uncomment the node-fetch shim below.

const BASE = process.argv[2] || 'http://localhost:4242';
const TZ_OFFSET_MIN = 0; // set to 240 for Asia/Dubai if you want local week bounds

// For Node <18, uncomment:
// const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const j = (o) => JSON.stringify(o, null, 2);

async function call(method, path, body, extraHeaders = {}) {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

// Helpers to craft timestamps “across the week” without waiting IRL
const now = Date.now(); // reference “today”
const dayMs = 24 * 60 * 60 * 1000;
const tsAddDays = (ts, d) => ts + d * dayMs;

// Choose a fixed weekEnd so preview/settle are deterministic (use “today” as week end)
const WEEK_END_YYYYMMDD = new Date().toISOString().slice(0,10);

// Test identities
const userId       = `user_${Math.random().toString(36).slice(2, 8)}`;
const rolloverUser = `user_${Math.random().toString(36).slice(2, 8)}_roll`;
const sessionId    = `sess_${Math.random().toString(36).slice(2, 8)}`;

function header(title) {
  console.log(`\n=== ${title} ===`);
}

(async () => {
  console.log(`Target: ${BASE}`);
  console.log(`User:   ${userId}`);
  console.log(`Session:${sessionId}`);
  console.log(`WeekEnd:${WEEK_END_YYYYMMDD}\n`);

  // --- Health
  header('GET / (health)');
  let r = await call('GET', '/', null);
  console.log(j(r));
  if (!r.ok) process.exit(1);

  // --- Consent for main user (weekly charge should exceed $0.50)
  // porn=$0.05/min, gambling=$0.50/min, porn has 1 minute daily grace
  header('POST /api/consent (main user)');
  r = await call('POST', '/api/consent', {
    userId,
    extensionVersion: '1.0.0',
    grace: { porn: 1, gambling: 0 },
    rates: { porn: 0.05, gambling: 0.50 },
    categoriesOn: { porn: true, gambling: true },
    tosHash: 'consenthash_main',
  });
  console.log(j(r));
  if (!r.ok) process.exit(1);

  // --- Consent for rollover user (weekly total stays below $0.50 to test carry-forward)
  header('POST /api/consent (rollover user)');
  r = await call('POST', '/api/consent', {
    userId: rolloverUser,
    extensionVersion: '1.0.0',
    grace: { porn: 1, gambling: 0 },
    rates: { porn: 0.05, gambling: 0.50 },
    categoriesOn: { porn: true, gambling: true },
    tosHash: 'consenthash_roll',
  });
  console.log(j(r));
  if (!r.ok) process.exit(1);

  // --- Start session
  header('POST /api/session/start');
  r = await call('POST', '/api/session/start', { userId, sessionId, extensionVersion: '1.0.0' });
  console.log(j(r));
  if (!r.ok) process.exit(1);

  // --- Track multi-day usage for main user (simulate 3 days this week)
  // D0: porn 40m -> billable 39m
  // D1: porn 30m -> billable 29m
  // D2: porn 50m -> billable 49m
  // Weekly billable = 117m; amount = 117 * $0.05 = $5.85 (>= minimum)
  header('POST /api/track (D0 / 40m porn)');
  r = await call('POST', '/api/track', {
    userId, sessionId,
    events: [{ type: 'heartbeat', url: 'https://www.pornhub.com/', seconds: 40 * 60, ts: tsAddDays(now, 0) }]
  });
  console.log(j(r)); if (!r.ok) process.exit(1);

  await sleep(100);

  header('POST /api/track (D1 / 30m porn)');
  r = await call('POST', '/api/track', {
    userId, sessionId,
    events: [{ type: 'heartbeat', url: 'https://www.pornhub.com/', seconds: 30 * 60, ts: tsAddDays(now, 1) }]
  });
  console.log(j(r)); if (!r.ok) process.exit(1);

  await sleep(100);

  header('POST /api/track (D2 / 50m porn)');
  r = await call('POST', '/api/track', {
    userId, sessionId,
    events: [{ type: 'heartbeat', url: 'https://www.pornhub.com/', seconds: 50 * 60, ts: tsAddDays(now, 2) }]
  });
  console.log(j(r)); if (!r.ok) process.exit(1);

  // --- Counters today (will only reflect today’s D0 batch in byCategory; still good sanity)
  header('GET /api/counters/today');
  r = await call('GET', `/api/counters/today?userId=${encodeURIComponent(userId)}`);
  console.log(j(r)); if (!r.ok) process.exit(1);

  // --- Preview weekly settlement for main user (no charge)
  header('GET /api/preview/week (main user)');
  r = await call(
    'GET',
    `/api/preview/week?userId=${encodeURIComponent(userId)}&weekEnd=${WEEK_END_YYYYMMDD}&tzOffsetMinutes=${TZ_OFFSET_MIN}`,
    null
  );
  console.log(j(r)); if (!r.ok) process.exit(1);

  // --- Settle weekly (main user) — charges one PaymentIntent if >= $0.50
  header('POST /api/settle/week (main user)');
  r = await call('POST', '/api/settle/week', {
    userId,
    weekEnd: WEEK_END_YYYYMMDD,
    tzOffsetMinutes: TZ_OFFSET_MIN,
  });
  console.log(j(r)); if (!r.ok) process.exit(1);

  // --- Rollover user: track tiny usage (under $0.50 total) and verify carry-forward
  const rollSess = `sess_${Math.random().toString(36).slice(2, 8)}`;
  header('POST /api/session/start (rollover user)');
  r = await call('POST', '/api/session/start', { userId: rolloverUser, sessionId: rollSess, extensionVersion: '1.0.0' });
  console.log(j(r)); if (!r.ok) process.exit(1);

  // 3 minutes porn on two separate days -> daily billable each day = 2m
  // total weekly billable = 4m * $0.05 = $0.20  (< $0.50 → should carry forward)
  header('POST /api/track (rollover D0 / 3m porn)');
  r = await call('POST', '/api/track', {
    userId: rolloverUser, sessionId: rollSess,
    events: [{ type: 'heartbeat', url: 'https://www.pornhub.com/', seconds: 3 * 60, ts: tsAddDays(now, 0) }]
  });
  console.log(j(r)); if (!r.ok) process.exit(1);

  header('POST /api/track (rollover D1 / 3m porn)');
  r = await call('POST', '/api/track', {
    userId: rolloverUser, sessionId: rollSess,
    events: [{ type: 'heartbeat', url: 'https://www.pornhub.com/', seconds: 3 * 60, ts: tsAddDays(now, 1) }]
  });
  console.log(j(r)); if (!r.ok) process.exit(1);

  header('GET /api/preview/week (rollover user)');
  r = await call(
    'GET',
    `/api/preview/week?userId=${encodeURIComponent(rolloverUser)}&weekEnd=${WEEK_END_YYYYMMDD}&tzOffsetMinutes=${TZ_OFFSET_MIN}`,
    null
  );
  console.log(j(r)); if (!r.ok) process.exit(1);

  header('POST /api/settle/week (rollover user) — expect carry-forward, no charge');
  r = await call('POST', '/api/settle/week', {
    userId: rolloverUser,
    weekEnd: WEEK_END_YYYYMMDD,
    tzOffsetMinutes: TZ_OFFSET_MIN,
  });
  console.log(j(r)); if (!r.ok) process.exit(1);

  // --- Stop both sessions
  header('POST /api/session/stop (main user)');
  r = await call('POST', '/api/session/stop', { userId, sessionId });
  console.log(j(r)); if (!r.ok) process.exit(1);

  header('POST /api/session/stop (rollover user)');
  r = await call('POST', '/api/session/stop', { userId: rolloverUser, sessionId: rollSess });
  console.log(j(r)); if (!r.ok) process.exit(1);

  // --- OPTIONAL: webhook route smoke (no signature) just to confirm 200/disabled or 400
  header('POST /api/webhook (optional smoke)');
  // Note: This will return 200 (disabled) if STRIPE_SECRET_KEY missing OR 400 if signature required.
  r = await call('POST', '/api/webhook', { ping: true }, { 'stripe-signature': 'test' });
  console.log(j(r));

  console.log('\n✅ Full endpoint test complete.');
})().catch(err => {
  console.error('\nFatal error:', err);
  process.exit(1);
});