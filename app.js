'use strict';
/* ═══════════════════════════════════════════════════════════════
   Garmin-Übersicht — Oberfläche, Speicher, Abgleich

   Abschnitte
   1. Konstanten, Datenmodell, Persistenz, Theme
   2. Helfer und Formatierung
   3. Schlüssel, Token, API (über den Proxy)
   4. Abgleich mit Garmin
   5. Zwischenspeicher für Aktivitätskurven (IndexedDB)
   6. Navigation und Diagramm-Ablesen
   7. Heute
   8. Trends
   9. Training und Aktivität
   10. Muster
   11. Einstellungen, Proxy-Anleitung, Backup
   12. Sheet, Dialoge, Zurück-Taste, Updates, Installieren, Start

   Rechnen und Umrechnen steckt in core.js, Zeichnen in charts.js, das
   Lesen der Aktivitätsdateien in fit.js. Hier bleibt, was DOM, Speicher
   oder Netz braucht.
   ═══════════════════════════════════════════════════════════════ */

/* ── 1. Konstanten, Datenmodell, Persistenz ─────────────────── */

const KEY = 'garmin.v1';
/* Bei jeder Änderung hochzählen — wird in den Einstellungen angezeigt, damit
   sich auf dem Handy prüfen lässt, welche Fassung wirklich läuft. */
const APP_VERSION = '1.1.0';

const THEME_KEY = 'garmin.theme';
/* Schlüssel und Token liegen getrennt vom Datensatz: So landen sie nie in
   einem Backup, und ein Backup-Import überschreibt sie nicht. */
const APIKEY_KEY = 'garmin.key';
const TOKEN_KEY = 'garmin.token';

const TOKEN_PATH = '/personalapitoken-service/personal-api/personal-api-key/token';
const KEY_PAGE = 'https://connect.garmin.com/app/settings/personalApiToken';
const CF_PAGE = 'https://dash.cloudflare.com/';

/* `bar` ist die Hintergrundfarbe des Themes und landet im
   <meta name="theme-color">, damit die Systemleiste des Handys mitzieht —
   muss mit --bg in style.css übereinstimmen. */
const THEMES = {
  dark: { label: 'Dunkel', bar: '#0b0e14' },
  light: { label: 'Hell', bar: '#f3f5f9' },
};

/** Frische Grundstruktur. Basis beim Laden und beim Backup-Import, damit
    später ergänzte Felder in alten Daten nicht fehlen. */
const blank = () => ({
  v: 1,
  days: {},             // 'YYYY-MM-DD' → Tageswerte, Schlüssel siehe Core.FIELDS
  acts: [],             // Aktivitäten, neueste zuerst (Core.mapActivity)
  profile: {
    maxHr: null,        // aus Garmins Pulszonen — für die Belastung ohne Garmin-Wert
    rhr: null,
    zones: null,        // Untergrenzen der Zonen 1–5
    fetched: null,      // Tag des letzten Abrufs
    sleep: null,        // Schlaf-Bezugswerte der neuesten Nacht: {date, opt, next, win} (Core.mapSleep → ref)
  },
  sync: {
    last: null,         // ISO-Zeit des letzten erfolgreichen Abgleichs
    to: null,           // neuester abgerufener Tag
    from: null,         // ältester abgerufener Tag
    floor: null,        // davor gibt es bei Garmin nichts mehr (zwei leere Blöcke)
    empty: 0,           // leere Blöcke in Folge beim Rückwärtsladen
    error: null,        // letzte Fehlermeldung, bis zum nächsten Erfolg
    warn: {},           // Quelle → Meldung, wenn nur ein Teil fehlschlug
    gaps: {},           // Quelle → [[von, bis, Fehlversuche], …], wird nachgeholt (siehe SYNC_REV)
    rev: 0,             // Fassung des Abgleichs, mit der der Verlauf zuletzt geprüft wurde
    sleepV: 0,          // mit welcher Fassung von Core.mapSleep der Schlaf-Verlauf geladen ist
    sleepFill: null,    // Nachladen des Schlafs: bis zu diesem Tag (rückwärts) erledigt
  },
  settings: {
    proxy: '',          // Adresse des Cloudflare Workers
    history: 365,       // so viele Tage Verlauf holt der Abgleich
    autoSync: true,     // beim Öffnen abgleichen, wenn der letzte Abgleich > 1 h her ist
  },
  theme: 'dark',
  setup: false,         // erster Abgleich gelungen?
  lastBackup: null,
});

let db = blank();
let idx = { load: {}, trainMin: {}, late: {}, vo2: {} };

/** Fremden Datensatz (aus localStorage oder Backup) auf die aktuelle Struktur
    bringen. Object.assign allein reicht nicht: es ersetzt verschachtelte
    Objekte im Ganzen — ein älteres Unterobjekt ohne ein neues Feld würde die
    Vorgabe nicht ergänzen, sondern löschen. Daten haben Vorrang vor Vorgabe. */
function normalize(src) {
  const base = blank();
  const d = Object.assign(blank(), src || {});
  delete d.meta;                                   // Kopfdaten des Backups gehören nicht in die Daten
  for (const k of ['profile', 'sync', 'settings']) {
    d[k] = Object.assign({}, base[k], (src && typeof src[k] === 'object' && src[k]) || {});
  }
  d.sync.warn = (d.sync.warn && typeof d.sync.warn === 'object') ? d.sync.warn : {};
  const gs = (d.sync.gaps && typeof d.sync.gaps === 'object') ? d.sync.gaps : {};
  const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  d.sync.gaps = {};
  for (const k of Object.keys(gs)) {
    const list = Array.isArray(gs[k]) ? gs[k].filter((g) => Array.isArray(g) && isDay(g[0]) && isDay(g[1]) && g[0] <= g[1]) : [];
    if (list.length) d.sync.gaps[k] = list.map((g) => [g[0], g[1], +g[2] || 0]);
  }
  const ps = d.profile.sleep;
  if (!ps || typeof ps !== 'object' || typeof ps.date !== 'string') d.profile.sleep = null;
  d.days = (d.days && typeof d.days === 'object' && !Array.isArray(d.days)) ? d.days : {};
  for (const k of Object.keys(d.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !d.days[k] || typeof d.days[k] !== 'object') delete d.days[k];
  }
  d.acts = Array.isArray(d.acts) ? d.acts.filter((a) => a && a.id != null && typeof a.date === 'string') : [];
  d.acts.forEach((a) => { if (typeof a.start !== 'string') a.start = a.date + ' 00:00'; if (!a.type) a.type = 'other'; });
  if (![365, 730, 1825].includes(+d.settings.history)) d.settings.history = 365;
  d.settings.proxy = String(d.settings.proxy || '');
  if (!THEMES[d.theme]) d.theme = base.theme;
  return d;
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    db = normalize(JSON.parse(raw));
  } catch (e) { console.warn('Laden fehlgeschlagen', e); }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); }
  catch (e) { toast('Speichern fehlgeschlagen — Speicher voll?'); console.error(e); }
}
/** Nach jeder Datenänderung: abgeleitete Tageswerte neu berechnen. */
function reindex() {
  db.acts.sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : 0));
  idx = Core.buildIndex(db);
}

/** Theme aufs Dokument legen. Der Spiegel in THEME_KEY ist das, was das
    Startskript in index.html liest — ohne ihn flackert der Start. */
function applyTheme(t) {
  if (!THEMES[t]) t = 'dark';
  db.theme = t;
  document.documentElement.dataset.theme = t;
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.content = THEMES[t].bar;
  try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* nicht schlimm */ }
}

/* ── 2. Helfer und Formatierung ─────────────────────────────── */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fin = Core.fin;
const M = Core.METRICS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n) => String(n).padStart(2, '0');

/* Formatierung immer über Intl — nie von Hand mit toFixed und Komma-Ersatz. */
const nf0 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nfPct = new Intl.NumberFormat('de-DE', { style: 'percent', maximumFractionDigits: 0, signDisplay: 'exceptZero' });
const dfDay = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric', month: 'short' });
const dfDayY = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const dfDate = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'short', year: 'numeric' });
const dfMonth = new Intl.DateTimeFormat('de-DE', { month: 'short' });
const dfMonthY = new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' });
const dfTime = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
const dfLong = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });

const pdate = (d) => Core.parseDate(d);
function dayLabel(d) {
  const t = Core.today();
  if (d === t) return 'Heute';
  if (d === Core.addDays(t, -1)) return 'Gestern';
  return (d.slice(0, 4) === t.slice(0, 4) ? dfDay : dfDayY).format(pdate(d));
}
/** „vor 5 min", „heute 13:05", „gestern 21:40", sonst Datum. */
function agoLabel(iso) {
  if (!iso) return '';
  const t = new Date(iso), mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'gerade eben';
  if (mins < 60) return `vor ${mins} min`;
  const d = Core.isoDate(t);
  if (d === Core.today()) return 'heute ' + dfTime.format(t);
  if (d === Core.addDays(Core.today(), -1)) return 'gestern ' + dfTime.format(t);
  return dfDate.format(t);
}
function isoWeek(s) {
  const d = pdate(s);
  const th = new Date(d); th.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const jan4 = new Date(th.getFullYear(), 0, 4);
  return 1 + Math.round(((th - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
}
const km = (m) => (fin(m) && m > 0 ? (m >= 10000 ? nf1 : nf2).format(m / 1000) + ' km' : '–');
/** Sekunden → „52:10" oder „1:05:32". */
function hms(s) {
  if (!fin(s)) return '–';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${pad2(m)}:${pad2(x)}` : `${m}:${pad2(x)}`;
}
/** Laufen und Gehen in min/km, Schwimmen in min/100 m, alles andere km/h. */
function speedText(spd, type) {
  if (!fin(spd) || spd <= 0) return '–';
  const sp = Core.sportOf(type);
  if (sp === 'swim') return hms(100 / spd) + ' /100 m';
  if (sp === 'run' || sp === 'walk') return hms(1000 / spd) + ' /km';
  return nf1.format(spd * 3.6) + ' km/h';
}
const usesPace = (type) => ['run', 'walk', 'swim'].includes(Core.sportOf(type));

/** Wert für große Anzeigen in Zahl und kleine Einheit getrennt. */
function splitVal(key, v) {
  if (!fin(v)) return ['–', ''];
  const m = M[key] || {};
  if (m.fmt === 'dur' || m.fmt === 'min') {
    const mins = Math.round(m.fmt === 'dur' ? v / 60 : v);
    // Schlafsaldo kann negativ sein
    const a = Math.abs(mins), sign = mins < 0 ? '−' : '';
    return a < 60 ? [sign + a, 'min'] : [`${sign}${Math.floor(a / 60)}:${pad2(a % 60)}`, 'h'];
  }
  if (m.fmt === 'clock') return [Core.fmtClock(v), 'Uhr'];
  return [Core.fmt(key, v, true), m.unit || ''];
}
const valHtml = (key, v) => { const [a, u] = splitVal(key, v); return `${esc(a)}${u ? `<small>${esc(u)}</small>` : ''}`; };

/* Werte, die sich über den Tag erst ansammeln: heute noch nicht bewerten,
   sonst stünden morgens immer „zu wenig Schritte" da. */
const ACCUM = ['steps', 'im', 'kcalAct', 'floors', 'load', 'trainMin', 'bbChg'];

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}

const ICON = {
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17h.01"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20s-7-4.4-8.6-8.8C2.2 7.9 4.1 5 7.2 5c2 0 3.4 1.1 4.8 2.8C13.4 6.1 14.8 5 16.8 5c3.1 0 5 2.9 3.8 6.2C19 15.6 12 20 12 20z"/></svg>',
  watch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="3"/><path d="M9 6l1-3h4l1 3M9 18l1 3h4l1-3M12 9.5V12l1.5 1.5"/></svg>',
};
const SPORT_ICON = {
  run: '<circle cx="14" cy="4" r="2"/><path d="M8 21l3-7 3 3v4"/><path d="M6 12l3-4 4 1 3 3h3"/>',
  bike: '<circle cx="6" cy="16" r="3.5"/><circle cx="18" cy="16" r="3.5"/><path d="M6 16l4-7h5l3 7M9 6h3M15 9l-3 7"/>',
  swim: '<path d="M2 18c2 0 2-1.5 4-1.5S8 18 10 18s2-1.5 4-1.5 2 1.5 4 1.5 2-1.5 4-1.5"/><path d="M6 13l4-5 4 3 3-3"/><circle cx="18" cy="5" r="2"/>',
  walk: '<circle cx="13" cy="4" r="2"/><path d="M9 21l2-6 3 2v4M8 12l2-4 4 1 2 4"/>',
  strength: '<path d="M6 7v10M18 7v10M3 10v4M21 10v4M6 12h12"/>',
  winter: '<path d="M12 2v20M4.9 4.9l14.2 14.2M2 12h20M4.9 19.1 19.1 4.9"/>',
  other: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
};
const sportIcon = (type) => {
  const sp = Core.sportOf(type);
  return `<span class="act-ic sp-${sp}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${SPORT_ICON[sp]}</svg></span>`;
};

/* ── 3. Schlüssel, Token, API ───────────────────────────────── */
/* Ablauf laut Garmin: Mit dem API-Schlüssel holt man einen Token (gilt 24 h,
   keine Verlängerung), mit dem Token die Daten. Alles geht über den Proxy,
   weil Garmin Browser-Aufrufe ablehnt (siehe DECISIONS.md). */

function keyGet() { try { return localStorage.getItem(APIKEY_KEY) || ''; } catch (e) { return ''; } }
function keySet(k) {
  try {
    if (k) localStorage.setItem(APIKEY_KEY, k); else localStorage.removeItem(APIKEY_KEY);
    localStorage.removeItem(TOKEN_KEY);
  } catch (e) { toast('Schlüssel ließ sich nicht speichern'); }
}
/** Kurzer Fingerabdruck des Schlüssels: ein gespeicherter Token gilt nur
    für den Schlüssel, mit dem er geholt wurde. */
function fingerprint(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}
const proxyBase = () => db.settings.proxy.trim().replace(/\/+$/, '');
const isConfigured = () => !!(proxyBase() && keyGet());

function apiErr(kind, msg, status) { const e = new Error(msg); e.kind = kind; e.status = status; return e; }

/* Hinter dem Cloudflare Worker antwortet Garmin auf die meisten Anfragen
   mit 526 (Cloudflare bekommt zu Garmins Servern keine gültige
   TLS-Verbindung), direkt aufgerufen nie — gemessen am 23.10.2026: 25 von
   30 Anfragen über den Worker, 0 von 6 direkt. Jede Anfrage ist ein eigener
   Worker-Aufruf und gelingt unabhängig von der vorigen, also gleich noch
   einmal. Ebenso bei 502–504 und den übrigen Cloudflare-Fehlern 520–530.
   Bei einem Treffer auf fünf Versuche scheitern nach 25 Versuchen noch
   etwa 1 % der Anfragen — die holt der nächste Abgleich nach. */
const FLAKY_TRIES = 25;
const flaky = (s) => s === 502 || s === 503 || s === 504 || (s >= 520 && s <= 530);

/** Anfrage an den Proxy, bei den Fehlern oben bis zu FLAKY_TRIES Mal.
    `before(n)` läuft vor dem n-ten Versuch (ab dem zweiten) und darf mit
    einer Ausnahme abbrechen. */
async function steadyFetch(url, init, timeout, before) {
  for (let n = 1; ; n++) {
    const res = await rawFetch(url, init, timeout);
    if (!flaky(res.status) || n >= FLAKY_TRIES) return res;
    try { if (res.body) res.body.cancel(); } catch (e) { /* egal */ }
    await sleep(300);
    if (before) before(n + 1);
  }
}

async function rawFetch(url, init, timeout) {
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), timeout || 45000);
  try {
    return await fetch(url, Object.assign({ signal: ctl.signal, cache: 'no-store' }, init));
  } catch (e) {
    if (navigator.onLine === false) throw apiErr('net', 'Keine Internetverbindung.');
    if (e && e.name === 'AbortError') throw apiErr('net', 'Keine Antwort vom Proxy (Zeitüberschreitung).');
    throw apiErr('net', 'Der Proxy ist nicht erreichbar. Stimmt die Adresse, und ist der Worker bereitgestellt?');
  } finally { clearTimeout(tm); }
}

async function httpError(res, isToken) {
  let body = '';
  try { body = await res.text(); } catch (e) { /* egal */ }
  try { const j = JSON.parse(body); if (j && j.proxy) return apiErr('proxy', j.message, res.status); } catch (e) { /* kein JSON */ }
  const s = res.status;
  if (isToken && (s === 400 || s === 401 || s === 403)) {
    return apiErr('key', 'Garmin lehnt den API-Schlüssel ab. Ist er abgelaufen oder unvollständig kopiert? Auf connect.garmin.com lässt sich jederzeit ein neuer erzeugen.', s);
  }
  if (s === 401) return apiErr('auth', 'Garmin hat die Anmeldung abgelehnt (401).', s);
  if (s === 403) return apiErr('forbidden', 'Garmin verweigert den Zugriff auf diese Daten (403).', s);
  if (s === 404) return apiErr('missing', 'Garmin kennt diese Daten nicht (404).', s);
  if (s === 429) return apiErr('rate', 'Garmin bremst gerade wegen zu vieler Anfragen. In ein paar Minuten geht es weiter.', s);
  if (flaky(s)) return apiErr('path', `Der Weg vom Proxy zu Garmin klemmt gerade (Fehler ${s}, auch nach ${FLAKY_TRIES} Versuchen). Später noch einmal abgleichen.`, s);
  if (s >= 500) return apiErr('server', `Garmin meldet einen Serverfehler (${s}). Später noch einmal versuchen.`, s);
  return apiErr('http', `Unerwartete Antwort von Garmin (${s}).`, s);
}

function tokenGet() { try { return JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null'); } catch (e) { return null; } }

async function ensureToken(force) {
  const key = keyGet().trim();
  if (!key) throw apiErr('nokey', 'Kein API-Schlüssel eingetragen.');
  if (!proxyBase()) throw apiErr('noproxy', 'Keine Proxy-Adresse eingetragen.');
  const kf = fingerprint(key);
  const tk = tokenGet();
  // Eine Stunde Puffer, wie Garmins eigener Client: kein Token läuft mitten im Abgleich ab
  if (!force && tk && tk.kf === kf && tk.exp - Date.now() > 3600e3) return tk.t;
  const res = await steadyFetch(proxyBase() + TOKEN_PATH, { method: 'POST', headers: { Authorization: 'ApiKey ' + key, Accept: '*/*' } });
  if (!res.ok) throw await httpError(res, true);
  let t = (await res.text()).trim();
  // Laut Doku kommt der Token als nackter Text; falls doch einmal JSON, das Feld nehmen
  if (t.startsWith('{')) { try { const j = JSON.parse(t); t = j.access_token || j.accessToken || j.token || ''; } catch (e) { t = ''; } }
  t = t.replace(/^"|"$/g, '');
  if (!t) throw apiErr('token', 'Garmin hat keinen Token geliefert.');
  let exp = Date.now() + 23 * 3600e3;
  try {
    const p = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (p.exp) exp = p.exp * 1000;
  } catch (e) { /* kein JWT — dann eben die 23 Stunden */ }
  try { localStorage.setItem(TOKEN_KEY, JSON.stringify({ t, exp, kf })); } catch (e) { /* hält dann nur bis zum Neuladen */ }
  return t;
}

/* Garmin nennt keine Grenzen für Anfragen pro Minute. Ein kleiner Abstand
   zwischen den Anfragen hält den Erst-Abruf (rund 40 Anfragen pro Jahr)
   freundlich. */
let lastReq = 0;
async function pace() {
  const w = lastReq + 250 - Date.now();
  if (w > 0) await sleep(w);
  lastReq = Date.now();
}

/** GET an die Personal API. Wiederholt bei abgelaufenem Token einmal,
    wartet bei 429 (zu viele Anfragen) bis zu dreimal und versucht es bei
    Cloudflare-Fehlern sofort noch einmal (steadyFetch). */
async function api(path, opts) {
  opts = opts || {};
  let token = await ensureToken();
  const label = opts.sync ? syncMsg : '';
  const before = (n) => {
    if (!opts.sync) return;
    checkStop();
    progress(`${label} · Versuch ${n}`);
  };
  for (let attempt = 0; ; attempt++) {
    if (opts.sync) checkStop();
    await pace();
    const res = await steadyFetch(proxyBase() + path, {
      headers: { Authorization: 'Bearer ' + token, Accept: opts.accept || 'application/json' },
    }, opts.binary ? 90000 : 45000, before);
    if (res.status === 401 && attempt === 0) { token = await ensureToken(true); continue; }
    if (res.status === 429 && attempt < 3) {
      const ra = parseInt(res.headers.get('Retry-After'), 10);
      const wait = Math.min(120, isFinite(ra) && ra > 0 ? ra : 20 * (attempt + 1));
      if (opts.sync) progress(`Garmin bremst — warte ${wait} s …`);
      await sleep(wait * 1000);
      continue;
    }
    if (res.status === 204) return null;
    if (!res.ok) throw await httpError(res);
    if (opts.binary) return res.arrayBuffer();
    const txt = await res.text();
    if (!txt) return null;
    try { return JSON.parse(txt); } catch (e) { throw apiErr('parse', 'Garmin hat keine lesbare Antwort geschickt.'); }
  }
}

/* ── 4. Abgleich ────────────────────────────────────────────── */

/* Je Quelle: Abfrage und größte erlaubte Spanne laut API-Beschreibung
   (Tageswerte 1 Jahr, Schlaf 31 Tage). Für HRV und Gewicht nennt Garmin
   keine Grenze — 31 bzw. 93 Tage sind vorsichtig gewählt. */
const SOURCES = {
  daily: {
    label: 'Tageswerte', max: 365,
    get: (a, b) => api(`/usersummary-service/v2/dailysummaries?startDate=${a}&endDate=${b}`, { sync: true }),
    map: (r) => ((r && r.data) || []).map(Core.mapDaily),
  },
  sleep: {
    label: 'Schlaf', max: 31,
    get: (a, b) => api(`/sleep-service/sleep/dailySleepSummariesByDate?startDate=${a}&endDate=${b}`, { sync: true }),
    map: (r) => (Array.isArray(r) ? r : []).map(Core.mapSleep),
  },
  hrv: {
    label: 'HRV', max: 31,
    get: (a, b) => api(`/hrv-service/hrv/daily/${a}/${b}`, { sync: true }),
    map: (r) => ((r && r.hrvSummaries) || []).map(Core.mapHrv),
  },
  weight: {
    label: 'Gewicht', max: 93,
    get: (a, b) => api(`/weight-service/weight/range/${a}/${b}?includeAll=true`, { sync: true }),
    map: (r) => ((r && r.dailyWeightSummaries) || []).map(Core.mapWeight),
  },
};
const ACT_PAGE = 99;                  // Höchstwert der Aktivitätssuche
const BLOCK = 93;                     // Rückwärts in Vierteljahres-Blöcken laden
/* Hochzählen, wenn Core.mapSleep mehr aus Garmins Schlafdaten liest: Der
   nächste Abgleich holt dann den schon gespeicherten Schlaf-Verlauf einmal
   neu (31 Tage je Anfrage, ein Jahr sind 12 Anfragen). */
const SLEEP_V = 2;
/* Hochzählen, wenn ältere Fassungen beim Abgleich Daten verloren haben
   können: Der nächste Abgleich prüft dann den ganzen gespeicherten Verlauf
   einmal nach. Fassung 2: bis 1.0.1 übersprang der Abgleich bei Fehler 526
   ganze Zeiträume, ohne sie je nachzuholen. */
const SYNC_REV = 2;
/* Lücken: Zeiträume einer Quelle, deren Abruf fehlschlug (db.sync.gaps,
   Quelle → [[von, bis, Fehlversuche], …]). Jeder Abgleich holt sie nach —
   höchstens GAP_TRIES Mal, damit eine Anfrage, die Garmin grundsätzlich
   ablehnt, nicht bei jedem Abgleich Zeit kostet. */
const SRC_IDS = [...Object.keys(SOURCES), 'acts'];
const GAP_TRIES = 5;

let syncing = false;
let stopRequested = false;
let syncMsg = '';

function checkStop() { if (stopRequested) { const e = new Error('angehalten'); e.stopped = true; throw e; } }
function progress(msg) {
  syncMsg = msg;
  renderTopSub();
  const ob = $('#obMsg');
  if (ob) ob.textContent = msg;
}
const maxDate = (a, b) => (a > b ? a : b);
const fmtSpan = (a, b) => {
  const da = pdate(a), dbb = pdate(b);
  if (a.slice(0, 7) === b.slice(0, 7)) return dfMonthY.format(da);
  return `${(a.slice(0, 4) === b.slice(0, 4) ? dfMonth : dfMonthY).format(da)}–${dfMonthY.format(dbb)}`;
};

/** Fehler einer einzelnen Quelle: Netz, Schlüssel, Bremse und ein Proxy-Weg,
    der auch nach allen Versuchen klemmt, brechen den ganzen Abgleich ab —
    der nächste macht dort weiter. Alles andere (z. B. eine Uhr ohne HRV)
    trifft nur diese Quelle und diesen Zeitraum: Er wird als Lücke vermerkt. */
const fatal = (e) => e.stopped || ['net', 'key', 'nokey', 'noproxy', 'proxy', 'auth', 'rate', 'token', 'path'].includes(e.kind);

/** [a, b] aus den Lücken der Quelle `id` herausschneiden. */
function cutGap(id, a, b) {
  const out = [];
  for (const g of db.sync.gaps[id] || []) {
    if (g[1] < a || g[0] > b) { out.push(g); continue; }
    if (g[0] < a) out.push([g[0], Core.addDays(a, -1), g[2]]);
    if (g[1] > b) out.push([Core.addDays(b, 1), g[1], g[2]]);
  }
  if (out.length) db.sync.gaps[id] = out; else delete db.sync.gaps[id];
}
function addGap(id, a, b, tries) {
  cutGap(id, a, b);
  (db.sync.gaps[id] || (db.sync.gaps[id] = [])).push([a, b, tries]);
}
/** Lücken, die schon fehlgeschlagen sind (nicht bloß zum Nachprüfen vorgemerkt). */
const failedGaps = (id) => (db.sync.gaps[id] || []).filter((g) => g[2] > 0);

/** Eine Quelle für [a, b] holen, in den Stücken, die Garmin erlaubt. Was
    gelingt, schließt eine Lücke; was fehlschlägt, wird eine — mit `tries`
    Fehlversuchen davor. Liefert {got: Tageswerte/Aktivitäten, failed: Stücke}. */
async function fetchSource(id, a, b, actMap, tries) {
  const src = SOURCES[id];
  let got = 0, failed = 0;
  for (const [x, y] of src ? Core.chunks(a, b, src.max) : [[a, b]]) {
    progress(`${src ? src.label : 'Aktivitäten'} · ${fmtSpan(x, y)}`);
    try {
      if (src) {
        const res = await src.get(x, y);
        for (const rec of src.map(res)) if (rec && Object.keys(rec.v).length) { mergeRec(id, rec); got++; }
      } else {
        got += await fetchActs(x, y, actMap);
      }
      cutGap(id, x, y);
      if (!db.sync.gaps[id]) delete db.sync.warn[id];
    } catch (e) {
      if (fatal(e)) throw e;
      addGap(id, x, y, (tries || 0) + 1);
      db.sync.warn[id] = e.message;
      failed++;
    }
  }
  return { got, failed };
}

async function fetchBlock(a, b, actMap) {
  let got = 0, failed = 0;
  for (const id of SRC_IDS) {
    const r = await fetchSource(id, a, b, actMap);
    got += r.got; failed += r.failed;
  }
  return { got, failed };
}

/** Lücken früherer Abgleiche nachholen. Was vor dem eingestellten Verlauf
    liegt, fällt weg. */
async function fillGaps(oldest, actMap) {
  for (const id of SRC_IDS) {
    cutGap(id, '0000-01-01', Core.addDays(oldest, -1));
    for (const [a, b, tries] of (db.sync.gaps[id] || []).slice()) {
      if (tries >= GAP_TRIES) continue;
      // Stückweise speichern: Wer die App mittendrin schließt, verliert nichts
      for (const [x, y] of Core.chunks(a, b, SOURCES[id] ? SOURCES[id].max : BLOCK)) {
        await fetchSource(id, x, y, actMap, tries);
        save();
      }
      reindex(); render();
    }
  }
}

function mergeRec(id, rec) {
  Core.mergeDay(db.days, rec, Core.FIELDS[id]);
  // Idealbereiche und Bedarf für heute Nacht gelten ab der neuesten Nacht —
  // beim Rückwärtsladen darf eine ältere sie nicht überschreiben
  if (rec.ref && (!db.profile.sleep || rec.date >= db.profile.sleep.date)) db.profile.sleep = Object.assign({ date: rec.date }, rec.ref);
}

/** Schlaf-Verlauf einmal neu holen, weil die App inzwischen mehr daraus
    liest (SLEEP_V). Rückwärts in 31-Tage-Stücken; der Stand wird nach jedem
    Stück gespeichert, ein abgebrochener Durchgang macht beim nächsten
    Abgleich dort weiter. `until` ist der letzte Tag vor dem frisch
    geladenen Block. */
async function refillSleep(until) {
  const src = SOURCES.sleep;
  let end = db.sync.sleepFill ? Core.addDays(db.sync.sleepFill, -1) : until;
  while (db.sync.from && end >= db.sync.from) {
    const start = maxDate(db.sync.from, Core.addDays(end, -(src.max - 1)));
    progress(`Schlaf-Details · ${fmtSpan(start, end)}`);
    try {
      const res = await src.get(start, end);
      for (const rec of src.map(res)) if (rec && Object.keys(rec.v).length) mergeRec('sleep', rec);
    } catch (e) {
      if (fatal(e)) throw e;
      // Nicht überspringen, sonst fehlen diesem Stück die Details für immer:
      // Stand bleibt, der nächste Abgleich versucht es hier wieder
      db.sync.warn.sleep = e.message;
      return;
    }
    db.sync.sleepFill = start;
    end = Core.addDays(start, -1);
    save();
  }
  db.sync.sleepV = SLEEP_V;
  db.sync.sleepFill = null;
}

async function fetchActs(a, b, actMap) {
  const seen = new Set();
  let start = 0, n = 0;
  for (;;) {
    const page = await api(`/activitylist-service/activities/search/activities?startDate=${a}&endDate=${b}`
      + `&start=${start}&limit=${ACT_PAGE}&sortOrder=desc`, { sync: true });
    const list = Array.isArray(page) ? page : [];
    for (const raw of list) {
      const m = Core.mapActivity(raw);
      if (!m) continue;
      actMap.set(m.id, m); seen.add(m.id); n++;
    }
    if (list.length < ACT_PAGE) break;
    start += ACT_PAGE;
  }
  // In Garmin gelöschte Aktivitäten verschwinden auch hier — nur im abgefragten Zeitraum
  for (const [id, x] of actMap) if (x.date >= a && x.date <= b && !seen.has(id)) actMap.delete(id);
  db.acts = Array.from(actMap.values());
  return n;
}

async function fetchProfile() {
  try {
    const z = await api('/biometric-service/heartRateZones/v2', { sync: true });
    const list = Array.isArray(z) ? z : [];
    const p = list.find((x) => x.sport === 'DEFAULT') || list[0];
    if (p) {
      db.profile.maxHr = p.maxHeartRateUsed || null;
      db.profile.rhr = p.restingHeartRateUsed || null;
      db.profile.zones = [p.zone1Floor, p.zone2Floor, p.zone3Floor, p.zone4Floor, p.zone5Floor].every(fin)
        ? [p.zone1Floor, p.zone2Floor, p.zone3Floor, p.zone4Floor, p.zone5Floor] : null;
    }
    db.profile.fetched = Core.today();
  } catch (e) { if (fatal(e)) throw e; }
}

/** Abgleich: erst das Aktuelle (die letzten Tage, beim ersten Mal vier
    Wochen), dann der Verlauf rückwärts in Blöcken. Nach jedem Block wird
    gespeichert — wer die App zwischendurch schließt, verliert nichts, und
    der nächste Abgleich macht dort weiter. */
async function sync(manual) {
  if (syncing) {
    stopRequested = true;
    progress('Wird angehalten …');
    return;
  }
  if (!isConfigured()) { if (manual) openSettings(); return; }
  syncing = true; stopRequested = false;
  setSyncUi();
  const t = Core.today();
  const oldest = Core.addDays(t, -(db.settings.history - 1));
  const actMap = new Map(db.acts.map((a) => [a.id, a]));
  try {
    progress('Anmelden …');
    await ensureToken();
    if (!db.profile.fetched || Core.dayDiff(db.profile.fetched, t) >= 7) await fetchProfile();

    // Heute und die Tage davor ändern sich noch (Schlaf kommt morgens, Schritte laufen auf)
    const recentFrom = db.sync.to
      ? maxDate(oldest, Core.addDays(db.sync.to, -3))
      : maxDate(oldest, Core.addDays(t, -27));
    // Ohne gespeicherten Verlauf gibt es nichts nachzuladen
    if (!db.sync.from) db.sync.sleepV = SLEEP_V;
    if ((db.sync.rev || 0) < SYNC_REV) {
      // Den ganzen gespeicherten Verlauf einmal nachprüfen. Der Schlaf kommt
      // dabei ohnehin mit der neuen Umrechnung; und die Untergrenze kann von
      // fehlgeschlagenen statt von leeren Blöcken stammen.
      if (db.sync.from && db.sync.to) for (const id of SRC_IDS) addGap(id, db.sync.from, db.sync.to, 0);
      db.sync.sleepV = SLEEP_V; db.sync.sleepFill = null;
      db.sync.floor = null; db.sync.empty = 0;
      db.sync.rev = SYNC_REV;
    }
    await fetchBlock(recentFrom, t, actMap);
    db.sync.to = t;
    if (!db.sync.from || db.sync.from > recentFrom) db.sync.from = recentFrom;
    db.sync.last = new Date().toISOString();
    db.sync.error = null;
    db.setup = true;
    save(); reindex(); render();

    if ((db.sync.sleepV || 0) < SLEEP_V) {
      await refillSleep(Core.addDays(recentFrom, -1));
      save(); reindex(); render();
    }

    await fillGaps(oldest, actMap);

    const floor = () => maxDate(oldest, db.sync.floor || '0000-00-00');
    while (db.sync.from > floor()) {
      const b = Core.addDays(db.sync.from, -1);
      const a = maxDate(floor(), Core.addDays(b, -(BLOCK - 1)));
      const r = await fetchBlock(a, b, actMap);
      db.sync.from = a;
      // Ein Block mit Fehlern zählt nicht als leer — seine Lücken kommen später
      db.sync.empty = r.got || r.failed ? 0 : (db.sync.empty || 0) + 1;
      // Ein halbes Jahr ohne jeden Wert: davor gab es noch keine Uhr
      if (db.sync.empty >= 2) db.sync.floor = a;
      save(); reindex(); render();
    }
    if (manual) toast('Abgeglichen');
  } catch (e) {
    if (e.stopped) toast('Angehalten — der Rest folgt beim nächsten Abgleich');
    else {
      db.sync.error = e.message;
      if (manual || !db.setup) toast('Abgleich fehlgeschlagen');
    }
  } finally {
    syncing = false; stopRequested = false; syncMsg = '';
    save(); reindex();
    setSyncUi(); render();
  }
}

/** Automatisch abgleichen, wenn der letzte Abgleich über eine Stunde her ist. */
function maybeAutoSync() {
  if (!db.settings.autoSync || syncing || !isConfigured() || navigator.onLine === false) return;
  const last = db.sync.last ? new Date(db.sync.last).getTime() : 0;
  if (Date.now() - last > 60 * 60 * 1000) sync(false);
}

function setSyncUi() {
  $('#btnSync').classList.toggle('busy', syncing);
  $('#btnSync').setAttribute('aria-label', syncing ? 'Abgleich anhalten' : 'Mit Garmin abgleichen');
  renderTopSub();
}
function renderTopSub() {
  const el = $('#topSub');
  el.classList.remove('err');
  if (syncing) { el.textContent = syncMsg || 'Abgleich …'; return; }
  if (db.sync.error) { el.textContent = 'Abgleich fehlgeschlagen · Details in den Einstellungen'; el.classList.add('err'); return; }
  el.textContent = db.sync.last ? 'Stand ' + agoLabel(db.sync.last) : (isConfigured() ? 'Noch nicht abgeglichen' : 'Noch nicht verbunden');
  if (db.sync.last && SRC_IDS.some((k) => failedGaps(k).length)) el.textContent += ' · Lücken, siehe Einstellungen';
}

/* ── 5. Zwischenspeicher für Aktivitätskurven ───────────────── */
/* Messreihen einer Aktivität sind 20–60 KB — zu viel für localStorage, das
   den Datensatz trägt. Sie liegen in IndexedDB und lassen sich jederzeit neu
   von Garmin holen; geht der Speicher verloren, ist nichts verloren. */

let idbP = null;
function idb() {
  if (!idbP) {
    idbP = new Promise((res, rej) => {
      const r = indexedDB.open('garmin-files', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('streams');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }).catch((e) => { idbP = null; throw e; });
  }
  return idbP;
}
async function idbGet(k) {
  try {
    const d = await idb();
    return await new Promise((res, rej) => {
      const q = d.transaction('streams').objectStore('streams').get(k);
      q.onsuccess = () => res(q.result || null); q.onerror = () => rej(q.error);
    });
  } catch (e) { return null; }
}
async function idbPut(k, v) {
  try {
    const d = await idb();
    await new Promise((res, rej) => {
      const tx = d.transaction('streams', 'readwrite');
      tx.objectStore('streams').put(v, k);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  } catch (e) { /* dann wird beim nächsten Öffnen neu geladen */ }
}
async function idbClear() {
  try {
    const d = await idb();
    await new Promise((res) => { const tx = d.transaction('streams', 'readwrite'); tx.objectStore('streams').clear(); tx.oncomplete = res; tx.onerror = res; });
  } catch (e) { /* egal */ }
}

/* ── 6. Navigation und Diagramm-Ablesen ─────────────────────── */

const TITLES = { today: 'Heute', trends: 'Trends', training: 'Training', patterns: 'Muster' };
let view = 'today';

/* Zustand der Ansichten — nicht im Datensatz gespeichert, beim Start gilt das
   Übliche. Nur über ein Neuladen hinweg bleibt er erhalten (sessionStorage):
   wer auf „Trends" die Seite aktualisiert, landet wieder dort und nicht auf
   „Heute". Ein frischer Start der App beginnt eine neue Sitzung, also „Heute". */
const VIEW_KEY = 'garmin.view';
let dayView = null;                   // angezeigter Tag auf „Heute" (null = heute)
let trendKey = 'hrv';
let trendRange = 91;
let trainPeriod = 'week';
let trainSport = 'all';
let trainShow = 30;
let bestScope = 'all';
let patRange = 182;
let openScatter = new Set();

function saveViewState() {
  try {
    sessionStorage.setItem(VIEW_KEY, JSON.stringify({
      view, dayView, trendKey, trendRange, trainPeriod, trainSport, bestScope, patRange,
    }));
  } catch (e) { /* privater Modus o.ä. — dann eben wieder „Heute" */ }
}

/** Liefert die zuletzt offene Ansicht und setzt ihren Zustand zurück. */
function restoreViewState() {
  let s;
  try { s = JSON.parse(sessionStorage.getItem(VIEW_KEY) || 'null'); } catch (e) { s = null; }
  if (!s || !TITLES[s.view]) return 'today';
  // Ein Tag, der inzwischen „heute" oder Zukunft ist, wird wieder zu „heute"
  if (typeof s.dayView === 'string' && s.dayView < Core.today()) dayView = s.dayView;
  if (typeof s.trendKey === 'string') trendKey = s.trendKey;      // renderTrends prüft, ob es ihn gibt
  if (typeof s.trendRange === 'number') trendRange = s.trendRange;
  if (typeof s.trainPeriod === 'string') trainPeriod = s.trainPeriod;
  if (typeof s.trainSport === 'string') trainSport = s.trainSport;
  if (typeof s.bestScope === 'string') bestScope = s.bestScope;
  if (typeof s.patRange === 'number') patRange = s.patRange;
  return s.view;
}

function nav(v) {
  view = v;
  $$('.view').forEach((s) => s.classList.toggle('hidden', s.id !== 'view-' + v));
  $$('.tabbar button[data-nav]').forEach((b) => b.classList.toggle('on', b.dataset.nav === v));
  $('#viewTitle').textContent = TITLES[v] || '';
  window.scrollTo(0, 0);
  armBack();                    // Zurück soll auf „Heute" führen, nicht aus der App
  render();
}

/** Alles neu zeichnen. Bei diesen Datenmengen ist gezieltes Aktualisieren
    unnötige Komplexität — einmal neu rendern ist schnell genug und kann
    nicht aus dem Tritt geraten. */
let renderedDay = null;                // für welchen Tag „heute" zuletzt gezeichnet wurde
function render() {
  renderedDay = Core.today();
  for (const k of readers.keys()) if (k[0] === 'v') readers.delete(k);
  renderTopSub();
  if (view === 'today') renderToday();
  else if (view === 'trends') renderTrends();
  else if (view === 'training') renderTraining();
  else if (view === 'patterns') renderPatterns();
}

/* Antippen eines Diagramms zeigt den Wert an dieser Stelle über dem
   Diagramm. Jedes Diagramm meldet dafür eine Ablesefunktion an; Schlüssel
   mit 'v' gehören zur Ansicht, mit 's' zum Sheet. */
const readers = new Map();
let rid = 0;
function chartBox(svg, reader, initial, scope) {
  const id = (scope || 'v') + (++rid);
  if (reader) readers.set(id, reader);
  return `<div class="chart" data-cid="${id}"><div class="readout">${initial || ''}</div>${svg}</div>`;
}
function onChartPointer(e) {
  const svg = e.target.closest && e.target.closest('.chart svg[data-n]');
  if (!svg) return;
  const box = svg.closest('.chart');
  const fn = readers.get(box.dataset.cid);
  if (!fn) return;
  const r = svg.getBoundingClientRect();
  const vbw = svg.viewBox.baseVal.width || 340;
  const x = ((e.clientX - r.left) / r.width) * vbw;
  const n = +svg.dataset.n, x0 = +svg.dataset.x0, x1 = +svg.dataset.x1;
  const i = Math.max(0, Math.min(n - 1, Math.floor(((x - x0) / (x1 - x0)) * n)));
  const html = fn(i);
  if (html == null) return;
  box.querySelector('.readout').innerHTML = html;
  const c = svg.querySelector('.cursor');
  if (c) {
    const cx = x0 + ((x1 - x0) * (i + 0.5)) / n;
    c.setAttribute('x1', cx); c.setAttribute('x2', cx);
    c.classList.remove('hidden');
  }
}

/* ── 7. Heute ───────────────────────────────────────────────── */

function onboardingHtml() {
  const hasProxy = !!proxyBase(), hasKey = !!keyGet();
  if (hasProxy && hasKey && syncing) {
    return `<div class="onboard"><div class="ob-icon">${ICON.watch}</div><h2>Daten werden geladen</h2>
      <p>Der erste Abgleich holt die letzten vier Wochen und danach Schritt für Schritt den Verlauf. Das dauert ein paar Minuten — die App kann dabei offen bleiben oder geschlossen werden.</p>
      <div class="loading"><span class="spinner"></span><span id="obMsg">${esc(syncMsg || 'Verbinde …')}</span></div></div>`;
  }
  if (hasProxy && hasKey && db.setup && !db.sync.error) {
    return `<div class="empty"><h2>Garmin hat keine Daten geliefert</h2>
      <p>Die Verbindung steht, aber im abgefragten Zeitraum gibt es keine Tageswerte. Ist die Uhr mit Garmin Connect synchronisiert?</p>
      <button class="btn btn-primary" data-action="sync">Noch einmal abgleichen</button></div>`;
  }
  const err = db.sync.error ? `<div class="hint err">${ICON.warn}<div class="grow"><strong>Abgleich fehlgeschlagen</strong><span>${esc(db.sync.error)}</span>
    <button class="btn btn-sm" data-action="sync">Noch einmal versuchen</button></div></div>` : '';
  return `<div class="onboard">
    <div class="ob-icon">${ICON.heart}</div>
    <h2>Deine Garmin-Daten, auf einen Blick</h2>
    <p>Erholung, Schlaf, Training und Alltag auf einer Seite, dazu lange Trends und welche Gewohnheiten bei Dir was bewirken.</p>
  </div>
  <div class="ob-steps">
    <button class="ob-step${hasProxy ? ' done' : ''}" data-action="proxyGuide"><b>${hasProxy ? ICON.check : '1'}</b>
      <span class="grow"><strong>Proxy einrichten</strong><span>Garmin lässt Web-Apps nicht direkt zu. Ein kostenloser Cloudflare Worker reicht die Anfragen weiter — einmalig, etwa 10 Minuten.</span></span>${ICON.chev}</button>
    <button class="ob-step${hasKey ? ' done' : ''}" data-action="settings"><b>${hasKey ? ICON.check : '2'}</b>
      <span class="grow"><strong>API-Schlüssel eintragen</strong><span>Deinen Personal API Key von Garmin Connect in den Einstellungen einfügen.</span></span>${ICON.chev}</button>
    <button class="ob-step" data-action="sync"><b>3</b>
      <span class="grow"><strong>Daten laden</strong><span>Der erste Abgleich holt ein Jahr Verlauf.</span></span>${ICON.chev}</button>
  </div>${err}`;
}

function renderToday() {
  const el = $('#view-today');
  if (!Object.keys(db.days).length) { el.innerHTML = onboardingHtml(); return; }
  const t = Core.today();
  const date = dayView && dayView < t ? dayView : t;
  const d = db.days[date] || {};
  const rd = Core.readiness(db, idx, date);
  const v = rd.verdict;
  const oldest = db.sync.from || date;

  let h = `<div class="daynav">
    <button class="icon-btn" data-daystep="-1" aria-label="Tag davor"${date <= oldest ? ' disabled' : ''}>${ICON.left}</button>
    <strong>${esc(dayLabel(date))}${date !== t ? '' : ' · ' + esc(dfDay.format(pdate(date)))}</strong>
    <button class="icon-btn" data-daystep="1" aria-label="Tag danach"${date >= t ? ' disabled' : ''}>${ICON.right}</button>
  </div>`;

  if (db.sync.error && date === t) {
    h += `<div class="hint err">${ICON.warn}<div class="grow"><strong>Abgleich fehlgeschlagen</strong><span>${esc(db.sync.error)}</span></div></div>`;
  }

  // Erholung: die Signale einzeln, jedes gegen den eigenen Normalbereich
  h += `<div class="hero" style="margin-top:4px">
    <div class="hero-top"><div class="hero-ring st-${v.status || 'off'}">${v.status === 'good' || v.status === 'ok' ? ICON.check : v.status ? ICON.warn : ICON.info}</div>
      <div class="grow"><div class="hero-t">${esc(v.title)}</div><div class="hero-s">${esc(v.text)}</div></div></div>`;
  if (rd.signals.length) {
    h += '<div class="signals">' + rd.signals.map((s) => {
      let val, sub;
      if (s.key === 'load') { val = nf1.format(s.value) + '×'; sub = s.text; }
      else if (s.key === 'slpScore') { val = Core.fmt(s.valueKey, s.value); sub = fin(d.slp) ? Core.fmtDur(d.slp) : ''; }
      else if (s.key === 'hrv') { val = Core.fmt('hrv', s.value); sub = s.base && fin(s.base.lo) ? `normal ${nf0.format(s.base.lo)}–${nf0.format(s.base.hi)}` : ''; }
      else if (s.key === 'rhr') { val = Core.fmt('rhr', s.value); sub = s.base ? `Ø ${nf0.format(s.base.mean)}` : ''; }
      else { val = Core.fmt(s.key, s.value); sub = ''; }
      return `<button class="sig" data-trend="${s.key === 'load' ? 'load' : s.key}"><span class="sig-l"><i class="dot st-${s.status || 'off'}"></i>${esc(s.label)}</span>
        <span class="sig-v">${esc(val)}</span><span class="sig-s">${esc(sub)}</span></button>`;
    }).join('') + '</div>';
  }
  h += '</div>';

  // Schlaf der Nacht vor diesem Tag
  if (fin(d.slp)) {
    const ph = [['deep', 'Tief'], ['light', 'Leicht'], ['rem', 'REM'], ['awake', 'Wach']].filter(([k]) => fin(d[k]) && d[k] > 0);
    const tot = ph.reduce((s, [k]) => s + d[k], 0) || 1;
    const need = fin(d.need) ? ` · Bedarf ${Core.fmtDur(d.need * 60)}` : '';
    h += `<button class="card sleep-card" data-night="${date}" style="margin-top:var(--sp-3)">
      <div class="card-h">Schlaf<span class="muted">${fin(d.bed) && fin(d.wake) ? esc(Core.fmtClock(d.bed) + ' – ' + Core.fmtClock(d.wake)) : ''}</span>${ICON.chev}</div>
      <div class="sl-top">
        ${fin(d.slpScore) ? `<div class="sl-score">${nf0.format(d.slpScore)}<small>${esc(qualLabel(d.slpQ))}</small></div>` : ''}
        <div class="sl-facts"><span><b>${esc(Core.fmtDur(d.slp))}</b> geschlafen${esc(need)}</span>
          ${fin(d.slpHr) ? `<span>Puls im Schlaf <b>${nf0.format(d.slpHr)}</b>${fin(d.awakeN) ? ` · ${nf0.format(d.awakeN)}× wach` : ''}</span>` : ''}
          ${fin(d.slpResp) ? `<span>Atmung <b>${nf1.format(d.slpResp)}</b>/min${fin(d.slpSpo2) ? ` · SpO2 <b>${nf0.format(d.slpSpo2)}</b> %` : ''}</span>` : ''}</div>
      </div>
      ${ph.length ? `<div class="phases">${ph.map(([k]) => `<i class="ph-${k}" style="width:${(d[k] / tot) * 100}%"></i>`).join('')}</div>
      <div class="legend">${ph.map(([k, l]) => `<span><i class="ph-${k}"></i>${l} <b>${esc(Core.fmtDur(d[k]))}</b></span>`).join('')}</div>` : ''}
    </button>`;
  }

  // Kacheln: jede mit Abstand zum eigenen 30-Tage-Mittel und den letzten zwei Wochen
  const recentDays = Core.dateRange(Core.addDays(date, -13), date).map((x) => db.days[x] || {});
  const keys = ['hrv', 'rhr', 'bbMax', 'stress', 'steps', 'im', 'load', 'weight', 'slpResp', 'spo2'].filter((k) => {
    if (k === 'load') return db.acts.length > 0;
    if (k === 'im') return recentDays.some((x) => x.imMod != null || x.imVig != null);
    if (k === 'weight') return Core.series(db, idx, k, Core.addDays(date, -60), date).some(fin);
    return Core.series(db, idx, k, Core.addDays(date, -13), date).some(fin);
  });
  h += '<div class="tiles">' + keys.map((k) => tile(k, date)).join('') + '</div>';

  h += weekTable(date);

  const recent = db.acts.filter((a) => !a.parent && a.date <= date).slice(0, 3);
  if (recent.length) {
    h += `<div class="sec-h">Letzte Aktivitäten<button class="link" data-nav="training">Alle</button></div>
      <div class="rows">${recent.map(actRow).join('')}</div>`;
  }
  if (date !== t) h += `<div class="btn-row" style="margin-top:var(--sp-4)"><button class="btn" data-day="${t}">Zurück zu heute</button></div>`;
  el.innerHTML = h;
}

function qualLabel(q) {
  return { EXCELLENT: 'ausgezeichnet', GOOD: 'gut', FAIR: 'mittel', POOR: 'schwach' }[q] || '';
}

/* ── 7b. Eine Nacht im Detail ───────────────────────────────── */
/* Antippen der Schlafkarte. Sofort da ist alles, was der Abgleich schon
   mitbringt: Phasen gegen Garmins Idealbereich und Deinen Schnitt,
   Garmins Teilbewertungen und Begründung, Schlafbedarf, Rhythmus. Die
   Kurven der Nacht (Puls, HRV, Body Battery, SpO2) lädt das Sheet danach
   einzeln von Garmin und legt sie in IndexedDB ab. */

const Q_WORD = { E: 'ausgezeichnet', G: 'gut', F: 'mittel', P: 'schwach' };
const Q_ST = { E: 'good', G: 'good', F: 'warn', P: 'bad' };
const PHASE_LABEL = { deep: 'Tiefschlaf', light: 'Leichtschlaf', rem: 'REM-Schlaf', awake: 'Wach' };
const LEVEL_LABEL = ['Tiefschlaf', 'Leichtschlaf', 'REM-Schlaf', 'Wach'];
/* Garmins Begründung zum Score (sleepScoreFeedback) und der Einfluss vom
   Vortag (sleepScoreInsight), übersetzt. Unbekannte Schlüssel bleiben weg. */
const SLEEP_FB = {
  POSITIVE_HIGHLY_RECOVERING: 'Sehr erholsam', POSITIVE_OPTIMAL_STRUCTURE: 'Phasen ideal verteilt',
  POSITIVE_LONG_AND_RECOVERING: 'Lang und erholsam', POSITIVE_LONG_AND_DEEP: 'Lang und tief',
  POSITIVE_LONG_AND_REFRESHING: 'Lang und erfrischend, viel REM', POSITIVE_LONG_AND_CONTINUOUS: 'Lang und durchgehend',
  POSITIVE_LONG_AND_CALM: 'Lang und ruhig', POSITIVE_RECOVERING: 'Erholsam', POSITIVE_DEEP: 'Viel Tiefschlaf',
  POSITIVE_REFRESHING: 'Erfrischend, viel REM', POSITIVE_CONTINUOUS: 'Durchgehend geschlafen', POSITIVE_CALM: 'Ruhig, wenig Stress',
  POSITIVE_SHORT_BUT_RECOVERING: 'Kurz, aber erholsam', POSITIVE_SHORT_BUT_DEEP: 'Kurz, aber tief',
  POSITIVE_SHORT_BUT_REFRESHING: 'Kurz, aber erfrischend', POSITIVE_SHORT_BUT_CONTINUOUS: 'Kurz, aber durchgehend',
  POSITIVE_SHORT_BUT_CALM: 'Kurz, aber ruhig',
  NEGATIVE_LONG_BUT_NOT_RESTORATIVE: 'Lang, aber wenig erholsam', NEGATIVE_LONG_BUT_LIGHT: 'Lang, aber wenig Tiefschlaf',
  NEGATIVE_LONG_BUT_NOT_REFRESHING: 'Lang, aber wenig REM', NEGATIVE_LONG_BUT_DISCONTINUOUS: 'Lang, aber oft unterbrochen',
  NEGATIVE_LONG_BUT_RESTLESS: 'Lang, aber unruhig', NEGATIVE_LONG_BUT_POOR_QUALITY: 'Lang, aber schlechte Qualität',
  NEGATIVE_NOT_RESTORATIVE: 'Wenig erholsam', NEGATIVE_LIGHT: 'Wenig Tiefschlaf', NEGATIVE_NOT_REFRESHING: 'Wenig REM-Schlaf',
  NEGATIVE_DISCONTINUOUS: 'Oft unterbrochen', NEGATIVE_RESTLESS: 'Unruhig', NEGATIVE_POOR_STRUCTURE: 'Phasen ungünstig verteilt',
  NEGATIVE_SHORT_AND_NONRECOVERING: 'Kurz und wenig erholsam', NEGATIVE_SHORT_AND_POOR_STRUCTURE: 'Kurz, Phasen ungünstig verteilt',
  NEGATIVE_SHORT_AND_POOR_QUALITY: 'Kurz und schlechte Qualität', NEGATIVE_LONG_BUT_NOT_ENOUGH_REM: 'Lang, aber zu wenig REM',
  NEGATIVE_LONG_BUT_TOO_MUCH_REM: 'Lang, aber sehr viel REM', NEGATIVE_NOT_ENOUGH_REM: 'Zu wenig REM-Schlaf',
  NEGATIVE_TOO_MUCH_REM: 'Sehr viel REM-Schlaf',
};
const SLEEP_INS = {
  POSITIVE_ACCLIMATIZATION_IN_PROGRESS: 'Die Höhenanpassung läuft gut', POSITIVE_STRESSFUL_DAY: 'Trotz stressigem Tag gut geschlafen',
  POSITIVE_RESTFUL_DAY: 'Ruhiger Tag davor', POSITIVE_RESTFUL_EVENING: 'Ruhiger Abend davor', POSITIVE_EXERCISE: 'Das Training am Vortag hat gutgetan',
  POSITIVE_DAILY_ACTIVITY: 'Viel Bewegung am Vortag', POSITIVE_LATE_BED_TIME: 'Trotz später Bettzeit gut geschlafen',
  NEGATIVE_ACCLIMATIZATION_IN_PROGRESS: 'Der Körper passt sich noch an die Höhe an', NEGATIVE_VERY_STRENUOUS_EXERCISE: 'Sehr hartes Training am Vortag',
  NEGATIVE_LATE_STRENUOUS_EXERCISE: 'Hartes Training spät am Abend', NEGATIVE_STRENUOUS_EXERCISE: 'Hartes Training am Vortag',
  NEGATIVE_LATE_EXERCISE: 'Training spät am Abend', NEGATIVE_HIGHLY_STRESSFUL_DAY: 'Sehr stressiger Tag davor',
  NEGATIVE_STRESSFUL_DAY: 'Stressiger Tag davor', NEGATIVE_INACTIVE_DAY: 'Wenig Bewegung am Vortag', NEGATIVE_LATE_BED_TIME: 'Spät ins Bett gegangen',
};
const NEED_LABEL = { t: 'Training', s: 'Schlaf der letzten Nächte', h: 'HRV', n: 'Nickerchen' };
const BRTH_LABEL = { LOW: 'wenige', MEDIUM: 'einige', HIGH: 'viele' };

/** Kompakte Minuten mit Vorzeichen für schmale Zellen: „−32′", „+1:05". */
function signMin(v) {
  const m = Math.round(v);
  if (!m) return '±0′';
  const a = Math.abs(m), sign = m > 0 ? '+' : '−';
  return sign + (a < 60 ? a + '′' : `${Math.floor(a / 60)}:${pad2(a % 60)}`);
}

/** Mittel über die 30 Nächte vor `date` — ab sieben Nächten, sonst null. */
function nightMean(date, fn) {
  const vals = [];
  for (let i = 1; i <= 30; i++) {
    const d = db.days[Core.addDays(date, -i)];
    const v = d ? fn(d) : null;
    if (fin(v)) vals.push(v);
  }
  return vals.length >= 7 ? Core.mean(vals) : null;
}

/** Nachbar-Nacht mit Schlafdaten, für ‹ › im Sheet. */
function nightStep(date, dir) {
  const ks = Object.keys(db.days).filter((k) => fin(db.days[k].slp) && (dir < 0 ? k < date : k > date));
  if (!ks.length) return null;
  return ks.reduce((a, b) => ((dir < 0 ? a > b : a < b) ? a : b));
}

let nightDate = null;

function openNight(date) {
  const d = db.days[date];
  if (!d || !fin(d.slp)) return;
  nightDate = date;
  const ref = db.profile.sleep || {};
  const opt = ref.opt || {};
  const prev = nightStep(date, -1), next = nightStep(date, 1);
  const span = fin(d.bed) && fin(d.wake) ? `${Core.fmtClock(d.bed)} – ${Core.fmtClock(d.wake)}` : '';

  let h = `<div class="daynav sheet-nav">
    <button class="icon-btn" data-nstep="${esc(prev || '')}" aria-label="Nacht davor"${prev ? '' : ' disabled'}>${ICON.left}</button>
    <strong>Nacht zum ${esc(dfDayY.format(pdate(date)))}${span ? `<span class="muted"> · ${esc(span)}</span>` : ''}</strong>
    <button class="icon-btn" data-nstep="${esc(next || '')}" aria-label="Nacht danach"${next ? '' : ' disabled'}>${ICON.right}</button>
  </div>`;

  // Kopf: Score, Dauer gegen Bedarf, Garmins Begründung
  const need = fin(d.need) ? d.need * 60 : null;
  const fb = SLEEP_FB[d.slpFb], ins = SLEEP_INS[d.slpIns];
  const needSt = need ? (d.slp >= need - 15 * 60 ? 'good' : d.slp >= need - 90 * 60 ? 'warn' : 'bad') : '';
  h += `<div class="card sleep-card"><div class="sl-top">
      ${fin(d.slpScore) ? `<div class="sl-score">${nf0.format(d.slpScore)}<small>${esc(qualLabel(d.slpQ))}</small></div>` : ''}
      <div class="sl-facts"><span><b>${esc(Core.fmtDur(d.slp))}</b> geschlafen</span>
        ${need ? `<span>Bedarf ${esc(Core.fmtDur(need))} · <b class="st-${needSt}">${esc(Core.fmtDelta('slp', d.slp - need))}</b></span>` : ''}
        ${fin(d.awakeN) || fin(d.awake) ? `<span>${fin(d.awakeN) ? `${nf0.format(d.awakeN)}× aufgewacht` : 'wach'}${fin(d.awake) ? ` · <b>${esc(Core.fmtDur(d.awake))}</b> wach` : ''}</span>` : ''}</div>
    </div>
    ${fb || ins ? `<div class="sl-fb">${fb ? `<b>${esc(fb)}</b>` : ''}${ins ? `<span>${esc(ins)}</span>` : ''}</div>` : ''}
  </div>`;

  // Phasen: Dauer, Anteil am Schlaf, Garmins Idealbereich, Dein Schnitt
  const SCALE = 70;                 // Balken reichen bis 70 % — Leichtschlaf liegt selten darüber
  h += '<div class="sec-h">Phasen<span class="muted">Anteil am Schlaf ohne Wachzeit</span></div><div class="card ph-rows">';
  for (const k of ['deep', 'light', 'rem']) {
    if (!fin(d[k])) continue;
    const pct = (d[k] / d.slp) * 100;
    const q = Core.sleepPart(d.sq, k);
    const o = opt[k];
    const avg = nightMean(date, (x) => (fin(x[k]) && x.slp > 0 ? x[k] : null));
    const avgPct = nightMean(date, (x) => (fin(x[k]) && x.slp > 0 ? (x[k] / x.slp) * 100 : null));
    const w = (v) => Math.max(0, Math.min(100, (v / SCALE) * 100));
    h += `<div class="ph-row">
      <div class="ph-h"><i class="ph-${k}"></i><b>${PHASE_LABEL[k]}</b><span class="ph-v num">${esc(Core.fmtDur(d[k]))}<small>${nf0.format(pct)} %</small></span>${q ? `<span class="q st-${Q_ST[q]}">${Q_WORD[q]}</span>` : ''}</div>
      <div class="ph-bar">${o ? `<span class="ph-opt" style="left:${w(o[0])}%;width:${w(o[1]) - w(o[0])}%"></span>` : ''}<i class="ph-${k}" style="width:${w(pct)}%"></i>${fin(avgPct) ? `<span class="ph-avg" style="left:${w(avgPct)}%"></span>` : ''}</div>
      <div class="ph-sub">${avg != null ? `Dein Ø ${esc(Core.fmtDur(avg))} · ${nf0.format(avgPct)} %` : 'Dein Schnitt folgt nach einer Woche'}${o ? ` · Ideal ${nf0.format(o[0])}–${nf0.format(o[1])} %` : ''}</div>
    </div>`;
  }
  if (fin(d.awake)) {
    const q = Core.sleepPart(d.sq, 'awk');
    const avg = nightMean(date, (x) => x.awake);
    h += `<div class="ph-row">
      <div class="ph-h"><i class="ph-awake"></i><b>Wach</b><span class="ph-v num">${esc(Core.fmtDur(d.awake))}${fin(d.awakeN) ? `<small>${nf0.format(d.awakeN)}×</small>` : ''}</span>${q ? `<span class="q st-${Q_ST[q]}">${Q_WORD[q]}</span>` : ''}</div>
      <div class="ph-sub">${avg != null ? `Dein Ø ${esc(Core.fmtDur(avg))}` : ''}${q ? `${avg != null ? ' · ' : ''}Garmin bewertet, wie oft Du aufwachst` : ''}</div>
    </div>`;
  }
  h += `<div class="legend" style="margin-top:var(--sp-2)">${Object.keys(opt).length ? '<span><i class="l-opt"></i>Garmins Idealbereich</span>' : ''}<span><i class="l-mark"></i>Dein Schnitt (30 Nächte)</span></div></div>`;

  // Garmins übrige Teilbewertungen
  const rest = [
    ['dur', 'Dauer', Core.fmtDur(d.slp)],
    ['str', 'Stress im Schlaf', fin(d.slpStress) ? 'Ø ' + nf0.format(d.slpStress) : ''],
    ['restl', 'Unruhe', ''],
  ].filter(([k]) => Core.sleepPart(d.sq, k));
  if (rest.length) {
    h += `<div class="sec-h">Garmins Teilbewertungen</div><div class="card qrows">${rest.map(([k, l, v]) => {
      const q = Core.sleepPart(d.sq, k);
      return `<div><span>${l}</span><b class="num">${esc(v)}</b><em class="st-${Q_ST[q]}">${Q_WORD[q]}</em></div>`;
    }).join('')}</div>`;
  }

  // Körper in der Nacht, jeweils gegen Deinen Schnitt
  const body = [];
  const cmp = (key, v, dir, f) => {
    const avg = nightMean(date, (x) => x[key]);
    // Nur Abweichungen färben — „im Normalbereich" bleibt neutral
    const j = avg == null || !dir ? null : Core.judge(v, Core.baseline(db, idx, key, date, 30, 7), dir);
    const st = j && j !== 'ok' ? j : '';
    return { st, sub: avg != null ? `Ø ${f(avg)}` : '' };
  };
  if (fin(d.slpHr)) { const c = cmp('slpHr', d.slpHr, -1, (v) => nf0.format(v)); body.push([`${nf0.format(d.slpHr)} bpm`, 'Puls', c.sub, c.st]); }
  if (fin(d.hrv)) { const c = cmp('hrv', d.hrv, 1, (v) => nf0.format(v)); body.push([`${nf0.format(d.hrv)} ms`, 'HRV', c.sub, c.st]); }
  if (fin(d.slpResp)) body.push([`${nf1.format(d.slpResp)} /min`, 'Atmung', fin(d.respLo) && fin(d.respHi) ? `${nf0.format(d.respLo)}–${nf0.format(d.respHi)}` : '', '']);
  if (fin(d.slpSpo2)) body.push([`${nf0.format(d.slpSpo2)} %`, 'SpO2', fin(d.spo2Lo) ? `min. ${nf0.format(d.spo2Lo)}` : '', fin(d.spo2Lo) && d.spo2Lo < 88 ? 'warn' : '']);
  if (fin(d.slpStress)) { const c = cmp('slpStress', d.slpStress, -1, (v) => nf0.format(v)); body.push([nf0.format(d.slpStress), 'Stress', c.sub, c.st]); }
  if (d.brth) body.push([BRTH_LABEL[d.brth] || '', 'Atemaussetzer', 'laut Garmin', d.brth === 'HIGH' ? 'warn' : '']);
  if (body.length) {
    h += `<div class="sec-h">Körper in der Nacht</div><div class="card"><div class="facts">${body.map(([v, l, sub, st]) => `<div><b${st ? ` class="st-${st}"` : ''}>${esc(v)}</b><span>${esc(l)}${sub ? ` · ${esc(sub)}` : ''}</span></div>`).join('')}</div>
      <p class="note" style="margin-top:0">Farbig, wenn ein Wert außerhalb Deines Normalbereichs der 30 Nächte davor liegt.</p></div>`;
  }

  // Kurven der Nacht — kommen nach
  h += '<div class="sec-h">Verlauf der Nacht</div><div id="nightCurves"><div class="loading"><span class="spinner"></span><span>Messreihen werden geladen …</span></div></div>';

  // Schlafbedarf und Saldo
  if (need) {
    const debt = Core.sleepDebt(db, date);
    const base = fin(d.needBase) ? d.needBase * 60 : null;
    const why = (d.needAdj || '').split('').map((c) => NEED_LABEL[c]).filter(Boolean);
    h += `<div class="sec-h">Schlafbedarf</div><div class="card">
      <div class="stat-row">
        ${base ? `<div class="stat"><span class="stat-l">Grundbedarf</span><span class="stat-v">${esc(Core.fmtDur(base))}</span></div>` : ''}
        <div class="stat"><span class="stat-l">diese Nacht</span><span class="stat-v">${esc(Core.fmtDur(need))}</span>${base && base !== need ? `<span class="stat-d muted">${esc(Core.fmtDelta('slp', need - base))}</span>` : ''}</div>
        <div class="stat"><span class="stat-l">geschlafen</span><span class="stat-v st-${needSt}">${esc(Core.fmtDur(d.slp))}</span></div>
      </div>
      ${base && base !== need && why.length ? `<p class="note">Garmin hat den Bedarf angepasst wegen: ${esc(why.join(', '))}.</p>` : ''}
      ${debt ? `<div class="debt">${debt.nights.map((n) => `<div class="${n.v == null ? 'na' : 'st-' + (n.v >= -15 ? 'good' : n.v >= -60 ? 'warn' : 'bad')}${n.date === date ? ' sel' : ''}"><span>${['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'][Core.weekday(n.date)]}</span><b>${n.v == null ? '–' : esc(signMin(n.v))}</b></div>`).join('')}</div>
        <p class="note">Saldo der sieben Nächte bis hier: <b class="st-${debt.sum >= -30 ? 'good' : debt.sum >= -180 ? 'warn' : 'bad'}">${esc(Core.fmt('debt', debt.sum))}</b>${debt.n < 7 ? ` (${debt.n} Nächte bekannt)` : ''}.</p>` : ''}
      ${date === Core.today() && ref.date === date && ref.next ? `<p class="note"><b>Heute Nacht</b> brauchst Du laut Garmin etwa ${esc(Core.fmtDur(ref.next.need * 60))}${fin(ref.next.lo) && fin(ref.next.hi) ? `, ins Bett am besten zwischen ${esc(Core.fmtClock(ref.next.lo))} und ${esc(Core.fmtClock(ref.next.hi))}` : ''}.</p>` : ''}
    </div>`;
  }

  // Rhythmus: Uhrzeiten gegen Deinen Schnitt, Gleichmäßigkeit der letzten zwei Wochen
  if (fin(d.bed) && fin(d.wake)) {
    const mid = Core.value(db, idx, 'mid', date);
    const clockOf = (key, x) => (key === 'mid' ? (fin(x.bed) && fin(x.wake) ? (x.bed + x.wake + 1440) / 2 : null) : x[key]);
    const st = (key) => {
      const avg = nightMean(date, (x) => clockOf(key, x));
      return avg != null ? `<span class="stat-d muted">Ø ${esc(Core.fmtClock(avg))}</span>` : '';
    };
    const beds = Core.series(db, idx, 'bed', Core.addDays(date, -13), date).filter(fin);
    const spread = beds.length >= 7 ? Core.sd(beds) : null;
    h += `<div class="sec-h">Rhythmus</div><div class="card">
      <div class="stat-row">
        <div class="stat"><span class="stat-l">eingeschlafen</span><span class="stat-v">${esc(Core.fmtClock(d.bed))}</span>${st('bed')}</div>
        <div class="stat"><span class="stat-l">aufgewacht</span><span class="stat-v">${esc(Core.fmtClock(d.wake))}</span>${st('wake')}</div>
        <div class="stat"><span class="stat-l">Schlafmitte</span><span class="stat-v">${esc(Core.fmtClock(mid))}</span>${st('mid')}</div>
      </div>
      ${spread != null ? `<p class="note">Einschlafzeit der letzten ${beds.length} Nächte: ± ${nf0.format(spread)} min um ${esc(Core.fmtClock(Core.mean(beds)))} — <b class="st-${spread <= 30 ? 'good' : spread <= 45 ? 'ok' : 'warn'}">${spread <= 30 ? 'sehr gleichmäßig' : spread <= 45 ? 'recht gleichmäßig' : spread <= 75 ? 'schwankend' : 'stark schwankend'}</b>.</p>` : ''}
      ${ref.win ? `<p class="note">Garmins optimales Schlaffenster für Dich: ${esc(Core.fmtClock(ref.win.lo))} – ${esc(Core.fmtClock(ref.win.hi))}.</p>` : ''}
    </div>`;
  }

  if (fin(d.nap)) h += `<div class="sec-h">Nickerchen</div><div class="card" id="nightNaps"><p class="note" style="margin:0">${esc(Core.fmtDur(d.nap))} am Tag</p></div>`;

  h += `<div class="btn-row" style="margin-top:var(--sp-5)"><button class="btn" data-trend="${fin(d.slpScore) ? 'slpScore' : 'slp'}">Schlaf-Trends</button></div>`;

  openSheet('Schlaf', h, null);
  $('#sheetBody').onclick = (e) => {
    const b = e.target.closest('[data-nstep]');
    if (b && b.dataset.nstep) { openNight(b.dataset.nstep); return; }
    // Der Sprung zu den Trends läuft über den Klick-Handler der Seite — das Sheet muss dafür zu
    if (e.target.closest('[data-trend]')) closeSheet();
  };

  loadNight(date).then((n) => {
    const box = $('#nightCurves');
    if (!box || nightDate !== date || $('#sheet').classList.contains('hidden')) return;
    box.innerHTML = nightCurvesHtml(date, n);
    if (n && n.naps && n.naps.length && $('#nightNaps')) {
      $('#nightNaps').innerHTML = n.naps.map((x) => `<div class="qrow-1"><span>ab ${esc(Core.fmtClock(x.at))}</span><b class="num">${esc(Core.fmtDur(x.dur))}</b></div>`).join('');
    }
  }).catch((e) => {
    const box = $('#nightCurves');
    if (box && nightDate === date) box.innerHTML = `<div class="hint warn">${ICON.warn}<div class="grow"><span>${esc(e.message)}</span></div></div>`;
  });
}

/** Schlaffenster aus den gespeicherten Tageswerten, in der Zeitzone des
    Handys — nur Ersatz, falls Garmin es in keiner Antwort mitschickt. */
function nightFallback(date, d) {
  if (!d || !fin(d.bed) || !fin(d.wake)) return null;
  const p = pdate(Core.addDays(date, -1));
  const at = (min) => { const x = new Date(p.getFullYear(), p.getMonth(), p.getDate()); x.setMinutes(min); return x; };
  const s = at(d.bed);
  return { t0: s.getTime(), t1: at(d.wake + 1440).getTime(), off: -s.getTimezoneOffset() };
}

/* Wie die Aktivitätskurven: einmal laden, danach aus IndexedDB. Die letzte
   Nacht kann noch unvollständig sein, solange die Uhr nicht synchronisiert
   hat — sie gilt deshalb nur zwei Stunden. */
const NIGHT_V = 1;
const nightCache = new Map();
async function loadNight(date) {
  const key = 'night:' + date;
  const recent = date >= Core.addDays(Core.today(), -1);
  let n = nightCache.get(key) || await idbGet(key);
  if (n && n.v === NIGHT_V && (!recent || Date.now() - n.at < 2 * 3600e3)) { nightCache.set(key, n); return n; }
  if (!isConfigured()) {
    if (n) return n;
    throw new Error('Ohne Verbindung zu Garmin lassen sich die Kurven der Nacht nicht laden.');
  }
  const d = db.days[date] || {};
  const prev = Core.addDays(date, -1);
  let broken = false;
  // Jede Quelle für sich: Eine Uhr ohne SpO2 soll die anderen Kurven nicht verhindern
  const get = async (path) => {
    try { return await api(path); } catch (e) {
      if (fatal(e)) throw e;
      if (e.kind !== 'missing' && e.kind !== 'forbidden') broken = true;
      return null;
    }
  };
  const raw = {
    sleep: await get(`/sleep-service/sleep/dailySleep?date=${date}`),
    hrv: await get(`/hrv-service/hrv/${date}`),
    // Puls kommt je Kalendertag; vor Mitternacht eingeschlafen heißt: auch der Vortag
    hr: [!fin(d.bed) || d.bed < 1440 ? await get(`/wellness-service/wellness/dailyHeartRate?date=${prev}`) : null,
      await get(`/wellness-service/wellness/dailyHeartRate?date=${date}`)],
    bb: await get(`/wellness-service/wellness/bodyBattery/reports/daily?startDate=${prev}&endDate=${date}`),
    spo2: await get(`/wellness-service/wellness/daily/spo2acclimation/${date}`),
  };
  n = Core.mapNight(raw, nightFallback(date, d));
  if (!n) throw new Error('Für diese Nacht kennt Garmin kein Schlaffenster.');
  n.at = Date.now();
  nightCache.set(key, n);
  // Ein Teil schlug fehl (nicht nur „gibt es nicht"): nicht dauerhaft merken, beim nächsten Öffnen neu
  if (!broken) await idbPut(key, n);
  return n;
}

/** Kurven der Nacht auf gemeinsamer Zeitachse. Jede Kurve meldet beim
    Antippen Uhrzeit und Wert an dieser Stelle. */
function nightCurvesHtml(date, n) {
  if (!n) return '<p class="note">Garmin hat für diese Nacht keine Messreihen.</p>';
  const g = Core.nightGrid(n, 5);
  const xs = g.xs;
  let h = '';
  if (n.lv && n.lv.length) {
    const segs = n.lv.map(([a, b, k]) => [n.s0 + a, n.s0 + b, k]);
    const reader = (i) => `<span>${esc(Core.fmtClock(xs[i]))}</span><b>${g.lv[i] != null ? LEVEL_LABEL[g.lv[i]] : '–'}</b>`;
    const first = `<span>eingeschlafen</span><b>${esc(Core.fmtClock(n.s0))}</b><span class="end">aufgewacht ${esc(Core.fmtClock(n.s0 + n.len))}</span>`;
    h += `<div class="card"><div class="card-h">Phasen</div>${chartBox(Charts.hypno(xs, segs, { fmtX: Core.fmtClock }), reader, first, 's')}</div>`;
  } else {
    h += '<p class="note" style="margin:0 2px var(--sp-2)">Den Verlauf der Phasen über die Nacht gibt Garmins Personal API nicht heraus, nur die Summen oben.</p>';
  }
  const curve = (key, label, unit, cls, first) => {
    const ys = g[key];
    if (ys.filter(fin).length < 3) return '';
    const fy = (v) => nf0.format(v);
    const reader = (i) => `<span>${esc(Core.fmtClock(xs[i]))}</span><b>${fin(ys[i]) ? esc(fy(ys[i]) + unit) : '–'}</b>`;
    return `<div class="card"><div class="card-h">${esc(label)}</div>${chartBox(Charts.curve(xs, ys, { fmtY: fy, fmtX: Core.fmtClock, xUnit: 60, cls, fill: true }), reader, first, 's')}</div>`;
  };
  const stat = (pts) => { const v = (pts || []).map((p) => p[1]); return v.length ? { avg: Core.mean(v), lo: Math.min(...v), hi: Math.max(...v), at: pts[v.indexOf(Math.min(...v))][0] } : null; };
  const hr = stat(n.hr), hrv = stat(n.hrv), ox = stat(n.spo2);
  h += curve('hr', 'Puls', ' bpm', 'c-hr', hr ? `<span>Ø</span><b>${nf0.format(hr.avg)} bpm</b><span class="end">tiefster ${nf0.format(hr.lo)} um ${esc(Core.fmtClock(n.s0 + hr.at))}</span>` : '');
  h += curve('hrv', 'HRV', ' ms', 'c-hrv', hrv ? `<span>Ø</span><b>${nf0.format(hrv.avg)} ms</b><span class="end">${nf0.format(hrv.lo)}–${nf0.format(hrv.hi)} ms</span>` : '');
  const bb0 = n.bb && n.bb.length ? n.bb[0][1] : null, bb1 = n.bb && n.bb.length ? n.bb[n.bb.length - 1][1] : null;
  const bbTxt = fin(n.bbImp) ? `<span>in der Nacht</span><b>${n.bbImp > 0 ? '+' : ''}${nf0.format(n.bbImp)}</b>` : '';
  h += curve('bb', 'Body Battery', '', 'c-bb', (bbTxt || '') + (fin(bb0) ? `<span class="end">${nf0.format(bb0)} → ${nf0.format(bb1)}</span>` : ''));
  h += curve('spo2', 'SpO2', ' %', 'c-spo2', ox ? `<span>Ø</span><b>${nf0.format(ox.avg)} %</b><span class="end">tiefster ${nf0.format(ox.lo)} %</span>` : '');
  if (!['hr', 'hrv', 'bb', 'spo2'].some((k) => g[k].filter(fin).length >= 3)) h += '<p class="note">Für diese Nacht hat Garmin keine Messreihen.</p>';
  if (n.unm) h += `<p class="note">${esc(Core.fmtDur(n.unm))} ließen sich keiner Phase zuordnen.</p>`;
  if (n.note) h += `<div class="hint">${ICON.info}<div class="grow"><strong>Deine Notiz</strong><span>${esc(n.note)}</span></div></div>`;
  return h;
}

/** Kachel einer Kennzahl. Intensitätsminuten zählen als Woche gegen das
    Wochenziel, Belastung als 7-Tage-Summe — so, wie man darüber nachdenkt. */
function tile(key, date) {
  const m = M[key];
  const t = Core.today();
  if (key === 'im') {
    const ws = Core.weekStart(date);
    const vals = Core.dateRange(ws, date).map((x) => Core.value(db, idx, 'im', x)).filter(fin);
    const tot = vals.reduce((s, v) => s + v, 0);
    const goal = (db.days[date] || {}).imGoal || 150;
    const pct = Math.min(100, (tot / goal) * 100);
    return `<button class="tile" data-trend="im"><span class="tile-l">Intensitätsminuten</span>
      <span class="tile-v">${nf0.format(tot)}<small>/ ${nf0.format(goal)}</small></span>
      <span class="tile-d st-${tot >= goal ? 'good' : 'ok'}">${tot >= goal ? 'Wochenziel erreicht' : `diese Woche · noch ${nf0.format(goal - tot)}`}</span>
      <div class="meter"><i class="${tot >= goal ? 'full' : ''}" style="width:${pct}%"></i></div></button>`;
  }
  if (key === 'load') {
    const ls = Core.loadStatus(db, idx, date);
    const vals = Core.loadSeries(db, idx, Core.addDays(date, -13), date).map((r) => r.acute);
    const st = ls ? { low: 'ok', ok: 'good', high: 'warn', spike: 'bad' }[ls.status] : 'off';
    return `<button class="tile" data-nav="training"><span class="tile-l">Belastung · 7 Tage</span>
      <span class="tile-v">${ls ? nf0.format(ls.acute) : '–'}</span>
      <span class="tile-d st-${st}">${ls ? esc(ls.text) : 'braucht 3 Wochen Daten'}</span>
      ${Charts.spark(vals, { band: ls ? [ls.chronic * 0.8, ls.chronic * 1.3] : null })}</button>`;
  }
  // Seltene Werte (Gewicht): der letzte bekannte zählt
  let v = Core.value(db, idx, key, date), vDate = date;
  if (m.sparse && !fin(v)) {
    for (let i = 1; i <= 60 && !fin(v); i++) { vDate = Core.addDays(date, -i); v = Core.value(db, idx, key, vDate); }
  }
  const base = Core.baseline(db, idx, key, date, m.sparse ? 90 : 30, m.sparse ? 3 : 10);
  const partial = date === t && ACCUM.includes(key);
  const st = partial ? null : Core.judge(v, base, m.dir);
  let delta = '';
  if (partial) delta = 'bisher heute';
  else if (fin(v) && base) delta = `${Core.fmtDelta(key, v - base.mean)} zu Ø`;
  else if (fin(v)) delta = 'Normalbereich folgt';
  if (m.sparse && vDate !== date && fin(v)) delta = dayLabel(vDate);
  const vals = Core.series(db, idx, key, Core.addDays(date, m.sparse ? -59 : -13), date);
  if (key === 'steps' && fin(v)) {
    const goal = (db.days[date] || {}).stepGoal;
    if (goal) {
      return `<button class="tile" data-trend="steps"><span class="tile-l">Schritte</span>
        <span class="tile-v">${valHtml(key, v)}</span>
        <span class="tile-d st-${v >= goal ? 'good' : st || 'ok'}">${v >= goal ? 'Ziel erreicht' : esc(delta)}</span>
        <div class="meter"><i class="${v >= goal ? 'full' : ''}" style="width:${Math.min(100, (v / goal) * 100)}%"></i></div>
        ${Charts.spark(vals, { band: base ? [base.lo, base.hi] : null })}</button>`;
    }
  }
  return `<button class="tile" data-trend="${key}"><span class="tile-l">${esc(m.label)}${m.sparse ? ' · 60 Tage' : ''}</span>
    <span class="tile-v">${valHtml(key, v)}</span>
    <span class="tile-d st-${st || 'off'}">${esc(delta)}</span>
    ${Charts.spark(vals, { band: base && !m.sparse ? [base.lo, base.hi] : null, connect: m.sparse })}</button>`;
}

/** Die letzten sieben Tage als Tabelle — jede Zelle in der Farbe ihrer
    Abweichung vom Normalbereich dieses Tages. */
function weekTable(date) {
  const cols = [
    ['slp', 'Schlaf', (v) => splitVal('slp', v).join(' ').replace(' h', '').replace(' min', '′')],
    ['hrv', 'HRV', (v) => nf0.format(v)],
    ['rhr', 'Puls', (v) => nf0.format(v)],
    ['stress', 'Stress', (v) => nf0.format(v)],
    ['steps', 'Schritte', (v) => (v >= 10000 ? nf1.format(v / 1000) + 'k' : nf0.format(v))],
    ['trainMin', 'Training', (v) => (v > 0 ? Core.fmtDur(v * 60).replace(' min', '′').replace(' h', '') : '–')],
  ].filter(([k]) => Core.series(db, idx, k, Core.addDays(date, -6), date).some((v) => fin(v) && (k !== 'trainMin' || v > 0)) || k === 'trainMin');
  const t = Core.today();
  let h = `<div class="sec-h">Woche</div><div class="card"><div class="wk-wrap"><table class="wk"><thead><tr><th>Tag</th>${cols.map((c) => `<th>${c[1]}</th>`).join('')}</tr></thead><tbody>`;
  for (let i = 6; i >= 0; i--) {
    const dd = Core.addDays(date, -i);
    h += `<tr data-day="${dd}"${dd === date ? ' class="sel"' : ''}><td>${esc(dd === t ? 'Heute' : ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'][Core.weekday(dd)] + ' ' + (+dd.slice(8)) + '.')}</td>`;
    for (const [k, , f] of cols) {
      const v = Core.value(db, idx, k, dd);
      if (!fin(v)) { h += '<td class="na">–</td>'; continue; }
      const m = M[k];
      const st = dd === t && ACCUM.includes(k) ? 'ok' : (m.dir ? Core.judge(v, Core.baseline(db, idx, k, dd, 30, 10), m.dir) || 'ok' : 'ok');
      h += `<td class="st-${st}">${esc(f(v))}</td>`;
    }
    h += '</tr>';
  }
  return h + '</tbody></table></div><div class="legend" style="margin-top:6px"><span><i class="dot st-good"></i>besser als normal</span><span><i class="dot st-warn"></i>schlechter</span><span><i class="dot st-bad"></i>deutlich schlechter</span></div></div>';
}

/** Zeile einer Aktivität: links Name, Tag und Dauer; rechts Distanz und
    Tempo — ohne Distanz (Kraft, Yoga) Dauer und Puls. */
function actRow(a) {
  const main = a.dist ? km(a.dist) : hms(a.dur);
  const right = a.dist && a.spd ? speedText(a.spd, a.type) : a.hr ? nf0.format(a.hr) + ' bpm' : '';
  const left = [dayLabel(a.date) + ' ' + a.start.slice(11, 16), a.dist ? hms(a.dur) : Core.typeLabel(a.type)].join(' · ');
  return `<button class="row" data-act="${esc(a.id)}">${sportIcon(a.type)}
    <span class="grow"><span class="t clip1">${esc(a.name || Core.typeLabel(a.type))}</span>
    <span class="sub clip1">${esc(left)}</span></span>
    <span class="end"><b class="num">${esc(main)}</b><span class="sub">${esc(right)}</span></span></button>`;
}

/* ── 8. Trends ──────────────────────────────────────────────── */

const RANGES = [[28, '4 W'], [91, '3 M'], [365, '1 J'], [0, 'Alles']];

function firstDate() {
  const ks = Object.keys(db.days);
  return ks.length ? ks.reduce((a, b) => (a < b ? a : b)) : Core.today();
}

/** Welche Kennzahlen haben überhaupt Werte? Nur die bekommen einen Chip. */
function availableMetrics() {
  const out = new Set();
  const days = Object.values(db.days);
  for (const k in M) {
    if (k === 'load' || k === 'trainMin') { if (db.acts.length) out.add(k); continue; }
    if (k === 'vo2') { if (Object.keys(idx.vo2).length > 1) out.add(k); continue; }
    if (k === 'im') { if (days.some((d) => d.imMod != null)) out.add(k); continue; }
    if (k === 'mid') { if (days.some((d) => fin(d.bed) && fin(d.wake))) out.add(k); continue; }
    if (k === 'debt') { if (days.filter((d) => fin(d.need) && fin(d.slp)).length >= 5) out.add(k); continue; }
    if (days.some((d) => fin(d[k]))) out.add(k);
  }
  return out;
}

function renderTrends() {
  const el = $('#view-trends');
  if (!Object.keys(db.days).length) { el.innerHTML = '<div class="empty"><h2>Noch keine Daten</h2><p>Sobald der erste Abgleich gelaufen ist, stehen hier Deine Verläufe.</p></div>'; return; }
  const avail = availableMetrics();
  if (!avail.has(trendKey)) trendKey = avail.has('hrv') ? 'hrv' : Array.from(avail)[0] || 'steps';
  const m = M[trendKey];
  const t = Core.today();
  const from = trendRange ? Core.addDays(t, -(trendRange - 1)) : firstDate();
  const dates = Core.dateRange(from, t);
  const vals = Core.series(db, idx, trendKey, from, t);
  // Normalband und Mittel brauchen Vorlauf vor dem Zeitraum, sonst fehlen sie am Anfang
  const pre = 30;
  const full = Core.series(db, idx, trendKey, Core.addDays(from, -pre), t);
  const avgWin = m.sparse ? 28 : 7;
  const avg = Core.rolling(full, avgWin, m.sparse ? 1 : 4).slice(pre);
  // Beim Schlafsaldo ist jeder Tag schon eine Wochensumme — ein Band um die eigene Summe sagt nichts
  const band = m.sparse || m.noBand ? null : Core.rollingBand(full, 30, 10);
  const lo = band ? band.lo.slice(pre) : null, hi = band ? band.hi.slice(pre) : null;
  const isSum = m.agg === 'sum';

  let h = '<div class="chips">';
  for (const g of Core.GROUPS) {
    const ks = Object.keys(M).filter((k) => M[k].group === g && avail.has(k));
    if (!ks.length) continue;
    h += `<span class="chip-sep">${esc(g)}</span>` + ks.map((k) => `<button class="chip${k === trendKey ? ' on' : ''}" data-set="trendKey:${k}">${esc(M[k].label)}</button>`).join('');
  }
  h += '</div>';
  h += `<div class="seg top">${RANGES.map(([r, l]) => `<button class="${r === trendRange ? 'on' : ''}" data-set="trendRange:${r}">${l}</button>`).join('')}</div>`;
  // Achsenstriche bei vollen Stunden bzw. Uhrzeiten statt bei krummen Sekundenwerten
  const unit = m.fmt === 'dur' ? 3600 : (m.fmt === 'min' || m.fmt === 'clock') ? 60 : 1;

  const ps = Core.periodStats(db, idx, trendKey, from, t);
  // Schlafsaldo: die Nulllinie heißt „Bedarf gedeckt"
  const goal = trendKey === 'steps' ? (db.days[t] || db.days[Core.addDays(t, -1)] || {}).stepGoal : trendKey === 'debt' ? 0 : null;
  const reader = (i) => {
    const v = vals[i];
    return `<span>${esc(dayLabel(dates[i]))}</span><b>${esc(Core.fmt(trendKey, v))}</b>`
      + (fin(avg[i]) ? `<span class="end">Ø${m.sparse ? '' : ' 7 T'} ${esc(Core.fmt(trendKey, avg[i]))}</span>` : '');
  };
  let last = vals.length - 1;
  while (last > 0 && !fin(vals[last])) last--;

  h += '<div class="card">';
  if (ps) {
    const delta = fin(ps.prevAvg) ? ps.avg - ps.prevAvg : null;
    const better = delta == null || !m.dir ? 'ok' : delta * m.dir > 0 ? 'good' : 'warn';
    const shownDelta = delta == null ? '' : Core.fmtDelta(trendKey, delta);
    h += `<div class="big-stat"><span class="num">${valHtml(trendKey, isSum ? ps.total : ps.avg)}</span>
      <span class="muted">${isSum ? 'gesamt' : 'Ø'} im Zeitraum</span></div>
      <div class="stat-row">
        <div class="stat"><span class="stat-l">zum Vorzeitraum</span><span class="stat-v st-${shownDelta.startsWith('±') ? 'ok' : better}">${delta == null ? '–' : esc(shownDelta)}</span></div>
        <div class="stat"><span class="stat-l">Trend pro Monat</span><span class="stat-v">${fin(ps.perMonth) ? esc(Core.fmtDelta(trendKey, ps.perMonth)) : '–'}</span></div>
        <div class="stat"><span class="stat-l">${isSum ? 'Ø pro Tag' : 'Spanne'}</span><span class="stat-v">${isSum ? esc(Core.fmt(trendKey, ps.avg)) : esc(splitVal(trendKey, ps.min)[0] + '–' + splitVal(trendKey, ps.max)[0])}</span></div>
      </div>`;
  }
  const svg = Charts.trend({ dates, vals, avg, lo, hi, goal, unit, bars: isSum && dates.length <= 120, zero: isSum, fmtY: (v) => Core.fmt(trendKey, v, true) });
  h += `<div style="margin-top:var(--sp-3)">${chartBox(svg, reader, last >= 0 && fin(vals[last]) ? reader(last) : '')}</div>`;
  h += `<div class="legend"><span><i class="l-pt"></i>Tag</span><span><i class="l-avg"></i>${m.sparse ? 'Mittel 4 Wochen' : 'Mittel 7 Tage'}</span>${band ? '<span><i class="l-band"></i>Dein Normalbereich</span>' : ''}${goal != null ? `<span><i class="l-goal"></i>${trendKey === 'debt' ? 'Bedarf gedeckt' : 'Ziel'}</span>` : ''}</div>`;
  if (m.hint || band) h += `<p class="note">${m.hint ? esc(m.hint) + '. ' : ''}${band ? 'Der Normalbereich ist Dein Mittel ± eine Standardabweichung über die 30 Tage davor — etwa zwei von drei Tagen liegen darin.' : ''}</p>`;
  h += '</div>';

  if (m.group === 'Schlaf') h += phaseBars(from, t);

  // Wochen oder Monate im Vergleich
  const per = (trendRange && trendRange <= 91) ? 'week' : 'month';
  const aggFrom = per === 'week' ? Core.weekStart(Core.addDays(t, -7 * 12)) : (trendRange ? Core.addDays(t, -364).slice(0, 8) + '01' : firstDate().slice(0, 8) + '01');
  const groups = Core.aggregate(db, idx, trendKey, aggFrom, t, per).filter((g) => g.n);
  if (groups.length > 1) {
    const curKey = per === 'week' ? Core.weekStart(t) : t.slice(0, 7);
    const items = groups.map((g) => ({
      label: per === 'week' ? `${+g.key.slice(8)}.${+g.key.slice(5, 7)}.` : dfMonth.format(pdate(g.key + (g.key.length === 7 ? '-15' : ''))).replace('.', ''),
      v: g.v, cur: g.key === curKey,
    }));
    const r2 = (i) => {
      const g = groups[i];
      const lbl = per === 'week' ? `KW ${isoWeek(g.key)}` : dfMonthY.format(pdate(g.key + '-15'));
      return `<span>${esc(lbl)}</span><b>${esc(Core.fmt(trendKey, g.v))}</b><span class="end">${g.n} Tage${g.key === curKey ? ' · läuft' : ''}</span>`;
    };
    h += `<div class="sec-h">${per === 'week' ? 'Wochen' : 'Monate'}<span class="muted">${isSum ? 'Summe' : 'Mittel'}</span></div>
      <div class="card trend-bars">${chartBox(Charts.bars(items, { fmtY: (v) => splitVal(trendKey, v)[0], values: true, zero: isSum, unit }), r2, r2(groups.length - 1))}</div>`;
  }

  // Wochentage und Jahresvergleich
  if (dates.length >= 28 && !m.sparse) {
    const prof = Core.weekdayProfile(db, idx, trendKey, from, t);
    if (prof.filter((p) => p.n >= 3).length >= 5) {
      h += `<div class="sec-h">Nach Wochentag<span class="muted">Mittel im Zeitraum</span></div>
        <div class="card">${Charts.weekdays(prof.map((p) => (p.n >= 2 ? p.v : null)), { fmtY: (v) => Core.fmt(trendKey, v, true), mark: Core.weekday(t) })}</div>`;
    }
  }
  if (trendRange) {
    const ly = Core.periodStats(db, idx, trendKey, Core.addDays(from, -364), Core.addDays(t, -364));
    if (ly && ps && ly.n >= Math.min(10, dates.length / 3)) {
      const dd = (isSum ? ps.total - ly.total : ps.avg - ly.avg);
      const better = !m.dir ? 'ok' : dd * m.dir > 0 ? 'good' : 'warn';
      h += `<div class="sec-h">Vor einem Jahr</div><div class="card"><div class="stat-row">
        <div class="stat"><span class="stat-l">damals</span><span class="stat-v">${esc(Core.fmt(trendKey, isSum ? ly.total : ly.avg))}</span></div>
        <div class="stat"><span class="stat-l">jetzt</span><span class="stat-v">${esc(Core.fmt(trendKey, isSum ? ps.total : ps.avg))}</span></div>
        <div class="stat"><span class="stat-l">Unterschied</span><span class="stat-v st-${better}">${esc(Core.fmtDelta(trendKey, dd))}</span></div>
      </div></div>`;
    }
  }
  el.innerHTML = h;
  // Der gewählte Chip kann weit rechts liegen (z. B. HRV hinter den Schlaf-Chips)
  const chips = $('.chips', el), on = $('.chip.on', el);
  if (chips && on) chips.scrollLeft = on.offsetLeft - chips.clientWidth / 2 + on.offsetWidth / 2;
}

/** Schlafphasen als gestapelte Balken: bei vier Wochen jede Nacht, darüber
    das Mittel je Woche oder Monat. Zeigt, ob mehr Schlaf auch mehr Tief-
    und REM-Schlaf heißt — oder nur mehr Leichtschlaf. */
function phaseBars(from, t) {
  const KEYS = ['deep', 'light', 'rem', 'awake'];
  const span = Core.dayDiff(from, t);
  const per = span < 35 ? 'night' : span <= 100 ? 'week' : 'month';
  let rows;
  if (per === 'night') {
    rows = Core.dateRange(from, t).map((d) => {
      const x = db.days[d] || {};
      return { key: d, n: KEYS.some((k) => fin(x[k])) ? 1 : 0, vals: KEYS.map((k) => (fin(x[k]) ? x[k] : 0)) };
    });
  } else {
    const aggFrom = per === 'week' ? Core.weekStart(from) : from.slice(0, 8) + '01';
    const parts = KEYS.map((k) => Core.aggregate(db, idx, k, aggFrom, t, per));
    rows = parts[0].map((g, i) => ({ key: g.key, n: g.n, vals: parts.map((p) => p[i].v || 0) }));
  }
  rows = rows.filter((r) => r.n);
  if (rows.length < 2) return '';
  const label = (k) => (per === 'month' ? dfMonth.format(pdate(k + '-15')).replace('.', '') : `${+k.slice(8)}.${+k.slice(5, 7)}.`);
  const items = rows.map((r) => ({
    label: label(r.key), v: r.vals.reduce((a, b) => a + b, 0),
    parts: r.vals.map((v, i) => ({ v, cls: 'ph-' + KEYS[i] })),
  }));
  const reader = (i) => {
    const r = rows[i];
    const head = per === 'night' ? dayLabel(r.key) : per === 'week' ? `KW ${isoWeek(r.key)}` : dfMonthY.format(pdate(r.key + '-15'));
    return `<span>${esc(head)}</span>` + r.vals.map((v, j) => (v > 0 ? `<span class="rd-ph"><i class="ph-${KEYS[j]}"></i>${esc(Core.fmtDur(v))}</span>` : '')).join('');
  };
  return `<div class="sec-h">Phasen ${per === 'night' ? 'je Nacht' : per === 'week' ? 'je Woche' : 'je Monat'}<span class="muted">${per === 'night' ? '' : 'Mittel pro Nacht'}</span></div>
    <div class="card">${chartBox(Charts.bars(items, { fmtY: (v) => splitVal('slp', v)[0], unit: 3600, h: 160, nTicks: 4 }), reader, reader(rows.length - 1))}
    <div class="legend">${KEYS.map((k) => `<span><i class="ph-${k}"></i>${PHASE_LABEL[k]}</span>`).join('')}</div></div>`;
}

/* ── 9. Training ────────────────────────────────────────────── */

const PERIODS = [['week', 'Woche'], ['month', 'Monat'], ['year', 'Jahr']];

function periodBounds(p, t) {
  if (p === 'week') return [Core.weekStart(t), t];
  if (p === 'month') return [t.slice(0, 8) + '01', t];
  return [t.slice(0, 5) + '01-01', t];
}
function sumActs(from, to) {
  const out = { n: 0, dur: 0, dist: 0, load: 0, gain: 0 };
  for (const a of db.acts) {
    if (a.parent || a.date < from || a.date > to) continue;
    out.n++; out.dur += a.dur || 0; out.dist += a.dist || 0; out.gain += a.gain || 0;
    out.load += Core.actLoad(a, (db.days[a.date] || {}).rhr || db.profile.rhr, db.profile.maxHr);
  }
  return out;
}

function renderTraining() {
  const el = $('#view-training');
  if (!db.acts.length) {
    el.innerHTML = `<div class="empty"><h2>Noch keine Aktivitäten</h2><p>${db.setup ? 'Im abgeglichenen Zeitraum hat Garmin keine Aktivitäten.' : 'Sobald der erste Abgleich gelaufen ist, stehen hier Deine Einheiten.'}</p></div>`;
    return;
  }
  const t = Core.today();
  const [pf, pt] = periodBounds(trainPeriod, t);
  const cur = sumActs(pf, pt);
  // Vergleich: gleich weit in den vorigen Zeitraum hinein (Montag–Donnerstag gegen Montag–Donnerstag)
  const len = Core.dayDiff(pf, pt);
  const prevStart = trainPeriod === 'week' ? Core.addDays(pf, -7)
    : trainPeriod === 'month' ? Core.isoDate(new Date(pdate(pf).getFullYear(), pdate(pf).getMonth() - 1, 1, 12))
      : Core.isoDate(new Date(pdate(pf).getFullYear() - 1, 0, 1, 12));
  const prev = sumActs(prevStart, Core.addDays(prevStart, len));
  const cmp = (a, b, f) => (b ? `<span class="stat-d st-${a >= b ? 'good' : 'ok'}">${a >= b ? '+' : '−'}${esc(f(Math.abs(a - b)))}</span>` : '<span class="stat-d st-off">–</span>');

  let h = `<div class="seg top">${PERIODS.map(([p, l]) => `<button class="${p === trainPeriod ? 'on' : ''}" data-set="trainPeriod:${p}">${l}</button>`).join('')}</div>`;
  h += `<div class="card"><div class="stat-row">
    <div class="stat"><span class="stat-l">Einheiten</span><span class="stat-v">${nf0.format(cur.n)}</span>${cmp(cur.n, prev.n, nf0.format)}</div>
    <div class="stat"><span class="stat-l">Zeit</span><span class="stat-v">${esc(Core.fmtDur(cur.dur))}</span>${cmp(cur.dur, prev.dur, Core.fmtDur)}</div>
    <div class="stat"><span class="stat-l">Distanz</span><span class="stat-v">${esc(km(cur.dist))}</span>${cmp(cur.dist, prev.dist, km)}</div>
  </div><p class="note">Vergleich mit dem gleichen Abschnitt ${trainPeriod === 'week' ? 'der Vorwoche' : trainPeriod === 'month' ? 'des Vormonats' : 'des Vorjahrs'}.</p></div>`;

  // Umfang je Woche, nach Sportart gestapelt
  const weeks = Core.trainingWeeks(db, idx, t, trainPeriod === 'year' ? 52 : 12);
  const sports = Core.SPORTS.filter((s) => weeks.some((w) => w.sport[s.id]));
  let items, unitLbl;
  if (trainPeriod === 'year') {
    // Ein Jahr als Monate — 52 Balken wären auf dem Handy Striche
    const months = new Map();
    for (const a of db.acts) {
      if (a.parent || a.date < Core.addDays(t, -364).slice(0, 8) + '01') continue;
      const k = a.date.slice(0, 7);
      if (!months.has(k)) months.set(k, {});
      const sp = Core.sportOf(a.type);
      months.get(k)[sp] = (months.get(k)[sp] || 0) + (a.dur || 0);
    }
    const keys = [];
    for (let i = 11; i >= 0; i--) { const d = new Date(pdate(t).getFullYear(), pdate(t).getMonth() - i, 15, 12); keys.push(Core.isoDate(d).slice(0, 7)); }
    items = keys.map((k) => {
      const s = months.get(k) || {};
      return { key: k, label: dfMonth.format(pdate(k + '-15')).replace('.', ''), v: Object.values(s).reduce((a, b) => a + b, 0) / 3600, parts: sports.map((sp) => ({ v: (s[sp.id] || 0) / 3600, cls: 'sp-' + sp.id })), sport: s };
    });
    unitLbl = 'Stunden je Monat';
  } else {
    items = weeks.map((w) => ({ key: w.start, label: `${+w.start.slice(8)}.${+w.start.slice(5, 7)}.`, v: w.dur / 3600, parts: sports.map((sp) => ({ v: (w.sport[sp.id] || 0) / 3600, cls: 'sp-' + sp.id })), sport: w.sport, w }));
    unitLbl = 'Stunden je Woche';
  }
  const rv = (i) => {
    const it = items[i];
    const parts = Core.SPORTS.filter((s) => it.sport[s.id]).map((s) => `${s.label} ${Core.fmtDur(it.sport[s.id])}`).join(' · ');
    const lbl = it.w ? `KW ${isoWeek(it.key)}` : dfMonthY.format(pdate(it.key + '-15'));
    return `<span>${esc(lbl)}</span><b>${esc(Core.fmtDur(it.v * 3600))}</b><span class="end clip1">${esc(parts)}</span>`;
  };
  h += `<div class="sec-h">Umfang<span class="muted">${unitLbl}</span></div><div class="card">
    ${chartBox(Charts.bars(items, { fmtY: (v) => nf0.format(v) }), rv, rv(items.length - 1))}
    <div class="legend">${sports.map((s) => `<span><i class="sp-${s.id}"></i>${esc(s.label)}</span>`).join('')}</div></div>`;

  // Belastung: akut gegen chronisch
  const ls = Core.loadStatus(db, idx, t);
  const rows = Core.loadSeries(db, idx, Core.addDays(t, -89), t);
  if (rows.length && rows.some((r) => r.acute > 0)) {
    const rl = (i) => `<span>${esc(dayLabel(rows[i].date))}</span><b>${nf0.format(rows[i].acute)}</b><span class="end">üblich ${nf0.format(rows[i].chronic)} · ${rows[i].chronic ? nf1.format(rows[i].acute / rows[i].chronic) + '×' : '–'}</span>`;
    const stc = ls ? { low: 'ok', ok: 'good', high: 'warn', spike: 'bad' }[ls.status] : 'off';
    h += `<div class="sec-h">Belastung<span class="muted">letzte 90 Tage</span></div><div class="card">
      ${ls ? `<div class="big-stat"><span class="num st-${stc}">${nf1.format(ls.ratio)}×</span><span class="muted">${esc(ls.text)} · 7 Tage ${nf0.format(ls.acute)} gegen üblich ${nf0.format(ls.chronic)}</span></div>` : ''}
      <div style="margin-top:var(--sp-2)">${chartBox(Charts.load(rows), rl, rl(rows.length - 1))}</div>
      <div class="legend"><span><i class="l-acute"></i>letzte 7 Tage</span><span><i class="l-chronic"></i>üblich (Wochenmittel aus 4 Wochen)</span><span><i class="l-ok"></i>gut verträglich</span></div>
      <p class="note">Belastung ist Garmins Trainingslast je Einheit (ohne Wert: aus Dauer und Puls geschätzt). Bis etwa 1,3× des Üblichen gilt als gut verträglich, ab 1,5× steigt das Verletzungsrisiko.</p></div>`;
  }

  // VO2max aus den Aktivitäten
  const vo2d = Object.keys(idx.vo2).sort();
  if (vo2d.length >= 2) {
    const from = maxDate(vo2d[0], Core.addDays(t, -364));
    const dates = Core.dateRange(from, t);
    const vals = dates.map((d) => (fin(idx.vo2[d]) ? idx.vo2[d] : null));
    let lastV = null; const step = vals.map((v) => { if (fin(v)) lastV = v; return lastV; });
    const rv2 = (i) => `<span>${esc(dayLabel(dates[i]))}</span><b>${fin(step[i]) ? nf0.format(step[i]) : '–'}</b>`;
    const latest = idx.vo2[vo2d[vo2d.length - 1]];
    h += `<div class="sec-h">VO2max<span class="muted">aus Läufen und Fahrten</span></div><div class="card">
      <div class="big-stat"><span class="num">${nf0.format(latest)}</span><span class="muted">zuletzt am ${esc(dfDate.format(pdate(vo2d[vo2d.length - 1])))}</span></div>
      ${chartBox(Charts.trend({ dates, vals, avg: step, h: 140, fmtY: (v) => nf0.format(v) }), rv2, '')}</div>`;
  }

  // Bestzeiten
  const year = t.slice(0, 4) + '-01-01';
  const best = Core.bestEfforts(db, bestScope === 'year' ? year : null);
  if (best.length || bestScope === 'year') {
    const names = { 1000: '1 km', 1609: '1 Meile', 5000: '5 km', 10000: '10 km', 21098: 'Halbmarathon', 42195: 'Marathon' };
    h += `<div class="sec-h">Bestzeiten Laufen</div>
      <div class="seg top"><button class="${bestScope === 'all' ? 'on' : ''}" data-set="bestScope:all">Allzeit</button><button class="${bestScope === 'year' ? 'on' : ''}" data-set="bestScope:year">${t.slice(0, 4)}</button></div>
      <div class="rows">${best.length ? best.map((b) => `<button class="row" data-act="${esc(b.id)}"><span class="grow"><span class="t">${names[b.dist]}</span><span class="sub">${esc(dfDate.format(pdate(b.date)))} · ${esc(b.name)}</span></span>
        <span class="end"><b class="num">${esc(hms(b.t))}</b><span class="sub">${esc(hms(b.t / (b.dist / 1000)))} /km</span></span></button>`).join('')
        : '<div class="row"><span class="grow muted">In diesem Jahr noch keine.</span></div>'}</div>
      <p class="note">Schnellster Abschnitt innerhalb eines Laufs, wie Garmin ihn erkennt — nicht nur ganze Wettkämpfe. Gilt für den abgeglichenen Zeitraum.</p>`;
  }

  // Liste
  const present = Core.SPORTS.filter((s) => db.acts.some((a) => !a.parent && Core.sportOf(a.type) === s.id));
  if (trainSport !== 'all' && !present.some((s) => s.id === trainSport)) trainSport = 'all';
  const list = db.acts.filter((a) => !a.parent && (trainSport === 'all' || Core.sportOf(a.type) === trainSport));
  h += `<div class="sec-h">Aktivitäten<span class="muted">${nf0.format(list.length)}</span></div>`;
  if (present.length > 1) {
    h += `<div class="chips"><button class="chip${trainSport === 'all' ? ' on' : ''}" data-set="trainSport:all">Alle</button>${present.map((s) => `<button class="chip${trainSport === s.id ? ' on' : ''}" data-set="trainSport:${s.id}">${esc(s.label)}</button>`).join('')}</div>`;
  }
  let lastWeek = null;
  h += '<div class="rows">';
  for (const a of list.slice(0, trainShow)) {
    const ws = Core.weekStart(a.date);
    if (ws !== lastWeek) {
      lastWeek = ws;
      const s = list.filter((x) => Core.weekStart(x.date) === ws);
      const dur = s.reduce((acc, x) => acc + (x.dur || 0), 0), dist = s.reduce((acc, x) => acc + (x.dist || 0), 0);
      h += `<div class="row-h"><span>KW ${isoWeek(ws)} · ab ${+ws.slice(8)}.${+ws.slice(5, 7)}.</span><span>${s.length}× · ${esc(Core.fmtDur(dur))}${dist ? ' · ' + esc(km(dist)) : ''}</span></div>`;
    }
    h += actRow(a);
  }
  h += '</div>';
  if (list.length > trainShow) h += `<div class="btn-row" style="margin-top:var(--sp-3)"><button class="btn" data-action="more">Weitere ${nf0.format(Math.min(30, list.length - trainShow))} zeigen</button></div>`;
  el.innerHTML = h;
}

/** Aktivität im Sheet: Kennwerte sofort, Strecke und Kurven nach dem
    Laden der Originaldatei (beim zweiten Öffnen aus dem Zwischenspeicher). */
function openActivity(id, back) {
  const a = db.acts.find((x) => String(x.id) === String(id));
  if (!a) return;
  const facts = [
    [a.dist ? km(a.dist) : null, 'Distanz'],
    [hms(a.dur), 'Zeit'],
    [a.spd && a.dist ? speedText(a.spd, a.type) : null, usesPace(a.type) ? 'Tempo' : 'Geschwindigkeit'],
    [a.hr ? nf0.format(a.hr) + ' bpm' : null, 'Ø Puls'],
    [a.hrMax ? nf0.format(a.hrMax) + ' bpm' : null, 'Max. Puls'],
    [fin(a.gain) && a.gain > 0 ? nf0.format(a.gain) + ' m' : null, 'Anstieg'],
    [a.kcal ? nf0.format(a.kcal) + ' kcal' : null, 'Kalorien'],
    [a.load ? nf0.format(a.load) : null, 'Belastung'],
    [fin(a.te) ? nf1.format(a.te) : null, 'Aerober TE'],
    [fin(a.teAn) ? nf1.format(a.teAn) : null, 'Anaerober TE'],
    [a.cad ? nf0.format(a.cad) + (Core.sportOf(a.type) === 'bike' ? ' rpm' : ' spm') : null, 'Kadenz'],
    [a.pwr ? nf0.format(a.pwr) + ' W' : null, 'Ø Leistung'],
    [a.gap && Core.sportOf(a.type) === 'run' ? speedText(a.gap, a.type) : null, 'Tempo bereinigt'],
    [a.vo2 ? nf0.format(a.vo2) : null, 'VO2max'],
    [fin(a.bb) ? (a.bb > 0 ? '+' : '') + nf0.format(a.bb) : null, 'Body Battery'],
  ].filter((f) => f[0] && f[0] !== '–');
  let h = `<p class="note" style="margin:0 0 var(--sp-3)">${esc(dfLong.format(pdate(a.date)))} · ${esc(a.start.slice(11, 16))} · ${esc(Core.typeLabel(a.type))}${a.loc ? ' · ' + esc(a.loc) : ''}${a.pr ? ' · Bestleistung' : ''}</p>`;
  h += `<div class="facts">${facts.map(([v, l]) => `<div><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('')}</div>`;
  if (a.z) {
    const tot = a.z.reduce((s, v) => s + v, 0) || 1;
    const zs = db.profile.zones;
    h += `<div class="sec-h">Pulszonen</div><div class="zones">${a.z.map((v, i) => `<div class="zone"><b>Z${i + 1}</b>
      <div class="meter z${i + 1}"><i style="width:${(v / tot) * 100}%"></i></div><span>${esc(Core.fmtDur(v))}</span></div>`).join('')}</div>
      ${zs ? `<p class="note">Zonen ab ${zs.map((z) => nf0.format(z)).join(' · ')} bpm.</p>` : ''}`;
  }
  if (a.teL) h += `<p class="note">Trainingseffekt laut Garmin: ${esc(teLabel(a.teL))}.</p>`;
  h += '<div class="sec-h">Verlauf</div><div id="actStreams"><div class="loading"><span class="spinner"></span><span>Originaldatei wird geladen …</span></div></div>';
  openSheet(a.name || Core.typeLabel(a.type), h, null);
  if (back) $('#sheetCancel').onclick = back;
  loadStreams(a).then((st) => {
    const box = $('#actStreams');
    if (!box || $('#sheet').classList.contains('hidden')) return;
    box.innerHTML = streamsHtml(a, st);
    wireStreams(a, st);
  }).catch((e) => {
    const box = $('#actStreams');
    if (box) box.innerHTML = `<div class="hint warn">${ICON.warn}<div class="grow"><span>${esc(e.message)}</span></div></div>`;
  });
}
function teLabel(k) {
  return ({ RECOVERY: 'Erholung', BASE: 'Grundlage', TEMPO: 'Tempo', THRESHOLD: 'Schwelle', VO2MAX: 'VO2max', ANAEROBIC_CAPACITY: 'anaerobe Kapazität', SPRINT: 'Sprint', LACTATE_THRESHOLD: 'Laktatschwelle' })[k] || k.toLowerCase().replace(/_/g, ' ');
}

const streamCache = new Map();
async function loadStreams(a) {
  if (streamCache.has(a.id)) return streamCache.get(a.id);
  let st = await idbGet(a.id);
  if (!st) {
    if (!isConfigured()) throw new Error('Ohne Verbindung zu Garmin lassen sich die Kurven nicht laden.');
    const buf = await api(`/download-service/files/activity/${a.id}`, { binary: true, accept: 'application/zip, application/x-zip-compressed, application/octet-stream' });
    st = await Fit.fromDownload(buf);
    if (!st) throw new Error('Die Datei enthält keine Messpunkte.');
    await idbPut(a.id, st);
  }
  streamCache.set(a.id, st);
  return st;
}

let trackBy = 'hr';
function streamsHtml(a, st) {
  let h = '';
  const xs = st.t;
  // Zeitachse: unter einer Stunde „25′", darüber „1:10"
  const xFmt = (v) => (v < 3600 ? Math.round(v / 60) + '′' : `${Math.floor(v / 3600)}:${pad2(Math.round((v % 3600) / 60))}`);
  if (st.track && st.track.length > 1) {
    const by = trackBy === 'spd' && st.spd ? 'spd' : st.hr ? 'hr' : st.spd ? 'spd' : null;
    h += `<div id="trackBox">${Charts.track(st.track, by ? st[by] : null)}</div>`;
    if (st.hr && st.spd) h += `<div class="seg top"><button class="${by === 'hr' ? 'on' : ''}" data-track="hr">Farbe: Puls</button><button class="${by === 'spd' ? 'on' : ''}" data-track="spd">Farbe: ${usesPace(a.type) ? 'Tempo' : 'Geschwindigkeit'}</button></div>`;
    h += '<div class="legend" style="margin-bottom:var(--sp-3)"><span><i class="lz1"></i>niedrig</span><span><i class="lz3"></i>mittel</span><span><i class="lz5"></i>hoch</span><span>· grün Start, rot Ziel</span></div>';
  }
  const curve = (key, label, fmtY, cls, opt) => {
    if (!st[key]) return '';
    const reader = (i) => `<span>${esc(xs[i] != null ? hms(xs[i]) : '')}</span><b>${esc(fin(st[key][i]) ? fmtY(st[key][i]) : '–')}</b><span class="end">${st.dist && fin(st.dist[i]) ? esc(km(st.dist[i])) : ''}</span>`;
    const good = st[key].filter(fin);
    const first = good.length ? `<span>Ø</span><b>${esc(fmtY(Core.mean(good)))}</b><span class="end">max. ${esc(fmtY(Math.max(...good)))}</span>` : '';
    return `<div class="card" style="margin-top:var(--sp-2)"><div class="card-h">${esc(label)}</div>${chartBox(Charts.curve(xs, st[key], Object.assign({ fmtY, fmtX: xFmt, cls, fill: true }, opt || {})), reader, first, 's')}</div>`;
  };
  h += curve('hr', 'Puls', (v) => nf0.format(v), 'c-hr');
  if (st.spd) {
    const pace = usesPace(a.type);
    // Tempo als min/km: Stillstand (unter 1 km/h) würde die Skala sprengen
    const vals = pace ? st.spd.map((v) => (fin(v) && v > 0.28 ? 1000 / v : null)) : st.spd.map((v) => (fin(v) ? v * 3.6 : null));
    const reader = (i) => `<span>${esc(hms(xs[i]))}</span><b>${esc(fin(vals[i]) ? (pace ? hms(vals[i]) + ' /km' : nf1.format(vals[i]) + ' km/h') : '–')}</b>`;
    h += `<div class="card" style="margin-top:var(--sp-2)"><div class="card-h">${pace ? 'Tempo' : 'Geschwindigkeit'}</div>${chartBox(Charts.curve(xs, vals, { fmtY: pace ? (v) => hms(v) : (v) => nf0.format(v), fmtX: xFmt, invert: pace, fill: !pace }), reader, '', 's')}</div>`;
  }
  h += curve('alt', 'Höhe', (v) => nf0.format(v) + ' m', 'c-alt');
  h += curve('cad', 'Kadenz', (v) => nf0.format(v));
  h += curve('pwr', 'Leistung', (v) => nf0.format(v) + ' W');
  if (st.laps && st.laps.length > 1) {
    h += `<div class="sec-h">Runden</div><div class="card laps-wrap"><table class="laps"><thead><tr><th>#</th><th>Distanz</th><th>Zeit</th><th>${usesPace(a.type) ? 'Tempo' : 'km/h'}</th><th>Puls</th></tr></thead><tbody>
      ${st.laps.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(km(l.dist))}</td><td>${esc(hms(l.dur))}</td><td>${esc(l.spd ? speedText(l.spd, a.type).replace(' /km', '').replace(' km/h', '') : '–')}</td><td>${l.hr ? nf0.format(l.hr) : '–'}</td></tr>`).join('')}
      </tbody></table></div>`;
  }
  return h || '<p class="note">Die Datei enthält keine Kurven.</p>';
}
function wireStreams(a, st) {
  $$('#actStreams [data-track]').forEach((b) => {
    b.onclick = () => {
      trackBy = b.dataset.track;
      $('#actStreams').innerHTML = streamsHtml(a, st);
      wireStreams(a, st);
    };
  });
}

/* ── 10. Muster ─────────────────────────────────────────────── */

const PAT_RANGES = [[91, '3 M'], [182, '6 M'], [365, '1 J'], [0, 'Alles']];
const Y_NOUN = { hrv: 'Deine HRV', rhr: 'Dein Ruhepuls', slpScore: 'Dein Schlafscore', slp: 'Deine Schlafdauer', bbMax: 'Deine Body Battery', stress: 'Dein Stress' };
const X_SHORT = {
  load: ['viel Training', 'wenig/kein Training'], late: ['Abendtraining', 'kein Abendtraining'], slp: ['lange Nächte', 'kurze Nächte'],
  bed: ['spät eingeschlafen', 'früh eingeschlafen'], stress: ['stressige Tage', 'entspannte Tage'], steps: ['viele Schritte', 'wenige Schritte'],
  slpScore: ['gute Nächte', 'schlechte Nächte'],
};
const STRENGTH = { stark: 'starker Zusammenhang', deutlich: 'deutlicher Zusammenhang', leicht: 'leichter Zusammenhang', kaum: 'kaum Zusammenhang' };

function renderPatterns() {
  const el = $('#view-patterns');
  if (!Object.keys(db.days).length) { el.innerHTML = '<div class="empty"><h2>Noch keine Daten</h2><p>Für Muster braucht es ein paar Wochen Verlauf.</p></div>'; return; }
  const t = Core.today();
  const from = patRange ? Core.addDays(t, -(patRange - 1)) : firstDate();
  const res = Core.insights(db, idx, from, t);
  const ok = res.filter((r) => r.enough).sort((a, b) => (b.solid - a.solid) || (Math.abs(b.r) - Math.abs(a.r)));
  const few = res.filter((r) => !r.enough);

  let h = `<div class="seg top">${PAT_RANGES.map(([r, l]) => `<button class="${r === patRange ? 'on' : ''}" data-set="patRange:${r}">${l}</button>`).join('')}</div>`;
  h += '<p class="note" style="margin:0 2px var(--sp-3)">Was hängt bei Dir womit zusammen? Die Tage werden nach der Ursache gedrittelt; verglichen wird das obere mit dem unteren Drittel. Oben steht, was am deutlichsten ist.</p>';
  if (!ok.length) h += '<div class="empty"><h2>Noch zu wenig Tage</h2><p>Jede Auswertung braucht mindestens 20 Tage mit beiden Werten. Ein längerer Zeitraum oder mehr Verlauf hilft.</p></div>';

  for (const r of ok) {
    const p = r.pair, ym = M[p.y], xm = M[p.x] || {};
    const noun = Y_NOUN[p.y] || ym.label;
    const sent = `${p.hi} lag ${noun} im Schnitt bei ${Core.fmt(p.y, r.yHi)}, ${p.lo} bei ${Core.fmt(p.y, r.yLo)}.`;
    const st = !r.solid || r.strength === 'kaum' ? 'off' : r.effect > 0 ? 'good' : 'warn';
    const [hiL, loL] = X_SHORT[p.x] || ['viel', 'wenig'];
    const thr = (v) => (p.x === 'load' ? nf0.format(v) : Core.fmt(p.x, v));
    const hiSub = p.bin ? `${r.nHi} Tage` : `ab ${thr(r.xHi)} · ${r.nHi} Tage`;
    // Das untere Drittel „Belastung bis 0" sind schlicht die Ruhetage
    const restDays = p.x === 'load' && r.xLo === 0;
    const loSub = p.bin || restDays ? `${r.nLo} Tage` : `bis ${thr(r.xLo)} · ${r.nLo} Tage`;
    h += `<div class="card ins">
      <div class="ins-h"><span class="badge ${r.solid ? r.strength : ''}">${esc(r.solid ? STRENGTH[r.strength] : 'eher Zufall')}</span><span class="muted small">${r.n} Tage</span></div>
      <div class="ins-t">${esc(sent)}</div>
      <div class="vs"><div><b>${esc(Core.fmt(p.y, r.yHi))}</b><span>${esc(hiL)}<br>${esc(hiSub)}</span></div>
        <div><b>${esc(Core.fmt(p.y, r.yLo))}</b><span>${esc(restDays ? 'Ruhetage' : loL)}<br>${esc(loSub)}</span></div></div>
      <div class="ins-m"><span class="st-${st}">Unterschied ${esc(Core.fmtDelta(p.y, r.diff))}${fin(r.pct) ? ' (' + esc(nfPct.format(r.pct).replace('-', '−')) + ')' : ''}</span> · r = ${esc(nf2.format(r.r))}${r.solid ? '' : ' · bei so wenig Abstand nicht von Zufall zu unterscheiden'}</div>
      ${p.bin ? '' : openScatter.has(p.id)
        ? `<div class="chart">${Charts.scatter(r.pts, { fmtX: (v) => (p.x === 'load' ? nf0.format(v) : Core.fmt(p.x, v, true)), fmtY: (v) => Core.fmt(p.y, v, true), fit: true, xLo: r.xLo, xHi: r.xHi, xLabel: xm.label + (p.lag ? ' (Vortag)' : '') })}</div>
           <button class="link" data-scatter="${p.id}">Punkte ausblenden</button>`
        : `<button class="link" data-scatter="${p.id}">Alle Tage als Punkte zeigen</button>`}
    </div>`;
  }

  // Wochentage: Rhythmus der Woche auf einen Blick
  const wk = [['slp', 'Schlafdauer'], ['bed', 'Einschlafzeit'], ['steps', 'Schritte'], ['stress', 'Stress']]
    .map(([k, l]) => [k, l, Core.weekdayProfile(db, idx, k, from, t)])
    .filter(([, , p]) => p.filter((x) => x.n >= 3).length >= 5);
  if (wk.length) {
    h += '<div class="sec-h">Wochenrhythmus</div>';
    for (const [k, l, p] of wk) {
      h += `<div class="card"><div class="card-h">${esc(l)}<span class="muted">Mittel je Wochentag</span></div>${Charts.weekdays(p.map((x) => (x.n >= 2 ? x.v : null)), { fmtY: (v) => (k === 'steps' ? (v >= 10000 ? nf1.format(v / 1000) + 'k' : nf0.format(v)) : Core.fmt(k, v, true)), mark: Core.weekday(t) })}</div>`;
    }
  }
  if (few.length) {
    h += `<div class="sec-h">Noch zu wenig Daten</div><div class="rows">${few.map((r) => `<div class="row"><span class="grow"><span class="t">${esc((M[r.pair.x] || { label: 'Abendtraining' }).label)} → ${esc(M[r.pair.y].label)}</span><span class="sub">${r.n} von mindestens 20 Tagen${r.pair.bin ? ', davon je 6 mit und ohne' : ''}</span></span></div>`).join('')}</div>`;
  }
  h += '<p class="note">Ein Zusammenhang ist noch keine Ursache: Wer krank wird, trainiert weniger und hat trotzdem eine niedrige HRV. Die Auswertung zeigt, worauf es sich zu achten lohnt.</p>';
  el.innerHTML = h;
}

/* ── 11. Einstellungen ──────────────────────────────────────── */

function openSettings() {
  const key = keyGet();
  const nDays = Object.keys(db.days).length;
  const span = nDays ? `${dfDate.format(pdate(firstDate()))} bis ${dfDate.format(pdate(Object.keys(db.days).reduce((a, b) => (a > b ? a : b))))}` : '';
  let size = 0;
  try { size = (localStorage.getItem(KEY) || '').length; } catch (e) { /* egal */ }
  const srcName = { daily: 'Tageswerte', sleep: 'Schlaf', hrv: 'HRV', weight: 'Gewicht', acts: 'Aktivitäten' };
  const gapSpan = (a, b) => (a === b ? dfDate.format(pdate(a))
    : a.slice(0, 7) === b.slice(0, 7) ? `${+a.slice(8)}.–${dfDate.format(pdate(b))}` : fmtSpan(a, b));
  // Je Quelle: was fehlschlug und ob es noch nachgeholt wird
  const gapRows = SRC_IDS.map((k) => {
    const fg = failedGaps(k).sort((x, y) => (x[0] < y[0] ? -1 : 1)), m = db.sync.warn[k];
    if (!fg.length && !m) return '';
    // Aneinandergrenzende Stücke als ein Zeitraum, neueste zuerst
    const joined = [];
    for (const g of fg) {
      const last = joined[joined.length - 1];
      if (last && Core.addDays(last[1], 1) >= g[0]) last[1] = maxDate(last[1], g[1]); else joined.push([g[0], g[1]]);
    }
    joined.reverse();
    const spans = joined.slice(0, 4).map((g) => gapSpan(g[0], g[1]));
    if (joined.length > 4) spans.push(`${joined.length - 4} weitere`);
    const note = !fg.length ? ''
      : fg.some((g) => g[2] < GAP_TRIES) ? 'wird beim nächsten Abgleich nachgeholt' : 'mehrmals fehlgeschlagen — „Alles neu laden“ versucht es noch einmal';
    const sub = [spans.length ? 'Fehlt: ' + spans.join(', ') : '', m, note].filter(Boolean).join(' · ');
    return `<div class="row"><span class="grow"><span class="t st-warn">${esc(srcName[k] || k)} unvollständig</span><span class="sub">${esc(sub)}</span></span></div>`;
  }).join('');
  const pending = SRC_IDS.filter((k) => (db.sync.gaps[k] || []).some((g) => !g[2]));

  openSheet('Einstellungen', `
    <div class="sec-h">Verbindung</div>
    ${db.sync.error ? `<div class="hint err" style="margin:0 0 var(--sp-3)">${ICON.warn}<div class="grow"><strong>Letzter Abgleich fehlgeschlagen</strong><span>${esc(db.sync.error)}</span></div></div>` : ''}
    <label>Proxy-Adresse
      <input id="setProxy" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://garmin-proxy.….workers.dev" value="${esc(db.settings.proxy)}">
      <span class="field-note">Dein Cloudflare Worker. <button class="link" style="min-height:0;padding:0" data-action="proxyGuide">Wie richte ich ihn ein?</button></span>
    </label>
    <label>Personal API Key von Garmin
      <input id="setKey" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${key ? 'gespeichert — zum Ändern neu einfügen' : 'Schlüssel einfügen'}">
      <span class="field-note">Erzeugen unter <a href="${KEY_PAGE}" target="_blank" rel="noopener">connect.garmin.com → Personal API Key</a> (Laufzeit am besten 1 Jahr). Er bleibt nur auf diesem Gerät und kommt in kein Backup.</span>
    </label>
    <div class="btn-col">
      <button class="btn btn-primary" id="btnTest">Speichern und Verbindung testen</button>
      <div id="testOut"></div>
    </div>

    <div class="sec-h">Daten</div>
    <div class="lbl">Verlauf laden
      <div class="seg" id="setHist">${[[365, '1 Jahr'], [730, '2 Jahre'], [1825, '5 Jahre']].map(([v, l]) => `<button data-v="${v}" class="${db.settings.history === v ? 'on' : ''}">${l}</button>`).join('')}</div>
    </div>
    <div class="rows">
      <button class="row" id="setAuto"><span class="grow"><span class="t">Beim Öffnen abgleichen</span><span class="sub">wenn der letzte Abgleich über eine Stunde her ist</span></span>
        <span class="switch" role="switch" aria-checked="${db.settings.autoSync}"></span></button>
      <div class="row"><span class="grow"><span class="t">${nf0.format(nDays)} Tage · ${nf0.format(db.acts.length)} Aktivitäten</span>
        <span class="sub">${esc(span || 'noch nichts geladen')}${db.sync.last ? ' · abgeglichen ' + esc(agoLabel(db.sync.last)) : ''} · ${nf0.format(size / 1024)} KB</span></span></div>
      ${pending.length ? `<div class="row"><span class="grow"><span class="t">Verlauf wird nachgeprüft</span><span class="sub">${esc(pending.map((k) => srcName[k]).join(', '))} · beim nächsten Abgleich</span></span></div>` : ''}
      ${gapRows}
    </div>
    <div class="btn-row" style="margin-top:var(--sp-3)">
      <button class="btn" id="btnSyncNow">Jetzt abgleichen</button>
      <button class="btn" id="btnReload">Alles neu laden</button>
    </div>

    <div class="sec-h">Darstellung</div>
    <div class="seg" id="setTheme">${Object.entries(THEMES).map(([k, v]) => `<button data-v="${k}" class="${db.theme === k ? 'on' : ''}">${v.label}</button>`).join('')}</div>

    <div class="sec-h">Sicherung</div>
    <p class="note" style="margin:0 2px var(--sp-3)">Die Daten liegen nur auf diesem Gerät. Garmin hat sie zwar auch — aber ein Jahr Verlauf neu zu laden dauert Minuten, und „Browserdaten löschen" nimmt alles mit. Ein Backup enthält Daten und Einstellungen, nicht den Schlüssel.${db.lastBackup ? ' Letztes Backup: ' + esc(dfDate.format(new Date(db.lastBackup))) + '.' : ''}</p>
    <div class="btn-row">
      <button class="btn" id="btnExport">Backup speichern</button>
      <button class="btn" id="btnImport">Backup laden</button>
    </div>
    <input type="file" id="fileImport" accept="application/json,.json" class="hidden">

    <div class="sec-h">App</div>
    <div class="btn-col">
      <button class="btn btn-block hidden" id="btnInstall">App installieren</button>
      <button class="btn btn-block" id="btnUpdate">Nach Update suchen</button>
    </div>
    <p class="note c">Version ${APP_VERSION}</p>

    <div class="sec-h">Löschen</div>
    <div class="btn-col">
      ${key ? '<button class="btn btn-block danger-text" id="btnKeyDel">Schlüssel von diesem Gerät entfernen</button>' : ''}
      <button class="btn btn-block danger-text" id="btnWipe">Alle Garmin-Daten auf diesem Gerät löschen</button>
    </div>
  `, null);

  $('#btnTest').onclick = () => saveAndTest();
  $('#setHist').onclick = (e) => {
    const b = e.target.closest('button[data-v]'); if (!b) return;
    db.settings.history = +b.dataset.v; save();
    $$('#setHist button').forEach((x) => x.classList.toggle('on', x === b));
    if (db.setup) toast('Der fehlende Verlauf kommt beim nächsten Abgleich');
  };
  $('#setAuto').onclick = () => {
    db.settings.autoSync = !db.settings.autoSync; save();
    $('#setAuto .switch').setAttribute('aria-checked', db.settings.autoSync);
  };
  $('#setTheme').onclick = (e) => {
    const b = e.target.closest('button[data-v]'); if (!b) return;
    applyTheme(b.dataset.v); save();
    $$('#setTheme button').forEach((x) => x.classList.toggle('on', x === b));
  };
  $('#btnSyncNow').onclick = () => { closeSheet(); sync(true); };
  $('#btnReload').onclick = () => askSheet('Alles neu laden?',
    'Der gesamte Verlauf wird noch einmal von Garmin geholt. Die vorhandenen Daten bleiben, bis sie ersetzt sind.',
    'Neu laden', () => {
      db.sync.to = null; db.sync.from = null; db.sync.floor = null; db.sync.empty = 0; db.profile.fetched = null;
      db.sync.gaps = {}; db.sync.warn = {};      // der ganze Verlauf kommt ohnehin neu
      save(); closeSheet(); sync(true);
    }, openSettings);
  $('#btnExport').onclick = exportBackup;
  $('#btnImport').onclick = () => $('#fileImport').click();
  $('#fileImport').onchange = (e) => importBackup(e.target.files[0]);
  $('#btnUpdate').onclick = checkUpdate;
  $('#btnInstall').onclick = installApp;
  syncInstall();
  if (key) $('#btnKeyDel').onclick = () => askSheet('Schlüssel entfernen?',
    'Ohne Schlüssel gibt es keinen Abgleich mehr. Die geladenen Daten bleiben.', 'Entfernen',
    () => { keySet(''); openSettings(); toast('Schlüssel entfernt'); }, openSettings, true);
  $('#btnWipe').onclick = () => askSheet('Alle Daten löschen?',
    'Tageswerte, Aktivitäten und zwischengespeicherte Kurven werden von diesem Gerät gelöscht. Proxy-Adresse und Schlüssel bleiben. Bei Garmin bleibt alles erhalten.',
    'Löschen', async () => {
      const keep = { settings: db.settings, theme: db.theme };
      db = normalize(Object.assign(blank(), keep));
      save(); reindex(); await idbClear(); streamCache.clear();
      closeSheet(); dayView = null; render(); toast('Gelöscht');
    }, openSettings, true);
}

/** Proxy und Schlüssel übernehmen, dann in drei Schritten prüfen: Proxy
    erreichbar und für diese Adresse freigegeben? Schlüssel gültig? Daten
    lesbar? Jeder Schritt meldet seinen eigenen Fehler. */
async function saveAndTest() {
  const out = $('#testOut');
  let proxy = $('#setProxy').value.trim();
  if (proxy && !/^https?:\/\//i.test(proxy)) proxy = 'https://' + proxy;
  db.settings.proxy = proxy.replace(/\/+$/, '');
  const k = $('#setKey').value.trim().replace(/^ApiKey\s+/i, '');
  if (k) keySet(k);
  save();
  $('#setProxy').value = db.settings.proxy;
  $('#setKey').value = '';
  if (keyGet()) $('#setKey').placeholder = 'gespeichert — zum Ändern neu einfügen';
  const show = (cls, title, text) => {
    out.innerHTML = `<div class="hint ${cls}">${cls === 'err' ? ICON.warn : cls === 'warn' ? ICON.warn : ICON.check}<div class="grow"><strong>${esc(title)}</strong>${text ? `<span>${esc(text)}</span>` : ''}</div></div>`;
  };
  if (!db.settings.proxy) { show('warn', 'Proxy-Adresse fehlt', 'Ohne Proxy kommt die App nicht an Garmin heran.'); return; }
  out.innerHTML = '<div class="loading"><span class="spinner"></span><span>Proxy wird geprüft …</span></div>';
  try {
    const res = await rawFetch(proxyBase() + '/ping', { headers: { Accept: 'application/json' } }, 15000);
    let j = null;
    try { j = await res.json(); } catch (e) { /* unten */ }
    if (!j || !j.proxy) { show('err', 'Unter dieser Adresse antwortet kein Garmin-Proxy', 'Ist der Code aus der Anleitung eingefügt und bereitgestellt?'); return; }
    if (!res.ok) { show('err', 'Proxy lehnt diese App ab', j.message); return; }
  } catch (e) { show('err', 'Proxy nicht erreichbar', e.message); return; }
  if (!keyGet()) { show('warn', 'Proxy läuft', 'Jetzt noch den API-Schlüssel eintragen.'); return; }
  out.innerHTML = '<div class="loading"><span class="spinner"></span><span>Schlüssel wird geprüft …</span></div>';
  try {
    await ensureToken(true);
    await api('/biometric-service/heartRateZones/v2');
  } catch (e) { show('err', 'Garmin-Anmeldung fehlgeschlagen', e.message); return; }
  show('ok', 'Verbunden', db.setup ? 'Alles bereit.' : 'Der erste Abgleich startet jetzt.');
  db.sync.error = null; save(); renderTopSub();
  if (!syncing) setTimeout(() => { if (!syncing) { if (!db.setup) closeSheet(); sync(!db.setup); } }, 900);
}

/** Anleitung für den Cloudflare Worker, mit dem fertigen Code zum Kopieren.
    Die Adresse dieser App wird beim Kopieren in ALLOWED_ORIGINS eingesetzt. */
function openProxyGuide() {
  const origin = location.origin;
  openSheet('Proxy einrichten', `
    <p class="dlg-t">Garmin lässt keine Web-App direkt an die Daten. Ein Cloudflare Worker reicht die Anfragen nur weiter — er speichert nichts und kennt Deinen Schlüssel nicht. Kostenlos (bis 100 000 Anfragen am Tag; die App braucht ein paar Dutzend).</p>
    <ol class="steps">
      <li><strong>Konto anlegen</strong> auf <a href="${CF_PAGE}" target="_blank" rel="noopener">dash.cloudflare.com</a> (kostenlos, ohne Kreditkarte). Am PC geht der Rest bequemer.</li>
      <li><strong>Worker erstellen:</strong> links <em>Workers &amp; Pages</em> → <em>Create application</em> (Anwendung erstellen) → Vorlage <em>Hello World</em>. Namen wählen, z. B. <code>garmin-proxy</code>, dann <em>Deploy</em> (Bereitstellen).</li>
      <li><strong>Code einsetzen:</strong> <em>Edit code</em> (Code bearbeiten), alles löschen, den Proxy-Code einfügen, wieder <em>Deploy</em>.
        <div class="btn-row"><button class="btn btn-sm" id="btnCopyProxy">Proxy-Code kopieren</button><button class="btn btn-sm" id="btnSaveProxy">Als Datei</button></div>
        <span class="field-note">Freigegeben ist darin diese App: <code>${esc(origin)}</code></span></li>
      <li><strong>Adresse eintragen:</strong> Cloudflare zeigt oben die Adresse des Workers, etwa <code>https://garmin-proxy.name.workers.dev</code>. Die kommt in den Einstellungen unter <em>Proxy-Adresse</em>.</li>
    </ol>
    <button class="btn btn-primary btn-block" id="btnGuideDone">Zu den Einstellungen</button>
  `, null);
  $('#sheetCancel').onclick = openSettings;
  $('#btnGuideDone').onclick = openSettings;
  $('#btnCopyProxy').onclick = async () => {
    try {
      const code = await proxyCode();
      await navigator.clipboard.writeText(code);
      toast('Proxy-Code kopiert');
    } catch (e) { toast('Kopieren ging nicht — „Als Datei" nehmen'); }
  };
  $('#btnSaveProxy').onclick = async () => {
    try { download(await proxyCode(), 'garmin-proxy.js', 'text/javascript'); } catch (e) { toast('Proxy-Code nicht gefunden'); }
  };
}
async function proxyCode() {
  const res = await fetch('proxy/worker.js');
  if (!res.ok) throw new Error('fehlt');
  const code = await res.text();
  const list = Array.from(new Set(['https://kili07.github.io', location.origin])).filter((o) => /^https?:\/\//.test(o));
  return code.replace(/const ALLOWED_ORIGINS = \[[^\]]*\];/, `const ALLOWED_ORIGINS = ${JSON.stringify(list)};`);
}
function download(text, name, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ── Backup ─────────────────────────────────────────────────── */

function exportBackup() {
  db.lastBackup = new Date().toISOString();
  save();
  /* Der gesamte Datensatz wandert unverändert in die Datei. `meta` steht nur
     als Kopfzeile davor und wird beim Import wieder entfernt (siehe
     normalize). Schlüssel und Token liegen woanders und kommen nicht mit. */
  const payload = Object.assign({
    meta: { app: 'Garmin-Übersicht', appVersion: APP_VERSION, format: db.v, exported: db.lastBackup },
  }, db);
  download(JSON.stringify(payload), `garmin-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
  toast('Backup gespeichert');
}

function importBackup(file) {
  if (!file) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const d = JSON.parse(r.result);
      if (!d || typeof d.days !== 'object' || !Array.isArray(d.acts)) throw new Error('Die Datei ist kein Backup dieser App.');
      const stand = d.meta && d.meta.exported ? ` vom ${dfLong.format(new Date(d.meta.exported))}` : '';
      askSheet('Backup laden',
        `Das Backup${stand} enthält ${Object.keys(d.days).length} Tage und ${d.acts.length} Aktivitäten. `
        + 'Die jetzigen Daten auf diesem Gerät werden dabei ersetzt. Der Schlüssel bleibt.',
        'Laden', () => {
          // normalize() ergänzt, was in einem älteren Backup fehlt, und wirft die Kopfzeile `meta` weg
          db = normalize(d);
          applyTheme(db.theme);
          save(); reindex(); closeSheet(); render(); toast('Backup geladen');
        }, openSettings);
    } catch (e) { infoSheet('Import fehlgeschlagen', e.message, openSettings); }
  };
  r.readAsText(file);
}

/* ── 12. Sheet und Dialoge ──────────────────────────────────── */

let sheetSaveFn = null;

function openSheet(title, html, saveFn, saveLabel) {
  armBack();                              // Zurück soll das Sheet schließen, nicht die App
  for (const k of readers.keys()) if (k[0] === 's') readers.delete(k);
  $('#sheetTitle').textContent = title;
  $('#sheetBody').innerHTML = html;
  $('#sheetBody').onclick = null;         // Handler des vorherigen Sheets verwerfen
  $('#sheetCancel').onclick = closeSheet; // ggf. überschriebenes Abbrechen zurücksetzen
  $('#sheetCancel').textContent = saveFn ? 'Abbrechen' : 'Schließen';
  sheetSaveFn = saveFn || null;
  const btn = $('#sheetSave');
  btn.classList.toggle('hidden', !saveFn);
  btn.textContent = saveLabel || 'Sichern';
  $('#sheet').classList.remove('hidden');
  $('#scrim').classList.remove('hidden');
  $('#sheetBody').scrollTop = 0;
  document.body.style.overflow = 'hidden';
}

function closeSheet() {
  $('#sheet').classList.add('hidden');
  $('#scrim').classList.add('hidden');
  sheetSaveFn = null;
  document.body.style.overflow = '';
}

/* Ersatz für confirm() / prompt() / alert(): installierte Web-Apps
   unterdrücken die nativen Dialoge je nach Gerät kommentarlos — der Knopf
   tut dann scheinbar nichts. Diese hier sind normale Sheets und
   funktionieren überall gleich. `back` führt zurück zum vorherigen Sheet. */
function askSheet(title, text, okLabel, onOk, back, danger) {
  openSheet(title, `
    <p class="dlg-t">${esc(text)}</p>
    <button class="btn ${danger ? 'btn-danger' : 'btn-primary'} btn-block" id="dlgOk">${esc(okLabel)}</button>
    <button class="btn btn-block" id="dlgNo" style="margin-top:8px">Abbrechen</button>
  `, null);
  const zurueck = () => (back ? back() : closeSheet());
  $('#dlgOk').onclick = onOk;
  $('#dlgNo').onclick = zurueck;
  $('#sheetCancel').onclick = zurueck;
}

function infoSheet(title, text, back) {
  openSheet(title, `
    <p class="dlg-t">${esc(text)}</p>
    <button class="btn btn-primary btn-block" id="dlgOk">Verstanden</button>
  `, null);
  const zurueck = () => (back ? back() : closeSheet());
  $('#dlgOk').onclick = zurueck;
  $('#sheetCancel').onclick = zurueck;
}

/* ── Zurück-Taste ───────────────────────────────────────────────
   Ohne Zutun beendet ein einziger Druck auf Zurück die installierte App —
   viel zu leicht aus Versehen. Deshalb liegt ein zusätzlicher Verlaufseintrag
   („Wächter") über der App: Zurück landet dann bei uns statt beim System.

   Der Druck schließt der Reihe nach, was offen ist — Sheet, anderer Tag,
   andere Ansicht — und baut den Wächter danach wieder auf. Steht nichts mehr
   offen und Du bist auf „Heute", fragt ein Dialog nach. */
let guardUp = false;
let leaving = false;

function pushGuard() {
  if (guardUp) return;
  guardUp = true;
  try { history.pushState({ g: 1 }, ''); } catch (e) { guardUp = false; }
}

/** Vor allem, was die Zurück-Taste abfangen soll: Sheet öffnen, Seite wechseln. */
function armBack() { pushGuard(); }

/** „Verlassen" im Abschiedsdialog: der Dialog hat selbst einen Wächter
    aufgebaut (jedes Sheet tut das). Erst ihn abräumen, dann führt der zweite
    Schritt aus der App. Beides muss über zwei Runden laufen — history.back()
    zweimal hintereinander fasst der Browser zu einem Schritt zusammen. */
function leaveApp() {
  closeSheet();
  leaving = true;
  history.back();
}

function wireBack() {
  pushGuard();
  window.addEventListener('popstate', () => {
    guardUp = false;

    if (leaving) {
      leaving = false;
      history.back();
      // Falls nichts mehr zum Zurückgehen da ist (im Browser-Tab, in dem die App
      // der erste Eintrag ist), bleiben wir hier — dann fehlt der Wächter. Kein
      // Timer zum Nachrüsten: ein pushState würde den laufenden Schritt abbrechen
      // und genau das Verlassen verhindern. Also erst beim nächsten Antippen.
      document.addEventListener('pointerdown', pushGuard, { once: true });
      return;
    }
    // Über den Abbrechen-Knopf, nicht über closeSheet: verschachtelte Sheets
    // haben dort ihren Rückweg zum vorherigen Sheet hinterlegt.
    if (!$('#sheet').classList.contains('hidden')) { $('#sheetCancel').click(); pushGuard(); return; }
    if (view === 'today' && dayView) { dayView = null; render(); pushGuard(); return; }
    if (view !== 'today') { nav('today'); pushGuard(); return; }

    askSheet('App verlassen?', 'Möchtest Du die App wirklich schließen?',
      'Verlassen', leaveApp);
  });
}

/* ── Updates ────────────────────────────────────────────────── */

/** Welche APP_VERSION liegt im Offline-Cache? Das ist die Fassung, die beim
    nächsten Laden ausgeliefert wird — nicht zwingend die laufende. */
async function cachedVersion() {
  if (!('caches' in window)) return null;
  for (const k of await caches.keys()) {
    if (!k.startsWith('garmin-')) continue;
    const c = await caches.open(k);
    const res = (await c.match('./app.js')) || (await c.match('app.js'));
    if (!res) continue;
    const m = (await res.text()).match(/APP_VERSION\s*=\s*'([^']+)'/);
    if (m) return m[1];
  }
  return null;
}

/** Lädt neu, wenn im Cache eine andere Fassung liegt als die laufende. Die
    Sperre in sessionStorage verhindert eine Endlosschleife, falls das
    Neuladen die Version wider Erwarten nicht ändert. */
let reloading = false;
async function applyIfNewer(announce) {
  if (reloading) return false;
  const cv = await cachedVersion();
  if (!cv || cv === APP_VERSION) return false;
  try { if (sessionStorage.getItem('garmin-reload') === cv) return false; } catch (e) { /* egal */ }
  // Formular offen oder Abgleich läuft: nicht mittendrin neu laden
  if (!$('#sheet').classList.contains('hidden') || syncing) {
    toast(`Version ${cv} bereit — App neu starten`);
    return true;
  }
  reloading = true;
  try { sessionStorage.setItem('garmin-reload', cv); } catch (e) { /* egal */ }
  if (announce) toast(`Version ${cv} wird geladen …`);
  setTimeout(() => location.reload(), announce ? 700 : 0);
  return true;
}

let swReg = null;
function wireUpdates() {
  if (!('serviceWorker' in navigator)) return;

  /* Auf 'controllerchange' ist kein Verlass: aktualisiert sich dieselbe
     Registrierung, gilt die Seite nicht als "neu kontrolliert" und das
     Ereignis bleibt aus. Verlässlich ist der Zustandswechsel des neuen
     Workers auf 'activated' — dann liegt der frische Cache bereit. */
  const watch = (w) => {
    if (!w) return;
    if (w.state === 'activated') { applyIfNewer(false); return; }
    w.addEventListener('statechange', () => {
      if (w.state === 'activated') applyIfNewer(false);
    });
  };

  navigator.serviceWorker.addEventListener('controllerchange', () => applyIfNewer(false));

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      swReg = reg;
      watch(reg.installing); watch(reg.waiting);
      reg.addEventListener('updatefound', () => watch(reg.installing));
      navigator.serviceWorker.ready.then(() => applyIfNewer(false));
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
    }).catch(() => {});
  });
}

async function checkUpdate() {
  if (!swReg) { toast('Offline-Funktion nicht aktiv'); return; }
  toast('Suche nach Update …');
  try { await swReg.update(); } catch (e) { toast('Keine Verbindung'); return; }
  setTimeout(async () => {
    if (!(await applyIfNewer(true))) toast(`Version ${APP_VERSION} ist aktuell`);
  }, 2500);
}

/* ── Installieren ───────────────────────────────────────────────
   Eigener Knopf statt Chrome-Menü: Chrome 154–157 meldet dort „bereits
   installiert", sobald irgendeine andere App auf derselben Domain installiert
   ist (crbug.com/568841400, behoben ab Chrome 158). beforeinstallprompt prüft
   pro App und ist nicht betroffen. Chrome schickt das Ereignis nur, solange
   die App wirklich installierbar ist. In der installierten App und nach der
   Installation bleibt es aus, der Knopf verschwindet also von selbst. */
let installEvt = null;

/** Knopf ein- oder ausblenden. Das Ereignis kommt oft erst ein paar Sekunden
    nach dem Laden, unter Umständen bei schon offenen Einstellungen. */
function syncInstall() {
  const b = $('#btnInstall');
  if (b) b.classList.toggle('hidden', !installEvt);
}

function wireInstall() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();             // keine eigene Leiste von Chrome, der Knopf reicht
    installEvt = e;
    syncInstall();
  });
  window.addEventListener('appinstalled', () => {
    installEvt = null;
    syncInstall();
    toast('Garmin-Übersicht ist installiert');
  });
}

async function installApp() {
  const e = installEvt;
  if (!e) return;
  installEvt = null;                // prompt() geht nur einmal pro Ereignis
  syncInstall();
  e.prompt();
  await e.userChoice.catch(() => {});
}

/* ── Start ──────────────────────────────────────────────────── */

function wire() {
  document.body.addEventListener('click', (e) => {
    const n = e.target.closest('[data-nav]');
    if (n) { nav(n.dataset.nav); return; }
    const tr = e.target.closest('[data-trend]');
    if (tr) { trendKey = tr.dataset.trend; nav('trends'); return; }
    const ac = e.target.closest('[data-act]');
    if (ac) { openActivity(ac.dataset.act); return; }
    const ng = e.target.closest('[data-night]');
    if (ng) { openNight(ng.dataset.night); return; }
    const dy = e.target.closest('[data-day]');
    if (dy) { dayView = dy.dataset.day === Core.today() ? null : dy.dataset.day; renderToday(); armBack(); return; }
    const ds = e.target.closest('[data-daystep]');
    if (ds) {
      const cur = dayView || Core.today();
      const nd = Core.addDays(cur, +ds.dataset.daystep);
      dayView = nd >= Core.today() ? null : nd;
      renderToday(); armBack(); return;
    }
    const st = e.target.closest('[data-set]');
    if (st) {
      const [k, v] = st.dataset.set.split(':');
      const num = /^\d+$/.test(v) ? +v : v;
      if (k === 'trendKey') trendKey = v;
      else if (k === 'trendRange') trendRange = num;
      else if (k === 'trainPeriod') trainPeriod = v;
      else if (k === 'trainSport') { trainSport = v; trainShow = 30; }
      else if (k === 'bestScope') bestScope = v;
      else if (k === 'patRange') patRange = num;
      render(); return;
    }
    const sc = e.target.closest('[data-scatter]');
    if (sc) { const id = sc.dataset.scatter; if (openScatter.has(id)) openScatter.delete(id); else openScatter.add(id); render(); return; }
    const a = e.target.closest('[data-action]');
    if (a) {
      const act = a.dataset.action;
      if (act === 'sync') sync(true);
      else if (act === 'settings') openSettings();
      else if (act === 'proxyGuide') openProxyGuide();
      else if (act === 'more') { trainShow += 30; render(); }
    }
  });
  document.addEventListener('pointerdown', onChartPointer);
  document.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'mouse') onChartPointer(e); });
  $('#btnSync').onclick = () => sync(true);
  $('#btnSettings').onclick = openSettings;
  $('#sheetCancel').onclick = closeSheet;
  $('#scrim').onclick = () => $('#sheetCancel').click();
  $('#sheetSave').onclick = () => sheetSaveFn && sheetSaveFn();

  // Zurück in die App nach längerer Pause: abgleichen und „Heute" auf den neuen Tag ziehen
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    // Über Mitternacht offen geblieben: neu zeichnen, auch wenn kein Abgleich fällig ist
    if (renderedDay !== Core.today()) render(); else renderTopSub();
    maybeAutoSync();
  });
  window.addEventListener('online', maybeAutoSync);
  // Feuert auch beim Neuladen — ein Zeitpunkt deckt alle Zustandswechsel ab
  window.addEventListener('pagehide', saveViewState);
}

load();
applyTheme(db.theme);
reindex();
wire();
wireBack();
nav(restoreViewState());

/* Bittet den Browser, den Speicher nicht bei Platzmangel wegzuräumen. */
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

wireUpdates();
wireInstall();
maybeAutoSync();
