// extension/background/service_worker.js
// ViceBank MV3 background worker (direct-charge version)
//
// - Tracks active tab against Porn/Gambling lists
// - Counts minutes (foreground only) with 15s debounce + 90s idle cutoff
// - Daily local-midnight reset of UI counters
// - At grace boundary: shows intercept modal
// - On "Continue Paid": immediately calls backend /api/charge with:
//     amount = ceil(max(0, minutesSoFar - grace)) * rate

import { get, set } from "../lib/storage.js";
import {
  hostFromUrl,
  todayLocalISO,
  uuidv4,
  syncMinuteToBackend,
} from "../lib/util.js";
// ---------- Defaults ----------
const DEFAULTS = {
  enabled: true,
  grace: { porn: 3, gambling: 3 }, // minutes/day per category
  floors: { porn: 0.05, gambling: 0.5 }, // $/min (server should enforce too)
  rates: { porn: 0.05, gambling: 0.5 }, // default $/min
  categoriesOn: { porn: true, gambling: true },
  blocklist: [],
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

const DEBOUNCE_SECONDS = 5; // must be in foreground this long to count a minute
const IDLE_CUTOFF_SECONDS = 90;

// In-memory active page/category snapshot
let active = {
  category: null,
  domain: null,
  host: null,
  sinceTs: 0,
  lastTickTs: 0,
};

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
  chrome.alarms.create("vb_tick", { periodInMinutes: 0.1 }); // every 6 seconds
});

chrome.runtime.onStartup.addListener(async () => {
  const st = await get(null);
  console.log("UserId:", st.userId);
  if (!st?.userId) await set({ ...DEFAULTS, userId: uuidv4() });
  try {
    chrome.action.setBadgeText({ text: "" });
  } catch {}
  try {
    chrome.action.setBadgeBackgroundColor({ color: "#4caf50" });
  } catch {}
  chrome.alarms.create("vb_tick", { periodInMinutes: 0.1 }); // every 6 seconds
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
function detectCategory(host) {
  if (!host || !lists) return null;
  for (const p of lists.porn) if (endsWithHost(host, p)) return "porn";
  for (const g of lists.gambling) if (endsWithHost(host, g)) return "gambling";
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

async function refreshActive() {
  const tabs = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (!tabs?.[0]?.url) {
    active.category = null;
    try {
      chrome.action.setBadgeText({ text: "" });
    } catch {}
    return;
  }

  const tab = tabs[0];
  const st = await get(["categoriesOn", "blocklist"]);
  const host = hostFromUrl(tab.url);

  // Simple blocklist (supports "*.example.com")
  const blocked = (st.blocklist || []).some((p) =>
    p.startsWith("*.")
      ? host.endsWith(p.slice(1))
      : host === p || host.endsWith("." + p)
  );
  if (blocked) {
    active.category = null;
    try {
      chrome.action.setBadgeText({ text: "" });
    } catch {}
    return;
  }

  const cat = detectCategory(host);
  if (!cat || !st.categoriesOn?.[cat]) {
    active.category = null;
    try {
      chrome.action.setBadgeText({ text: "" });
    } catch {}
    return;
  }

  const now = Date.now();
  if (active.category !== cat || active.host !== host) {
    active = {
      category: cat,
      host,
      domain: host,
      sinceTs: now,
      lastTickTs: now,
    };
  } else {
    active.lastTickTs = now;
  }
}

// ---------- Minute tick ----------
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "vb_tick") return;
  try {
    await ensureLists();
    await refreshActive();

    let st = await get(null);
    const today = todayLocalISO();
    st = initCounters(st || {}, today);

    if (!st.enabled) return;

    const idleState = await new Promise((res) =>
      chrome.idle.queryState(IDLE_CUTOFF_SECONDS, res)
    );
    if (idleState !== "active") return;

    if (!active.category) return;

    // Debounce: require active focus for at least DEBOUNCE_SECONDS before counting
    const now = Date.now();
    const secondsActive = Math.floor((now - (active.sinceTs || now)) / 1000);
    if (secondsActive < DEBOUNCE_SECONDS) return;

    const cat = active.category;
    const grace = st.grace?.[cat] ?? 0;
    const floor = st.floors?.[cat] ?? 0;
    const rate = Math.max(st.rates?.[cat] ?? 0, floor);

    const freeUsed = st.counters?.[cat]?.freeMin ?? 0;
    const paidUsed = st.counters?.[cat]?.paidMin ?? 0;
    try {
      console.log(
        `[ViceBank] tick: cat=${cat}, free=${freeUsed}, paid=${paidUsed}, grace=${grace}`
      );
    } catch {}

    if (freeUsed < grace) {
      // --- Count one free minute locally ---
      st.counters[cat].freeMin = freeUsed + 1;
      await set({ counters: st.counters });

      // --- Sync to backend ---
      await syncMinuteToBackend(st, active.url, cat);

      try {
        const total =
          (st.counters[cat].freeMin || 0) + (st.counters[cat].paidMin || 0);
        chrome.action.setBadgeBackgroundColor({ color: "#4caf50" }); // green for free
        chrome.action.setBadgeText({ text: `${total}` });
      } catch {}

      // 80% grace warning
      const threshold = grace > 0 ? Math.ceil(0.8 * grace) : 0;
      if (grace > 0 && st.counters[cat].freeMin === threshold) {
        chrome.notifications.create(`vb_warn_${cat}`, {
          type: "basic",
          iconUrl: "assets/icon128.png",
          title: "ViceBank — Grace Warning",
          message: `You're at 80% of your ${cat} grace (${grace} min/day).`,
        });
      }
    } else {
      // --- Past grace ---
      if (!st.paidActive?.[cat]) {
        // Prompt to continue paid or stop
        const tabs = await chrome.tabs.query({
          active: true,
          lastFocusedWindow: true,
        });
        if (tabs?.[0]) {
          chrome.tabs.sendMessage(tabs[0].id, {
            type: "VB_SHOW_MODAL",
            category: cat,
            rate,
            domain: active.domain,
          });
        }
        return; // wait for user action
      }

      // --- User chose to keep paying: tick paid minute ---
      st.counters[cat].paidMin = paidUsed + 1;
      await set({ counters: st.counters });

      // --- Sync to backend (paid minute) ---
      await syncMinuteToBackend(st, active.url, cat);

      try {
        const total =
          (st.counters[cat].freeMin || 0) + (st.counters[cat].paidMin || 0);
        chrome.action.setBadgeBackgroundColor({ color: "#e53935" }); // red for paid
        chrome.action.setBadgeText({ text: `${total}` });
      } catch {}
    }
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
