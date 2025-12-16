// options.js
import { get, set } from "../lib/storage.js";
import { sha256Hex, ensureSession } from "../lib/util.js";

const agreeBtn = document.getElementById("agree");
const backendInput = document.getElementById("backendUrl");
const graceInput = document.getElementById("graceInput");
const ratePornInput = document.getElementById("ratePornInput");
const rateGamblingInput = document.getElementById("rateGamblingInput");

const pornDomainsEl = document.getElementById("pornDomains");
const gamblingDomainsEl = document.getElementById("gamblingDomains");
const pornDomainInput = document.getElementById("pornDomainInput");
const gamblingDomainInput = document.getElementById("gamblingDomainInput");
const pornDomainAddBtn = document.getElementById("pornDomainAddBtn");
const gamblingDomainAddBtn = document.getElementById("gamblingDomainAddBtn");
const pornDomainError = document.getElementById("pornDomainError");
const gamblingDomainError = document.getElementById("gamblingDomainError");

const backendBaseUrl = "http://localhost:4242"; // or from input if you want dynamic
const CUSTOM_DOMAINS_KEY = "customDomains";

async function loadDefaultDomainLists() {
  const url = chrome.runtime.getURL("lib/categories.json");
  const resp = await fetch(url);
  return resp.json();
}

function normalizeDomainInput(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "";

  // allow wildcard prefix
  const hasWildcard = s.startsWith("*.");
  const withoutWildcard = hasWildcard ? s.slice(2) : s;

  // strip protocol
  const noProto = withoutWildcard.replace(/^https?:\/\//, "");
  // strip path/query/hash
  const hostOnly = noProto.split("/")[0].split("?")[0].split("#")[0];
  const host = hostOnly.replace(/^www\./, "");
  if (!host) return "";

  return hasWildcard ? `*.${host}` : host;
}

function isValidDomainPattern(domain) {
  if (!domain) return false;
  const d = domain.startsWith("*.") ? domain.slice(2) : domain;
  // Minimal sanity: must contain a dot, no spaces, no protocol chars
  if (/\s/.test(d)) return false;
  if (!d.includes(".")) return false;
  if (!/^[a-z0-9.-]+$/.test(d)) return false;
  if (d.startsWith(".") || d.endsWith(".")) return false;
  if (d.includes("..")) return false;
  return true;
}

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function chip(label, { removable = false, onRemove = null, variant = "default" } = {}) {
  const el = document.createElement("span");
  el.className = `chip ${variant === "default" ? "chip--default" : ""}`.trim();
  el.textContent = label;

  if (removable) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chipRemove";
    btn.setAttribute("aria-label", `Remove ${label}`);
    btn.textContent = "×";
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      onRemove?.();
    };
    el.appendChild(btn);
  }

  return el;
}

async function ensureCustomDomains(st) {
  const current = st?.[CUSTOM_DOMAINS_KEY];
  const next = {
    porn: Array.isArray(current?.porn) ? current.porn : [],
    gambling: Array.isArray(current?.gambling) ? current.gambling : [],
  };

  // If key missing or malformed, repair it
  if (!current || !Array.isArray(current?.porn) || !Array.isArray(current?.gambling)) {
    await set({ [CUSTOM_DOMAINS_KEY]: next });
  }
  return next;
}

function setError(category, msg) {
  const el = category === "porn" ? pornDomainError : gamblingDomainError;
  if (!el) return;
  el.textContent = msg || "";
}

async function renderDomainsUI(defaultLists, customDomains) {
  if (!pornDomainsEl || !gamblingDomainsEl) return;

  const defaultsPorn = uniq(defaultLists?.porn || []);
  const defaultsGambling = uniq(defaultLists?.gambling || []);
  const customPorn = uniq(customDomains?.porn || []);
  const customGambling = uniq(customDomains?.gambling || []);

  pornDomainsEl.innerHTML = "";
  gamblingDomainsEl.innerHTML = "";

  // Defaults (non-removable)
  for (const d of defaultsPorn) pornDomainsEl.appendChild(chip(d, { variant: "default" }));
  for (const d of defaultsGambling) gamblingDomainsEl.appendChild(chip(d, { variant: "default" }));

  // Customs (removable)
  for (const d of customPorn) {
    pornDomainsEl.appendChild(
      chip(d, {
        removable: true,
        variant: "custom",
        onRemove: async () => {
          const st = await get(null);
          const cur = (await ensureCustomDomains(st));
          cur.porn = (cur.porn || []).filter((x) => x !== d);
          await set({ [CUSTOM_DOMAINS_KEY]: cur });
          await renderDomainsUI(defaultLists, cur);
        },
      })
    );
  }
  for (const d of customGambling) {
    gamblingDomainsEl.appendChild(
      chip(d, {
        removable: true,
        variant: "custom",
        onRemove: async () => {
          const st = await get(null);
          const cur = (await ensureCustomDomains(st));
          cur.gambling = (cur.gambling || []).filter((x) => x !== d);
          await set({ [CUSTOM_DOMAINS_KEY]: cur });
          await renderDomainsUI(defaultLists, cur);
        },
      })
    );
  }
}

async function addDomain(category, defaultLists) {
  const input = category === "porn" ? pornDomainInput : gamblingDomainInput;
  if (!input) return;
  setError(category, "");

  const normalized = normalizeDomainInput(input.value);
  if (!isValidDomainPattern(normalized)) {
    setError(category, "Enter a valid domain like example.com (or *.example.com).");
    return;
  }

  const defaults = uniq(defaultLists?.[category] || []);
  if (defaults.includes(normalized)) {
    setError(category, "That domain is already included in the defaults.");
    input.value = "";
    return;
  }

  const st = await get(null);
  const cur = await ensureCustomDomains(st);
  const list = uniq(cur?.[category] || []);
  if (list.includes(normalized)) {
    setError(category, "You already added that domain.");
    input.value = "";
    return;
  }

  cur[category] = uniq([...(cur[category] || []), normalized]);
  await set({ [CUSTOM_DOMAINS_KEY]: cur });
  input.value = "";
  await renderDomainsUI(defaultLists, cur);
}

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
        // Backend expects per-category grace
        grace: { porn: opts.grace, gambling: opts.grace },
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

  // Domains UI
  try {
    const defaults = await loadDefaultDomainLists();
    const custom = await ensureCustomDomains(st);
    await renderDomainsUI(defaults, custom);

    pornDomainAddBtn?.addEventListener("click", () => addDomain("porn", defaults));
    gamblingDomainAddBtn?.addEventListener("click", () =>
      addDomain("gambling", defaults)
    );
    pornDomainInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") addDomain("porn", defaults);
    });
    gamblingDomainInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") addDomain("gambling", defaults);
    });
  } catch (e) {
    console.warn("[ViceBank] Failed to load domain lists UI", e);
  }
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
