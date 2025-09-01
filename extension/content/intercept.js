
let vbModalEl = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "VB_SHOW_MODAL") {
    showVBModal(msg.category, msg.rate, msg.domain);
  }
});

function showVBModal(category, rate, domain) {
  if (vbModalEl) return;
  vbModalEl = document.createElement("div");
  vbModalEl.className = "vb-modal-backdrop";
  vbModalEl.innerHTML = `
    <div class="vb-modal">
      <h2>Free time used for ${category}</h2>
      <p>You’ve used your free minutes today on <strong>${domain}</strong>.<br/>
      Continue at <strong>$${rate.toFixed(2)}/min</strong>? Charges round up to the next minute.</p>
      <div class="vb-actions">
        <button id="vb-continue">Continue Paid</button>
        <button id="vb-stop">Stop & Leave</button>
      </div>
    </div>
  `;
  document.documentElement.appendChild(vbModalEl);

  const cont = vbModalEl.querySelector("#vb-continue");
  const stop = vbModalEl.querySelector("#vb-stop");

  cont.onclick = () => {
    chrome.runtime.sendMessage({ type: "VB_CONTINUE_PAID", category });
    removeVBModal();
  };
  stop.onclick = () => {
    chrome.runtime.sendMessage({ type: "VB_STOP_AND_LEAVE" });
    removeVBModal();
    window.location.href = "about:blank";
  };
}

function removeVBModal() {
  if (vbModalEl && vbModalEl.parentNode) vbModalEl.parentNode.removeChild(vbModalEl);
  vbModalEl = null;
}
