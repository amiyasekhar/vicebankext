import { set } from "./storage.js";

export function hostFromUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname || "";
  } catch {
    return "";
  }
}

export function todayLocalISO() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function sha256Hex(str) {
  // Returns Promise<string>
  const enc = new TextEncoder().encode(str);
  return crypto.subtle.digest("SHA-256", enc).then((buf) => {
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  });
}

export function uuidv4() {
  // RFC 4122 version 4
  return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) =>
    (
      c ^
      (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))
    ).toString(16)
  );
}
// utils.js
export async function ensureSession(st) {
  if (!st.userId) st.userId = uuidv4();

  // Keep session stable per day
  if (!st.sessionId || st.sessionDate !== todayLocalISO()) {
    st.sessionId = `session_${todayLocalISO()}`;
    st.sessionDate = todayLocalISO();
  }

  // Always (re)register session with backend in case backend restarted.
  // This is safe/idempotent for the backend's in-memory session map.
  try {
    await fetch(`${st.backendBaseUrl}/api/session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: st.userId,
        sessionId: st.sessionId,
        extensionVersion: chrome.runtime.getManifest().version,
        tzOffsetMinutes: new Date().getTimezoneOffset(),
      }),
    });
  } catch (e) {
    // If backend is down, tracking will retry on next tick.
  }

  await set({
    userId: st.userId,
    sessionId: st.sessionId,
    sessionDate: st.sessionDate,
  });

  return st;
}

// ---------- Helper to send tick to backend ----------
export async function syncMinuteToBackend(st, url, category) {
  try {
    st = await ensureSession(st); // <-- make sure backend knows session

    const payload = {
      userId: st.userId,
      sessionId: st.sessionId,
      events: [{ url, seconds: 60, category }],
    };
    console.log("payload = ", payload);
    const res = await fetch(`${st.backendBaseUrl}/api/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) throw new Error(`Backend responded ${res.status}`);
    const json = await res.json();
    console.log("[ViceBank] Synced tick:", json);
  } catch (err) {
    console.warn("[ViceBank] Failed to sync tick:", err.message);
  }
}
