// AVNI Pulse - talking to Supabase.
// rpc(): calls one pulse_* database function over HTTPS.
// watchEvent(): keeps a screen up to date. It listens on Supabase Realtime for the event's counter (pulse_ticks) and,
// on every change, asks for the fresh state once. If the live line is down, it asks every 3 seconds instead, so a
// phone on a weak network still sees new questions; when the line is up it still checks every 20 seconds.
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

export async function rpc(name, args = {}) {
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
  } catch {
    throw new Error('No connection. Check the internet on this device and try again.');
  }
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const msg = (body && (body.message || body.hint || body.error)) || `The server answered ${res.status}`;
    throw new Error(String(msg).replace(/^PULSE:\s*/, ''));
  }
  return body;
}

/** A small store that survives a missing or blocked browser storage. */
export const store = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private window: works for this visit only */ }
  },
};

export function newId() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16);
  (globalThis.crypto || window.msCrypto).getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Calls refresh() whenever the event changes.
 * onStatus(state) gets 'live' (realtime line joined) or 'polling' (line down, checking every 3 s).
 */
export function watchEvent(eventId, refresh, onStatus = () => {}) {
  let ws = null; let joined = false; let stopped = false; let ref = 1; let beat = null; let retry = 1000;
  let busy = false; let again = false; let lastFetch = 0;

  const run = async () => {
    if (busy) { again = true; return; }
    busy = true; lastFetch = Date.now();
    try { await refresh(); } catch (e) { console.warn('refresh failed', e); }
    busy = false;
    if (again) { again = false; setTimeout(run, 150); }
  };
  const setJoined = (v) => { joined = v; onStatus(v ? 'live' : 'polling'); };

  const connect = () => {
    if (stopped) return;
    const url = `${SUPABASE_URL.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=${encodeURIComponent(SUPABASE_KEY)}&vsn=1.0.0`;
    try { ws = new WebSocket(url); } catch { setTimeout(connect, retry); return; }
    ws.onopen = () => {
      retry = 1000;
      const joinRef = String(ref++);
      ws.send(JSON.stringify({
        topic: `realtime:pulse-${eventId}`, event: 'phx_join', ref: joinRef, join_ref: joinRef,
        payload: {
          config: {
            broadcast: { self: false }, presence: { key: '' }, private: false,
            postgres_changes: [{ event: '*', schema: 'public', table: 'pulse_ticks', filter: `event_id=eq.${eventId}` }],
          },
          access_token: SUPABASE_KEY,
        },
      }));
      beat = setInterval(() => {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(ref++) }));
      }, 25000);
    };
    ws.onmessage = (m) => {
      let msg; try { msg = JSON.parse(m.data); } catch { return; }
      if (msg.event === 'phx_reply' && msg.topic !== 'phoenix') {
        if (msg.payload && msg.payload.status === 'ok') { setJoined(true); run(); } else setJoined(false);
      } else if (msg.event === 'postgres_changes') {
        run();
      } else if (msg.event === 'system' && msg.payload && msg.payload.status === 'error') {
        setJoined(false);
      } else if (msg.event === 'phx_error' || msg.event === 'phx_close') {
        setJoined(false);
      }
    };
    ws.onclose = () => {
      clearInterval(beat); setJoined(false);
      if (!stopped) { setTimeout(connect, retry); retry = Math.min(retry * 2, 15000); }
    };
    ws.onerror = () => { try { ws.close(); } catch { /* closed already */ } };
  };

  const timer = setInterval(() => {
    const gap = joined ? 20000 : 3000;
    if (Date.now() - lastFetch >= gap) run();
  }, 1000);
  const onVisible = () => { if (document.visibilityState === 'visible') run(); };
  document.addEventListener('visibilitychange', onVisible);

  onStatus('polling');
  connect();
  run();
  return {
    now: run,
    stop() {
      stopped = true; clearInterval(timer); clearInterval(beat);
      document.removeEventListener('visibilitychange', onVisible);
      try { ws && ws.close(); } catch { /* closed already */ }
    },
  };
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Server clock minus this device's clock, in ms (for the quiz countdown). */
export function skewFrom(serverNowIso) {
  const t = Date.parse(serverNowIso);
  return Number.isFinite(t) ? t - Date.now() : 0;
}
