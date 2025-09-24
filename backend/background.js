// background.js
const API_BASE = "http://localhost:4242";
const USER_ID = "james123"; // Normally you'd store this after login
let currentSessionId = null;
let lastSent = Date.now();
let activeDomain = null;

async function startSession() {
  currentSessionId = `session_${Date.now()}`;
  await fetch(`${API_BASE}/api/session/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userId: USER_ID,
      sessionId: currentSessionId,
      extensionVersion: "1.0.0",
    }),
  });
  console.log("Session started:", currentSessionId);
}

// Match against your category list
const WATCHLIST = ["pornhub.com", "xvideos.com", "stake.com", "draftkings.com"];

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

async function trackActiveTab(url) {
  const domain = getDomain(url);
  if (!domain || !WATCHLIST.some((site) => domain.includes(site))) {
    activeDomain = null;
    return;
  }

  // If already tracking this domain, just accumulate time
  const now = Date.now();
  const seconds = Math.floor((now - lastSent) / 1000);
  lastSent = now;
  activeDomain = domain;

  if (seconds > 0) {
    await fetch(`${API_BASE}/api/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: USER_ID,
        sessionId: currentSessionId,
        events: [{ url, seconds }],
      }),
    });
    console.log(`Tracked ${seconds}s on ${domain}`);
  }
}

// Check active tab every 15 seconds
setInterval(() => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs.length > 0) {
      trackActiveTab(tabs[0].url);
    }
  });
}, 15000);

// Start session when extension loads
startSession();
