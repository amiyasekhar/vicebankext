import { get, set } from "../lib/storage.js";
import { sha256Hex } from "../lib/util.js";

const agreeBtn = document.getElementById("agree");
const backendInput = document.getElementById("backendUrl");
const graceInput = document.getElementById("graceInput");
const ratePornInput = document.getElementById("ratePornInput");
const rateGamblingInput = document.getElementById("rateGamblingInput");

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

// Attach listeners and run initial check
document.addEventListener("DOMContentLoaded", () => {
  document
    .querySelectorAll(".checks input[type=checkbox]")
    .forEach((c) => c.addEventListener("change", validateChecks));

  validateChecks();
});
agreeBtn.onclick = async () => {
  const grace = parseGraceToMinutes(graceInput.value);
  let ratePorn = Math.max(0.05, Number(ratePornInput.value || 0));
  let rateGambling = Math.max(0.5, Number(rateGamblingInput.value || 0));

  const st = await get(null);
  const tosText = `ViceBank ToS and Billing Policy v1 — grace ${grace}, rates porn ${ratePorn}, gambling ${rateGambling}`;
  const tosHash = await sha256Hex(tosText);

  const backendBaseUrl = backendInput.value || "http://localhost:4242";
  await set({
    backendBaseUrl,
    grace: { porn: grace, gambling: grace },
    rates: { porn: ratePorn, gambling: rateGambling },
  });

  // Register consent with backend (server captures IP/UA)
  try {
    await fetch(`${backendBaseUrl}/api/consent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: st.userId,
        extensionVersion: chrome.runtime.getManifest().version,
        grace,
        rates: { porn: ratePorn, gambling: rateGambling },
        categoriesOn: { porn: true, gambling: true },
        tosHash,
      }),
    });
  } catch (e) {
    console.warn("Consent post failed", e);
  }

  // Create Stripe customer/subscription and return portal URL
  let email = null;
  try {
    email = (await chrome.identity.getProfileUserInfo?.())?.email || null;
  } catch {}
  chrome.runtime.sendMessage({ type: "VB_REGISTER_BACKEND", email }, (r) => {
    if (r?.portalUrl) {
      chrome.tabs.create({ url: r.portalUrl });
    }
    window.close();
  });
};

// Load current values
(async function init() {
  const st = await get(null);
  backendInput.value = st.backendBaseUrl || "http://localhost:4242";
  // Show as mm:ss; default 3:00
  const g = st.grace?.porn ?? 3;
  graceInput.value = `${String(g).padStart(1, "0")}:00`;
  ratePornInput.value = st.rates?.porn ?? 0.05;
  rateGamblingInput.value = st.rates?.gambling ?? 0.5;
})();
