
import { get } from "../lib/storage.js";

const usageEl = document.getElementById("usage");
const billingEl = document.getElementById("billing");
const endBtn = document.getElementById("end");
const pauseBtn = document.getElementById("pause");
const manageBtn = document.getElementById("manage");

async function refresh() {
  const st = await new Promise(res => chrome.runtime.sendMessage({ type: "VB_GET_STATE" }, (r) => res(r?.state)));
  const c = st?.counters || {};
  usageEl.innerHTML = `
    <h3>Today</h3>
    <div>Porn: free ${c.porn?.freeMin||0}m / <strong>paid ${c.porn?.paidMin||0}m</strong></div>
    <div>Gambling: free ${c.gambling?.freeMin||0}m / <strong>paid ${c.gambling?.paidMin||0}m</strong></div>
  `;
  billingEl.innerHTML = `
    <h3>Rates</h3>
    <div>Porn: $${st.rates?.porn?.toFixed(2)||"0.00"}/min</div>
    <div>Gambling: $${st.rates?.gambling?.toFixed(2)||"0.00"}/min</div>
  `;
}
refresh();

endBtn.onclick = async () => {
  const st = await get(null);
  // End paid sessions
  st.paidActive = { porn: false, gambling: false };
  await chrome.runtime.sendMessage({ type: "VB_SETTINGS_UPDATE", payload: { paidActive: st.paidActive } });
  await refresh();
};

pauseBtn.onclick = async () => {
  await chrome.runtime.sendMessage({ type: "VB_SETTINGS_UPDATE", payload: { enabled: false } });
  await refresh();
  setTimeout(async () => {
    await chrome.runtime.sendMessage({ type: "VB_SETTINGS_UPDATE", payload: { enabled: true } });
    await refresh();
  }, 10_000); // resume after 10s for demo
};

manageBtn.onclick = async () => {
  const st = await get(null);
  if (!st.backendBaseUrl) return;
  try {
    const resp = await fetch(`${st.backendBaseUrl}/api/portal?userId=${encodeURIComponent(st.userId)}`);
    const data = await resp.json();
    if (data.url) chrome.tabs.create({ url: data.url });
  } catch {}
};
