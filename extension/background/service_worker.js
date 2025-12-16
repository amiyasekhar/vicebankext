// extension/background/service_worker.js
// ViceBank MV3 background worker (direct-charge version)
//
// - Tracks ALL OPEN tabs against Porn/Gambling lists (including background tabs)
// - Bills per distinct domain-minute (Option C): each distinct restricted domain open counts 1/min
// - Grace is applied exactly per category; after grace, billing continues indefinitely
// - For testing: grace/counters reset on local startup

import { get, set } from "../lib/storage.js";
import {
  hostFromUrl,
  todayLocalISO,
  uuidv4,
  ensureSession,
} from "../lib/util.js";
// ---------- Defaults ----------
const DEFAULTS = {
  enabled: true,
  grace: { porn: 3, gambling: 3 }, // minutes/day per category
  floors: { porn: 0.05, gambling: 0.5 }, // $/min (server should enforce too)
  rates: { porn: 0.05, gambling: 0.5 }, // default $/min
  categoriesOn: { porn: true, gambling: true },
  blocklist: [],
  // Additional user-provided domains to treat as restricted (extends categories.json)
  customDomains: { porn: [], gambling: [] },
  lastResetLocalDate: null,
  userId: null,
  backendBaseUrl: "http://localhost:4242",

  // Local UI counters (not the source of truth for billing)
  counters: {
    date: null,
    porn: { freeMin: 0, paidMin: 0 },
    gambling: { freeMin: 0, paidMin: 0 },
  },

  // Whether the user has elected to keep paying after grace for each category
  paidActive: { porn: false, gambling: false },
};

const IDLE_CUTOFF_SECONDS = 90; // retained, but we do not gate billing on focus anymore

let autoChargeArmed = false;
let autoChargeTimer = null;

function startAutoChargeTimer(userId, backendBaseUrl) {
  if (autoChargeArmed) return; // already armed once

  autoChargeArmed = true;
  console.log("[ViceBank] Auto-charge timer started, will charge in ~30s", {
    userId,
    backendBaseUrl,
  });

  // Call the backend test auto-charge endpoint immediately.
  // The backend itself waits before creating the PaymentIntent.
  (async () => {
    try {
      const resp = await fetch(`${backendBaseUrl}/api/test/auto-charge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });

      const data = await resp.json().catch(() => ({}));
      console.log("[ViceBank] Auto-charge trigger result", resp.status, data);

      // Optional: show a browser notification like in your Loom
      try {
        chrome.notifications.create("vb_test_autocharge_auto", {
          type: "basic",
          iconUrl: "assets/icon128.png",
          title: "ViceBank — Test charge scheduled",
          message:
            data?.message ||
            "A small test charge will be attempted shortly using your saved card.",
        });
      } catch (e) {
        console.warn("[ViceBank] notification error", e);
      }
    } catch (err) {
      console.error("[ViceBank] Auto-charge trigger error:", err);
    }
  })();
}

// (Old "active tab" + web timer logic removed; billing is now based on presence of restricted tabs.)

// ---------- Install / Startup ----------
chrome.runtime.onInstalled.addListener(async () => {
  const st = await get(null);
  if (!st?.userId) {
    await set({ ...DEFAULTS, userId: uuidv4() });
    chrome.runtime.openOptionsPage(); // show consent screen
  } else {
    await set({
      ...DEFAULTS,
      ...st,
      counters: st.counters ?? DEFAULTS.counters,
    });
  }
  try {
    chrome.action.setBadgeText({ text: "" });
  } catch {}
  try {
    chrome.action.setBadgeBackgroundColor({ color: "#4caf50" });
  } catch {}
  chrome.alarms.create("vb_tick", { periodInMinutes: 1 }); // every 1 minute (real time)
});

chrome.runtime.onStartup.addListener(async () => {
  const st = await get(null);
  console.log("UserId:", st.userId);
  if (!st?.userId) await set({ ...DEFAULTS, userId: uuidv4() });
  // TESTING: reset grace/counters on startup
  const today = todayLocalISO();
  await set({
    counters: {
      date: today,
      porn: { freeMin: 0, paidMin: 0 },
      gambling: { freeMin: 0, paidMin: 0 },
    },
    paidActive: { porn: false, gambling: false },
    sessionId: null,
    sessionDate: null,
  });
  try {
    chrome.action.setBadgeText({ text: "" });
  } catch {}
  try {
    chrome.action.setBadgeBackgroundColor({ color: "#4caf50" });
  } catch {}
  chrome.alarms.create("vb_tick", { periodInMinutes: 1 }); // every 1 minute (real time)
});

// ---------- Category lists ----------
async function loadLists() {
  const url = chrome.runtime.getURL("lib/categories.json");
  const resp = await fetch(url);
  return resp.json();
}
let lists = null;
async function ensureLists() {
  if (!lists) lists = await loadLists();
  return lists;
}
function endsWithHost(host, pattern) {
  return host === pattern || host.endsWith("." + pattern);
}
function matchesHost(host, pattern) {
  if (!host || !pattern) return false;
  if (pattern.startsWith("*.")) {
    const p = pattern.slice(2);
    return host === p || host.endsWith("." + p);
  }
  return endsWithHost(host, pattern);
}
function detectCategory(host, customDomains) {
  if (!host || !lists) return null;
  const porn = [...(lists.porn || []), ...(customDomains?.porn || [])];
  const gambling = [...(lists.gambling || []), ...(customDomains?.gambling || [])];

  for (const p of porn) if (matchesHost(host, p)) return "porn";
  for (const g of gambling) if (matchesHost(host, g)) return "gambling";
  return null;
}

// ---------- Helpers ----------
function initCounters(st, today) {
  if (!st.counters || st.counters.date !== today) {
    st.counters = {
      date: today,
      porn: { freeMin: 0, paidMin: 0 },
      gambling: { freeMin: 0, paidMin: 0 },
    };
  } else {
    st.counters.porn = st.counters.porn || { freeMin: 0, paidMin: 0 };
    st.counters.gambling = st.counters.gambling || { freeMin: 0, paidMin: 0 };
  }
  if (!st.paidActive) st.paidActive = { porn: false, gambling: false };
  return st;
}

function normalizeHost(h) {
  return (h || "").toLowerCase().replace(/^www\./, "");
}

function isBlocked(host, blocklist) {
  const hl = normalizeHost(host);
  return (blocklist || []).some((p) =>
    p.startsWith("*.")
      ? hl.endsWith(p.slice(1).toLowerCase())
      : hl === p.toLowerCase() || hl.endsWith("." + p.toLowerCase())
  );
}

async function collectRestrictedDomains(st) {
  // Option C: count per distinct domain-minute (all open tabs).
  const tabs = await chrome.tabs.query({});
  const byCategory = { porn: new Map(), gambling: new Map() }; // domain -> sampleUrl

  for (const tab of tabs) {
    const url = tab?.url;
    if (!url || typeof url !== "string") continue;
    if (url.startsWith("chrome://") || url.startsWith("chrome-extension://"))
      continue;

    const host = hostFromUrl(url);
    if (!host) continue;
    const hostNorm = normalizeHost(host);
    if (isBlocked(hostNorm, st.blocklist)) continue;

    const cat = detectCategory(hostNorm, st.customDomains);
    if (!cat || !st.categoriesOn?.[cat]) continue;

    if (!byCategory[cat].has(hostNorm)) byCategory[cat].set(hostNorm, url);
  }

  return byCategory;
}

// ---------- Minute tick ----------
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "vb_tick") return;
  try {
    await ensureLists();

    let st = await get(null);
    const today = todayLocalISO();
    st = initCounters(st || {}, today);

    if (!st.enabled) return;

    const byCategory = await collectRestrictedDomains(st);
    const pornDomains = Array.from(byCategory.porn.entries()); // [domain, url]
    const gamblingDomains = Array.from(byCategory.gambling.entries());
    const totalDomains = pornDomains.length + gamblingDomains.length;
    if (totalDomains === 0) {
      try {
        chrome.action.setBadgeText({ text: "" });
      } catch {}
      return;
    }

    // Ensure backend session exists (backend may restart)
    st = await ensureSession(st);

    const events = [];
    const applyForCategory = (cat, entries) => {
      const units = entries.length; // domain-minutes
      if (units <= 0) return;

      const grace = Number(st.grace?.[cat] ?? 0);
      const freeUsed = Number(st.counters?.[cat]?.freeMin ?? 0);
      const remainingGrace = Math.max(0, grace - freeUsed);
      const freeToAdd = Math.min(remainingGrace, units);
      const paidToAdd = units - freeToAdd;

      st.counters[cat].freeMin = freeUsed + freeToAdd;
      st.counters[cat].paidMin = Number(st.counters?.[cat]?.paidMin ?? 0) + paidToAdd;

      // Sync per-domain event (Option C)
      for (const [domain, url] of entries) {
        events.push({ url: url || `https://${domain}/`, seconds: 60, category: cat });
      }

      // Notify when we cross grace boundary for this category
      if (freeToAdd > 0 && paidToAdd > 0) {
        try {
          chrome.notifications.create(`vb_grace_done_${cat}`, {
            type: "basic",
            iconUrl: "assets/icon128.png",
            title: "ViceBank — Grace used",
            message: `Grace is used for ${cat}. Billing continues while restricted tabs remain open.`,
          });
        } catch {}
      }
    };

    applyForCategory("porn", pornDomains);
    applyForCategory("gambling", gamblingDomains);

    await set({ counters: st.counters });

    // Batch sync to backend in one call
    try {
      const resp = await fetch(`${st.backendBaseUrl}/api/track`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: st.userId,
          sessionId: st.sessionId,
          events,
        }),
      });
      if (!resp.ok) {
        console.warn("[ViceBank] /api/track failed", resp.status);
      }
    } catch (e) {
      console.warn("[ViceBank] /api/track error", e);
    }

    // Badge: show number of restricted domains open (Option C)
    try {
      chrome.action.setBadgeBackgroundColor({ color: "#A855F7" });
      chrome.action.setBadgeText({ text: String(totalDomains) });
    } catch {}
  } catch (err) {
    console.error("[ViceBank] tick error:", err);
  }
});

// ---------- Messaging (direct-charge on Continue Paid) ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      let st = await get(null);
      const today = todayLocalISO();
      st = initCounters(st || {}, today);

      if (msg?.type === "VB_CONTINUE_PAID") {
        const cat = msg.category;
        if (!cat || !["porn", "gambling"].includes(cat)) {
          sendResponse({ ok: false, error: "invalid category" });
          return;
        }

        // Mark paid-active so UI paid minute counter ticks
        st.paidActive[cat] = true;
        await set({ paidActive: st.paidActive });

        // Compute minutes so far (today) and charge now
        const free = st.counters?.[cat]?.freeMin ?? 0;
        const paid = st.counters?.[cat]?.paidMin ?? 0;
        const minutesSoFar = free + paid;
        const grace = st.grace?.[cat] ?? 0;
        const rate = st.rates?.[cat] ?? 0;

        try {
          const resp = await fetch(`${st.backendBaseUrl}/api/charge`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              userId: st.userId,
              category: cat,
              minutes: minutesSoFar,
              grace,
              rate,
              // paymentMethodId: "pm_card_visa" // optional override; server defaults in test
            }),
          });

          const data = await resp.json().catch(() => ({}));
          if (!resp.ok) {
            console.warn("[ViceBank] Charge failed", data);
            sendResponse({ ok: false, status: resp.status, data });
            return;
          }

          console.log("[ViceBank] Charge result:", data);
          try {
            chrome.notifications.create(`vb_charge_${cat}`, {
              type: "basic",
              iconUrl: "assets/icon128.png",
              title: "ViceBank — Charge created",
              message:
                data?.amountCents > 0
                  ? `Charged $${(data.amountCents / 100).toFixed(
                      2
                    )} for today's ${cat} usage.`
                  : `No charge (within grace).`,
            });
          } catch {}

          sendResponse({ ok: true, data });
          return;
        } catch (e) {
          console.warn("[ViceBank] Charge call error", e);
          sendResponse({ ok: false, error: String(e) });
          return;
        }
      }

      // === Test Auto-Charge (delayed $1 charge) ===
      if (msg?.type === "VB_TEST_AUTOCHARGE") {
        try {
          const resp = await fetch(
            `${st.backendBaseUrl}/api/test/auto-charge`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ userId: st.userId }),
            }
          );

          const data = await resp.json().catch(() => ({}));
          if (!resp.ok) {
            console.warn("[ViceBank] Test auto-charge failed", data);
            sendResponse({ ok: false, status: resp.status, data });
            return;
          }

          console.log("[ViceBank] Auto-charge scheduled:", data);
          try {
            chrome.notifications.create("vb_test_autocharge", {
              type: "basic",
              iconUrl: "assets/icon128.png",
              title: "ViceBank — Test charge scheduled",
              message: "A $1 test charge will be attempted in 30s.",
            });
          } catch {}

          sendResponse({ ok: true, data });
          return;
        } catch (err) {
          console.error("[ViceBank] Auto-charge error:", err);
          sendResponse({ ok: false, error: String(err) });
          return;
        }
      }

      if (msg?.type === "VB_STOP_AND_LEAVE") {
        try {
          chrome.tabs.create({ url: "chrome://newtab" });
        } catch {}
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === "VB_SETTINGS_UPDATE") {
        await set(msg.payload || {});
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === "VB_GET_STATE") {
        sendResponse({ state: st, active });
        return;
      }

      // Unknown message
      sendResponse({
        ok: false,
        error: "unknown message type",
        type: msg?.type,
      });
    } catch (err) {
      console.error("[ViceBank] message handler error:", err);
      sendResponse({ ok: false, error: String(err) });
    }
  })();

  // keep the message channel open for the async work above
  return true;
});

// No tab-focus listeners needed; counting is based on open tabs.
