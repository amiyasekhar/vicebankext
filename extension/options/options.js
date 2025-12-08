// options.js
import { get, set } from "../lib/storage.js";
import { sha256Hex, ensureSession } from "../lib/util.js";

const agreeBtn = document.getElementById("agree");
const backendInput = document.getElementById("backendUrl");
const graceInput = document.getElementById("graceInput");
const ratePornInput = document.getElementById("ratePornInput");
const rateGamblingInput = document.getElementById("rateGamblingInput");

const backendBaseUrl = "http://localhost:4242"; // or from input if you want dynamic

// ------------------ Helpers ------------------
function parseGraceToMinutes(val) {
  // Accept "m", "mm", or "mm:ss"; clamp 0..180 seconds (0..3:00)
  if (!val) return 0;
  const str = String(val).trim();
  if (str.includes(":")) {
    const [mStr, sStr] = str.split(":");
    const m = Math.max(0, parseInt(mStr || "0", 10));
    const s = Math.max(0, Math.min(59, parseInt(sStr || "0", 10)));
    const totalMin = m + (s >= 30 ? 1 : 0); // round up at 30s
    return Math.max(0, Math.min(3, totalMin));
  }
  const asNum = Number(str);
  if (Number.isFinite(asNum))
    return Math.max(0, Math.min(3, Math.floor(asNum)));
  return 0;
}

function validateChecks() {
  const all = Array.from(
    document.querySelectorAll(".checks input[type=checkbox]")
  ).every((c) => c.checked);
  agreeBtn.disabled = !all;
  agreeBtn.classList.toggle("disabled", !all);
}

// async function loadStripeJs() {
//   return new Promise((resolve, reject) => {
//     const script = document.createElement("script");
//     script.src = "https://js.stripe.com/v3/";
//     script.onload = () => resolve(window.Stripe);
//     script.onerror = reject;
//     document.head.appendChild(script);
//   });
// }

// ------------------ Consent + Stripe Flow ------------------
async function onAgreeAndContinue(userId, opts) {
  try {
    // Step 1: record conse
    const res = await fetch(`${backendBaseUrl}/api/consent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId,
        grace: opts.grace,
        rates: opts.rates,
        categoriesOn: { porn: true, gambling: true },
        extensionVersion: chrome.runtime.getManifest().version,
        tosHash: await sha256Hex(
          `ViceBank ToS and Billing Policy v1 — grace ${
            opts.grace
          }, rates ${JSON.stringify(opts.rates)}`
        ),
      }),
    });
    if (!res.ok) throw new Error("Consent failed");

    // Step 2: create Checkout session
    const checkoutRes = await fetch(
      `${backendBaseUrl}/api/stripe/checkout-session`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      }
    );
    if (!checkoutRes.ok) throw new Error("Checkout session failed");
    const { url } = await checkoutRes.json();

    // Step 3: open Stripe-hosted page
    chrome.tabs.create({ url });

    // Step 4: optionally mark payment setup in storage once success detected via redirect page
    await set({ paymentSetupDone: true });

    // Step 5: notify background to start tracking
    chrome.runtime.sendMessage({ type: "VB_START_TRACKING" });

    window.close();
  } catch (err) {
    console.error("Consent/Stripe flow failed:", err);
  }
}

// ------------------ Event Handlers ------------------
document.addEventListener("DOMContentLoaded", async () => {
  // const stripe = Stripe(
  //   "pk_test_51QIlLMAnUfawcEVZBT6DywfDGqqZCMNFCiXKtZfsDdHhIL0W55DNZFvzfWz6xgFzoTpcNW5cr60c8yklVoBiRZUZ00AQU3DesT"
  // );
  document
    .querySelectorAll(".checks input[type=checkbox]")
    .forEach((c) => c.addEventListener("change", validateChecks));
  validateChecks();

  // Load saved values
  const st = await get(null);
  const g = st.grace?.porn ?? 3;
  graceInput.value = `${String(g).padStart(1, "0")}:00`;
  ratePornInput.value = st.rates?.porn ?? 0.05;
  rateGamblingInput.value = st.rates?.gambling ?? 0.5;
});

// ------------------ Main Button Click ------------------
agreeBtn.onclick = async () => {
  const grace = parseGraceToMinutes(graceInput.value);
  let ratePorn = Math.max(0.05, Number(ratePornInput.value || 0));
  let rateGambling = Math.max(0.5, Number(rateGamblingInput.value || 0));

  // Ensure we have a user/session first
  let st = await get(null);
  st = await ensureSession(st);
  const userId = st.userId;

  // Save settings locally
  await set({
    backendBaseUrl,
    grace: { porn: grace, gambling: grace },
    rates: { porn: ratePorn, gambling: rateGambling },
  });

  // Run full consent + Stripe flow
  await onAgreeAndContinue(userId, {
    grace,
    rates: { porn: ratePorn, gambling: rateGambling },
  });
};

let active = {
  category: null,
  domain: null,
  host: null,
  sinceTs: 0,
  lastTickTs: 0,
};

// --- web timer state (moved here) ---
let webTimerInterval = null;
let webTimerSeconds = 0;

function startWebTimer() {
  if (webTimerInterval) return;
  webTimerSeconds = 0;
  console.log("[ViceBank][WebTimer] start", {
    category: active?.category,
    host: active?.host,
    sinceTs: active?.sinceTs,
  });
  webTimerInterval = setInterval(() => {
    try {
      if (!active?.category) {
        stopWebTimer();
        return;
      }
      webTimerSeconds++;
      if (webTimerSeconds % 5 === 0) {
        console.log("[ViceBank][WebTimer] tick", {
          seconds: webTimerSeconds,
          category: active.category,
          host: active.host,
          url: active.url,
        });
      }
      try {
        chrome.action.setBadgeText({ text: String(webTimerSeconds % 60) });
      } catch {}
    } catch (err) {
      console.error("[ViceBank][WebTimer] error:", err);
    }
  }, 1000);
}

function stopWebTimer() {
  if (!webTimerInterval) return;
  clearInterval(webTimerInterval);
  webTimerInterval = null;
  console.log("[ViceBank][WebTimer] stopped after seconds=", webTimerSeconds, {
    lastCategory: active?.category,
    lastHost: active?.host,
  });
  webTimerSeconds = 0;
  try {
    chrome.action.setBadgeText({ text: "" });
  } catch {}
}

// --- Refresh active tab info (new) ---
async function refreshActive() {
  const tabs = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (!tabs?.[0]?.url) {
    console.log("[ViceBank][WebTimer] refreshActive: no active tab/url");
    active.category = null;
    try {
      chrome.action.setBadgeText({ text: "" });
    } catch {}
    // stop web timer when no restricted tab
    stopWebTimer();
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
    console.log("[ViceBank][WebTimer] refreshActive: host blocked", host);
    active.category = null;
    try {
      chrome.action.setBadgeText({ text: "" });
    } catch {}
    stopWebTimer();
    return;
  }

  const cat = detectCategory(host);
  if (!cat || !st.categoriesOn?.[cat]) {
    console.log(
      "[ViceBank][WebTimer] refreshActive: not a tracked category",
      host,
      cat
    );
    active.category = null;
    try {
      chrome.action.setBadgeText({ text: "" });
    } catch {}
    stopWebTimer();
    return;
  }

  const now = Date.now();
  if (active.category !== cat || active.host !== host) {
    active = {
      category: cat,
      host,
      domain: host,
      url: tab.url,
      sinceTs: now,
      lastTickTs: now,
    };
    // start immediate web timer on new restricted site visit
    startWebTimer();
  } else {
    active.lastTickTs = now;
    // ensure timer runs while staying on same site
    if (!webTimerInterval) startWebTimer();
  }
}

// --- quick listeners to detect visits immediately (moved to service worker) ---
chrome.tabs.onActivated.addListener(() => {
  refreshActive().catch((e) => console.error("[ViceBank] onActivated:", e));
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" || changeInfo.url) {
    refreshActive().catch((e) => console.error("[ViceBank] onUpdated:", e));
  }
});
chrome.windows.onFocusChanged.addListener(() => {
  refreshActive().catch((e) => console.error("[ViceBank] onFocusChanged:", e));
});
