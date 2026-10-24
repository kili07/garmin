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
const APP_VERSION = '2.3.0';

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
   muss mit --bg in tokens.css übereinstimmen. */
const THEMES = {
  dark: { label: 'Dunkel', bar: '#0E1116' },
  light: { label: 'Hell', bar: '#F4F6F8' },
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
    born: null,         // Jahrgang — nur für die VO2max-Tabelle im Fitness-Score
    sex: '',            // 'm', 'f' oder '' (offen), ebenso
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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !d.days[k] || typeof d.days[k] !== 'object') { delete d.days[k]; continue; }
    // Von Hand eingetragen (setCoffee): Minuten seit Mitternacht bzw. „kein Kaffee"
    const x = d.days[k];
    if ('coffee' in x && !(Number.isInteger(x.coffee) && x.coffee >= 0 && x.coffee < 1440)) delete x.coffee;
    if ('noCoffee' in x && (x.noCoffee !== 1 || 'coffee' in x)) delete x.noCoffee;
    // Von Dir als Schlaf markierte Wachstrecken (toggleWake) und Garmins Werte dazu (Sleep.applyFix)
    if ('wfx' in x) {
      x.wfx = (Array.isArray(x.wfx) ? x.wfx : []).filter((w) => Array.isArray(w) && Number.isInteger(w[0]) && Number.isInteger(w[1])
        && w[0] >= 0 && w[1] > w[0] && w[1] <= 1440).map((w) => [w[0], w[1], w[2] ? 1 : 0]);
      if (!x.wfx.length) delete x.wfx;
    }
    if ('gx' in x) {
      if (!x.gx || typeof x.gx !== 'object' || Array.isArray(x.gx)) delete x.gx;
      else for (const k of Object.keys(x.gx)) if (!Sleep.FIX_KEYS.includes(k)) delete x.gx[k];
      // Markierung weg, Korrektur noch da: Garmins Werte zurück
      if (x.gx && !x.wfx) Sleep.applyFix(x, null);
    }
    if (!Object.keys(x).length) delete d.days[k];
  }
  d.acts = Array.isArray(d.acts) ? d.acts.filter((a) => a && a.id != null && typeof a.date === 'string') : [];
  d.acts.forEach((a) => { if (typeof a.start !== 'string') a.start = a.date + ' 00:00'; if (!a.type) a.type = 'other'; });
  if (![365, 730, 1825].includes(+d.settings.history)) d.settings.history = 365;
  d.settings.proxy = String(d.settings.proxy || '');
  const born = Math.round(+d.settings.born);
  d.settings.born = born >= 1900 && born <= new Date().getFullYear() - 10 ? born : null;
  if (!['m', 'f'].includes(d.settings.sex)) d.settings.sex = '';
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
const dfShort = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'short' });
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

/** Zahl, die beim ersten Zeichnen hochzählt (siehe runAnims). Im HTML steht
    der fertige Text; `to` ist die Zahl dahinter, bei fmt 'hm' in Minuten. */
const countSpan = (text, to, dec, fmt) => (fin(to)
  ? `<span data-count="${to}"${dec ? ' data-dec="1"' : ''}${fmt ? ` data-fmt="${fmt}"` : ''}>${esc(text)}</span>` : esc(text));

/** Wie valHtml, aber die Zahl zählt hoch — nur wenn sie sich wieder genau so
    schreiben lässt (ganze Zahl, eine Nachkommastelle oder Stunden:Minuten).
    Uhrzeiten und Zählwerte bleiben stehen. */
function numHtml(key, v) {
  const [a, u] = splitVal(key, v);
  const unit = u ? `<small>${esc(u)}</small>` : '';
  if (!fin(v)) return esc(a) + unit;
  const m = M[key] || {};
  if (m.fmt === 'dur' || m.fmt === 'min') {
    const mins = Math.round(m.fmt === 'dur' ? v / 60 : v);
    if (mins >= 60 && a === `${Math.floor(mins / 60)}:${pad2(mins % 60)}`) return countSpan(a, mins, 0, 'hm') + unit;
    if (mins >= 0 && a === String(mins)) return countSpan(a, mins) + unit;
    return esc(a) + unit;
  }
  if (a === nf0.format(v)) return countSpan(a, Math.round(v)) + unit;
  if (a === nf1.format(v)) return countSpan(a, Math.round(v * 10) / 10, 1) + unit;
  return esc(a) + unit;
}

/* ── Bewegung ───────────────────────────────────────────────────
   Zahlen zählen hoch, Gauges und Balken füllen sich, in 600 ms mit
   ease-out (dieselbe Kurve wie --ease-out in tokens.css). Nur nach einem
   Wechsel durch Dich — Tab, Tag, Auswahl —, nicht wenn der Abgleich
   zwischendurch neu zeichnet. Im HTML steht immer der Endwert: Läuft
   nichts (reduzierte Bewegung, Seite im Hintergrund), stimmt die Anzeige
   trotzdem. */
let animNext = true;
const ANIM_MS = 600;
const reduceMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

function runAnims(root) {
  if (!root || reduceMotion() || document.hidden) return;
  root.classList.add('anim');
  setTimeout(() => root.classList.remove('anim'), ANIM_MS + 100);
  $$('.gauge-fill, .meter > i', root).forEach((e) => e.classList.add('anim'));
  const items = $$('[data-count]', root).map((e) => ({ e, end: e.textContent, to: +e.dataset.count, dec: !!e.dataset.dec, hm: e.dataset.fmt === 'hm' }));
  if (!items.length) return;
  const show = (it, v) => {
    it.e.textContent = it.hm ? `${Math.floor(v / 60)}:${pad2(Math.floor(v % 60))}` : (it.dec ? nf1 : nf0).format(v);
  };
  let done = false;
  const finish = () => { if (!done) { done = true; items.forEach((it) => { it.e.textContent = it.end; }); } };
  const t0 = performance.now();
  const step = (now) => {
    if (done) return;
    const p = Math.min(1, (now - t0) / ANIM_MS);
    if (p >= 1) { finish(); return; }
    const k = 1 - Math.pow(1 - p, 3);
    items.forEach((it) => show(it, it.to * k));
    requestAnimationFrame(step);
  };
  items.forEach((it) => show(it, 0));
  requestAnimationFrame(step);
  // Falls requestAnimationFrame nicht kommt (Tab im Hintergrund): Endwerte trotzdem setzen
  setTimeout(finish, ANIM_MS + 250);
}

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

/* Icons: Lucide (ISC-Lizenz, licenses/lucide-ISC.txt), Pfade unverändert
   aus dem Paket lucide-static. Ein Laufsymbol hat Lucide nicht, Laufen
   bekommt deshalb die Fußspuren. */
const lucide = (paths, cls) => `<svg${cls ? ` class="${cls}"` : ''} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICON = {
  info: lucide('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'),
  warn: lucide('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
  check: lucide('<path d="M20 6 9 17l-5-5"/>'),
  chev: lucide('<path d="m9 18 6-6-6-6"/>', 'chev'),
  left: lucide('<path d="m15 18-6-6 6-6"/>'),
  right: lucide('<path d="m9 18 6-6-6-6"/>'),
  up: lucide('<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>'),
  down: lucide('<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>'),
  heart: lucide('<path d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"/><path d="M3.22 13H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27"/>'),
  watch: lucide('<path d="M12 10v2.2l1.6 1"/><path d="m16.13 7.66-.81-4.05a2 2 0 0 0-2-1.61h-2.68a2 2 0 0 0-2 1.61l-.78 4.05"/><path d="m7.88 16.36.8 4a2 2 0 0 0 2 1.61h2.72a2 2 0 0 0 2-1.61l.81-4.05"/><circle cx="12" cy="12" r="6"/>'),
  moon: lucide('<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/>'),
  coffee: lucide('<path d="M10 2v2"/><path d="M14 2v2"/><path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1"/><path d="M6 2v2"/>'),
};
const SPORT_ICON = {
  run: '<path d="M4 16v-2.38C4 11.5 2.97 10.5 3 8c.03-2.72 1.49-6 4.5-6C9.37 2 10 3.8 10 5.5c0 3.11-2 5.66-2 8.68V16a2 2 0 1 1-4 0Z"/><path d="M20 20v-2.38c0-2.12 1.03-3.12 1-5.62-.03-2.72-1.49-6-4.5-6C14.63 6 14 7.8 14 9.5c0 3.11 2 5.66 2 8.68V20a2 2 0 1 0 4 0Z"/><path d="M16 17h4"/><path d="M4 13h4"/>',
  bike: '<circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/>',
  swim: '<path d="M2 12q2.5 2 5 0t5 0 5 0 5 0"/><path d="M2 19q2.5 2 5 0t5 0 5 0 5 0"/><path d="M2 5q2.5 2 5 0t5 0 5 0 5 0"/>',
  walk: '<path d="m8 3 4 8 5-5 5 15H2L8 3z"/>',
  strength: '<path d="M17.596 12.768a2 2 0 1 0 2.829-2.829l-1.768-1.767a2 2 0 0 0 2.828-2.829l-2.828-2.828a2 2 0 0 0-2.829 2.828l-1.767-1.768a2 2 0 1 0-2.829 2.829z"/><path d="m2.5 21.5 1.4-1.4"/><path d="m20.1 3.9 1.4-1.4"/><path d="M5.343 21.485a2 2 0 1 0 2.829-2.828l1.767 1.768a2 2 0 1 0 2.829-2.829l-6.364-6.364a2 2 0 1 0-2.829 2.829l1.768 1.767a2 2 0 0 0-2.828 2.829z"/><path d="m9.6 14.4 4.8-4.8"/>',
  winter: '<path d="m10 20-1.25-2.5L6 18"/><path d="M10 4 8.75 6.5 6 6"/><path d="m14 20 1.25-2.5L18 18"/><path d="m14 4 1.25 2.5L18 6"/><path d="m17 21-3-6h-4"/><path d="m17 3-3 6 1.5 3"/><path d="M2 12h6.5L10 9"/><path d="m20 10-1.5 2 1.5 2"/><path d="M22 12h-6.5L14 15"/><path d="m4 10 1.5 2L4 14"/><path d="m7 21 3-6-1.5-3"/><path d="m7 3 3 6h4"/>',
  other: '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
};
const sportIcon = (type) => {
  const sp = Core.sportOf(type);
  return `<span class="act-ic sp-${sp}">${lucide(SPORT_ICON[sp])}</span>`;
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
  // Frischer Schlaf von Garmin: Deine Korrektur der Nacht neu darauf rechnen
  const x = db.days[rec.date];
  if (id === 'sleep' && x && x.wfx) Sleep.applyFix(x, fixModel(), true);
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
  fixModelC = undefined;
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

    // Gleich nach dem Aktuellen: Die Nacht von heute früh soll schon ausgewertet sein, wenn man sie öffnet
    await analyzeNights();
    render();

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
let patTab = 'sleep';                 // Muster: 'sleep' (Schlafmuster) oder 'pairs' (Zusammenhänge)
let sleepTarget = 'awakeN';           // wonach der Steckbrief die Nächte drittelt (Sleep.TARGETS)
let pfAll = false;                    // Steckbrief: auch Größen ohne deutlichen Unterschied zeigen
let openScatter = new Set();

function saveViewState() {
  try {
    sessionStorage.setItem(VIEW_KEY, JSON.stringify({
      view, dayView, trendKey, trendRange, trainPeriod, trainSport, bestScope, patRange, patTab, sleepTarget,
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
  if (RANGES.some(([r]) => r === s.trendRange)) trendRange = s.trendRange;
  if (typeof s.trainPeriod === 'string') trainPeriod = s.trainPeriod;
  if (typeof s.trainSport === 'string') trainSport = s.trainSport;
  if (typeof s.bestScope === 'string') bestScope = s.bestScope;
  if (typeof s.patRange === 'number') patRange = s.patRange;
  if (s.patTab === 'sleep' || s.patTab === 'pairs') patTab = s.patTab;
  if (typeof s.sleepTarget === 'string') sleepTarget = s.sleepTarget;   // renderSleepPatterns prüft, ob es sie gibt
  return s.view;
}

function nav(v) {
  view = v;
  $$('.view').forEach((s) => s.classList.toggle('hidden', s.id !== 'view-' + v));
  $$('.tabbar button[data-nav]').forEach((b) => b.classList.toggle('on', b.dataset.nav === v));
  $('#viewTitle').textContent = TITLES[v] || '';
  window.scrollTo(0, 0);
  armBack();                    // Zurück soll auf „Heute" führen, nicht aus der App
  animNext = true;
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
  if (animNext) { animNext = false; runAnims($('#view-' + view)); }
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
  const oldest = db.sync.from || date;

  let h = `<div class="daynav">
    <button class="icon-btn" data-daystep="-1" aria-label="Tag davor"${date <= oldest ? ' disabled' : ''}>${ICON.left}</button>
    <strong>${esc(date === t ? dfDay.format(pdate(date)) : dayLabel(date) === 'Gestern' ? 'Gestern · ' + dfDay.format(pdate(date)) : dayLabel(date))}</strong>
    <button class="icon-btn" data-daystep="1" aria-label="Tag danach"${date >= t ? ' disabled' : ''}>${ICON.right}</button>
  </div>`;

  if (db.sync.error && date === t) {
    h += `<div class="hint err top">${ICON.warn}<div class="grow"><strong>Abgleich fehlgeschlagen</strong><span>${esc(db.sync.error)}</span></div></div>`;
  }

  h += heroHtml(date, d);
  h += coffeeCard(date);
  h += verdictHtml(rd);
  h += fitnessCard(date);

  // Metrik-Karten: Wert, Veränderung zum Vortag, die letzten sieben Tage
  const recentDays = Core.dateRange(Core.addDays(date, -13), date).map((x) => db.days[x] || {});
  const keys = ['hrv', 'rhr', 'bbMax', 'stress', 'steps', 'im', 'load', 'vo2', 'weight', 'slpResp', 'spo2'].filter((k) => {
    if (k === 'load') return db.acts.length > 0;
    if (k === 'im') return recentDays.some((x) => x.imMod != null || x.imVig != null);
    if (M[k].sparse) return Core.series(db, idx, k, Core.addDays(date, -sparseDays(k)), date).some(fin);
    return Core.series(db, idx, k, Core.addDays(date, -13), date).some(fin);
  });
  if (keys.length) {
    h += `<div class="sec-h">Kennzahlen<span class="muted">Veränderung zum Vortag · letzte 7 Tage</span></div>
      <div class="grid2">${keys.map((k, i) => tile(k, date, keys.length % 2 === 1 && i === keys.length - 1)).join('')}</div>`;
  }

  h += weekTable(date);

  const recent = db.acts.filter((a) => !a.parent && a.date <= date).slice(0, 3);
  if (recent.length) {
    h += `<div class="sec-h">Letzte Aktivitäten<button class="link" data-nav="training">Alle</button></div>
      <div class="rows">${recent.map(actRow).join('')}</div>`;
  }
  if (date !== t) h += `<div class="btn-row" style="margin-top:var(--s3)"><button class="btn" data-day="${t}">Zurück zu heute</button></div>`;
  el.innerHTML = h;
}

/** Hero: der Schlafscore der Nacht vor diesem Tag, groß im Halbkreis. Die
    Farbe folgt Garmins Wort zur Nacht (gut, mittel, schwach). Darunter
    Dauer gegen Bedarf, Einschlafzeit und Puls im Schlaf, jeweils mit
    Deinem Schnitt, und die Phasen als Streifen. Antippen öffnet die Nacht. */
/** Zustand und Wort zum Schlafscore einer Nacht: Garmins Einordnung
    (ausgezeichnet, gut, mittel, schwach), sonst nach dem Score selbst. */
function sleepQual(d) {
  const sc = d.slpScore;
  const q = { EXCELLENT: 'E', GOOD: 'G', FAIR: 'F', POOR: 'P' }[d.slpQ];
  const st = q ? Q_ST[q] : fin(sc) ? (sc >= 80 ? 'good' : sc >= 60 ? 'warn' : 'bad') : 'off';
  const w = qualLabel(d.slpQ);
  return { st, word: w ? w[0].toUpperCase() + w.slice(1) : '' };
}

function heroHtml(date, d) {
  const sc = d.slpScore;
  const { st, word: qw } = sleepQual(d);
  const has = fin(d.slp);
  const span = fin(d.bed) && fin(d.wake) ? `${Core.fmtClock(d.bed)} – ${Core.fmtClock(d.wake)}` : '';
  let h = `<${has ? `button class="card hero" data-night="${date}"` : 'div class="card hero"'}>
    <div class="head"><span class="lbl">Schlafscore</span>${span ? `<span class="end">${esc(span)}</span>` : ''}${has ? ICON.chev : ''}</div>
    <div class="gauge-wrap">${Charts.gauge(sc, { st })}
      <div class="gauge-val"><span class="num${fin(sc) ? '' : ' na'}">${fin(sc) ? countSpan(nf0.format(sc), sc) : '–'}</span></div></div>
    <div class="gauge-ends"><span>0</span><span>100</span></div>`;
  if (fin(sc) && (qw || d.gx)) h += `<div class="hero-q">${qw ? `<span class="pill st-${st}">${esc(qw)}</span>` : ''}${fixPill(d)}</div>`;
  if (!has) return h + '<p class="hero-line">Für diese Nacht hat Garmin keinen Schlaf.</p></div>';
  if (!fin(sc)) h += '<p class="hero-line">Für diese Nacht gibt es keinen Score.</p>';

  // Kennwerte der Nacht, jeweils mit Deinem Schnitt der 30 Nächte davor
  const need = fin(d.need) ? d.need * 60 : null;
  const hrAvg = nightMean(date, (x) => x.slpHr);
  const awAvg = nightMean(date, (x) => x.awakeN);
  const cells = [['Dauer', numHtml('slp', d.slp), need ? `Bedarf ${Core.fmtDur(need)}` : '']];
  if (fin(d.slpHr)) cells.push(['Puls', `${countSpan(nf0.format(d.slpHr), Math.round(d.slpHr))}<small>bpm</small>`, hrAvg != null ? `Ø ${nf0.format(hrAvg)}` : '']);
  if (fin(d.awakeN)) cells.push(['Aufgewacht', `${countSpan(nf0.format(d.awakeN), d.awakeN)}<small>×</small>`, awAvg != null ? `Ø ${nf1.format(awAvg)}` : '']);
  h += `<div class="stats" style="grid-template-columns:repeat(${cells.length},minmax(0,1fr))">${cells.map(([l, v, sub]) => `<div><span class="lbl">${l}</span><span class="v">${v}</span>${sub ? `<span class="d">${esc(sub)}</span>` : ''}</div>`).join('')}</div>`;

  // Phasen als Streifen, darunter je Phase die Dauer (h:mm, damit die Spalten gleich lesen)
  const ph = [['deep', 'Tief'], ['light', 'Leicht'], ['rem', 'REM'], ['awake', 'Wach']].filter(([k]) => fin(d[k]) && d[k] > 0);
  const tot = ph.reduce((s, [k]) => s + d[k], 0) || 1;
  const hm = (sec) => { const m = Math.round(sec / 60); return `${Math.floor(m / 60)}:${pad2(m % 60)}`; };
  if (ph.length) {
    h += `<div class="phases">${ph.map(([k]) => `<i class="ph-${k}" style="flex:${(d[k] / tot).toFixed(4)} 1 0"></i>`).join('')}</div>
      <div class="ph-key">${ph.map(([k, l]) => `<div><span class="lbl"><i class="ph-${k}"></i>${l}</span><span class="num">${hm(d[k])}</span></div>`).join('')}</div>`;
  }
  return h + '</button>';
}

const ST_WORD = { good: 'besser als normal', ok: 'normal', warn: 'unter normal', bad: 'deutlich unter normal', off: 'ohne Urteil' };

/** Erholung: das Urteil aus den Signalen, jedes gegen Deinen Normalbereich —
    keine erfundene Gesamtzahl. Antippen eines Signals öffnet seinen Trend. */
function verdictHtml(rd) {
  const v = rd.verdict;
  let h = `<div class="card"><div class="head"><span class="lbl">Erholung</span>${rd.signals.length ? `<span class="end">${rd.signals.length} ${rd.signals.length === 1 ? 'Signal' : 'Signale'}</span>` : ''}</div>
    <div class="verdict-t"><i class="dot st-${v.status || 'off'}"></i>${esc(v.title)}</div>
    <p class="verdict-s">${esc(v.text)}</p>`;
  if (rd.signals.length) {
    h += `<div class="sigs">${rd.signals.map((s) => {
      let val;
      if (s.key === 'load') val = nf1.format(s.value) + '×';
      else if (s.valueKey === 'slp') val = Core.fmtDur(s.value);
      else val = Core.fmt(s.valueKey || s.key, s.value, true);
      return `<button class="sig" data-trend="${s.key}" aria-label="${esc(`${s.label} ${val}, ${ST_WORD[s.status || 'off']}`)}"><i class="dot st-${s.status || 'off'}"></i><span>${esc(s.label)}</span><b>${esc(val)}</b></button>`;
    }).join('')}</div>`;
  }
  return h + '</div>';
}

/* ── Kaffee ─────────────────────────────────────────────────── */
/* Garmin weiß nichts vom Kaffee, deshalb trägst Du ihn selbst ein: die
   Uhrzeit der letzten Tasse eines Tages oder „kein Kaffee". Er liegt in den
   Tageswerten (`coffee`, `noCoffee`), steht in keinem Core.FIELDS und
   übersteht deshalb jeden Abgleich; mit dem Datensatz kommt er ins Backup.
   Ausgewertet wird in Muster → Schlaf (Sleep.coffee). */

const hhmm = (m) => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
const nowMin = () => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); };

/** v: Minuten seit Mitternacht, 'none' für „kein Kaffee", null löscht. */
function setCoffee(date, v) {
  const x = db.days[date] || (db.days[date] = {});
  delete x.coffee; delete x.noCoffee;
  if (v === 'none') x.noCoffee = 1;
  else if (fin(v)) x.coffee = v;
  // Ohne Garmin-Werte bliebe sonst ein leerer Tag zurück
  if (!Object.keys(x).length) delete db.days[date];
  save();
}

function coffeeToast(date, v) {
  const day = date === Core.today() ? '' : ` (${dayLabel(date)})`;
  toast(v === 'none' ? `Kein Kaffee${day} eingetragen` : v == null ? 'Eintrag gelöscht' : `Letzter Kaffee ${Core.fmtClock(v)} Uhr${day}`);
}

/** Karte auf Heute: Uhrzeit des letzten Kaffees an diesem Tag. Heute mit
    „Jetzt" für einen Tipp pro Tasse — es zählt die letzte. */
function coffeeCard(date) {
  const t = Core.today(), x = db.days[date] || {};
  const n = db.days[Core.addDays(date, 1)] || {};
  const gap = fin(x.coffee) && fin(n.bed) && n.bed > x.coffee ? n.bed - x.coffee : null;
  let v, sub;
  if (fin(x.coffee)) {
    v = `<span class="num">${esc(Core.fmtClock(x.coffee))}</span><small>Uhr</small>`;
    sub = gap ? `${Core.fmtDur(gap * 60)} vor dem Einschlafen` : date === t ? 'Bei jeder Tasse „Jetzt“ tippen' : '';
  } else if (x.noCoffee) {
    v = 'Kein Kaffee'; sub = '';
  } else {
    v = '<span class="muted">Nicht eingetragen</span>';
    sub = date === t ? '„Jetzt“ trägt die Uhrzeit ein' : 'Antippen zum Nachtragen';
  }
  return `<div class="card cof">
    <button class="cof-main" data-coffee="${date}">
      <span class="cof-ic">${ICON.coffee}</span>
      <span class="grow"><span class="lbl">Letzter Kaffee</span><span class="cof-v">${v}</span>${sub ? `<span class="cof-s">${esc(sub)}</span>` : ''}</span>
      ${ICON.chev}
    </button>
    ${date === t ? '<button class="btn btn-sm" data-coffee-now>Jetzt</button>' : ''}
  </div>`;
}

/** Eintragen und Nachtragen: Uhrzeit für einen Tag, darunter die letzten
    sieben Tage zum Antippen. */
function openCoffee(date) {
  const t = Core.today(), x = db.days[date] || {};
  const has = fin(x.coffee) || !!x.noCoffee;
  const list = Core.dateRange(Core.addDays(t, -6), t).reverse();
  const shown = (d) => {
    const y = db.days[d] || {};
    return fin(y.coffee) ? Core.fmtClock(y.coffee) : y.noCoffee ? 'keiner' : '–';
  };
  const h = `<p class="note" style="margin:0 2px var(--s2)"><b>${esc(dayLabel(date))}:</b> Wann hast Du zuletzt Kaffee getrunken? Espresso, Cola, Energydrinks und schwarzer Tee zählen mit. Die App vergleicht damit die Nächte danach (Muster → Schlaf).</p>
    <label>Uhrzeit der letzten Tasse<input id="cofTime" type="time" value="${fin(x.coffee) ? hhmm(x.coffee) : ''}"></label>
    <div class="btn-row cof-btns">
      ${date === t ? '<button class="btn" id="cofNow">Jetzt</button>' : ''}
      <button class="btn${x.noCoffee ? ' on' : ''}" id="cofNone" aria-pressed="${x.noCoffee ? 'true' : 'false'}">Kein Kaffee</button>
      ${has ? '<button class="btn" id="cofDel">Löschen</button>' : ''}
    </div>
    <div class="sec-h">Letzte 7 Tage<span class="muted">antippen zum Nachtragen</span></div>
    <div class="rows">${list.map((d) => `<button class="row${d === date ? ' sel' : ''}" data-cofday="${d}"${d === date ? ' aria-current="true"' : ''}>
      <span class="grow"><span class="t">${esc(dayLabel(d))}</span></span><span class="end"><b class="num">${esc(shown(d))}</b></span>${ICON.chev}</button>`).join('')}</div>
    <div class="btn-row" style="margin-top:var(--s3)"><button class="btn" id="cofPat">Auswertung ansehen</button></div>`;

  const done = (v) => { setCoffee(date, v); closeSheet(); render(); coffeeToast(date, v); };
  openSheet('Letzter Kaffee', h, () => {
    const m = /^(\d{1,2}):(\d{2})/.exec($('#cofTime').value);
    if (!m) { toast('Bitte eine Uhrzeit eintragen'); return; }
    done(Math.min(1439, +m[1] * 60 + +m[2]));
  });
  if ($('#cofNow')) $('#cofNow').onclick = () => done(nowMin());
  $('#cofNone').onclick = () => done('none');
  if ($('#cofDel')) $('#cofDel').onclick = () => done(null);
  $('#cofPat').onclick = () => {
    closeSheet(); patTab = 'sleep'; nav('patterns');
    const s = $('#cofSec'); if (s) s.scrollIntoView();
  };
  $('#sheetBody').onclick = (e) => {
    const r = e.target.closest('[data-cofday]');
    if (r) openCoffee(r.dataset.cofday);
  };
}

/* ── 7a. Fitness-Score ──────────────────────────────────────── */
/* Gerechnet in Core.fitness: fünf Teile gegen feste Maßstäbe, Stand der
   vier Wochen vor dem Tag. Die Karte zeigt Score, Stufe und die Teile;
   antippen öffnet Verlauf, Werte und wie gerechnet wird. */

/** Alter und Geschlecht für die VO2max-Tabelle, soweit eingetragen. */
function fitMe(date) {
  const b = db.settings.born;
  return { age: b ? +date.slice(0, 4) - b : null, sex: db.settings.sex || '' };
}

/** Veränderung gegen den Score 28 Tage davor, wenn es ihn gab — sonst null. */
function fitDeltaN(date, f) {
  const old = Core.fitness(db, idx, Core.addDays(date, -28), fitMe(date));
  return old.score == null ? null : f.score - old.score;
}
/** „+4 in 4 Wochen" als Text (Fitness-Sheet). */
function fitDelta(date, f) {
  const dd = fitDeltaN(date, f);
  if (dd == null) return '';
  return dd ? `${dd > 0 ? '+' : '−'}${Math.abs(dd)} in 4 Wochen` : 'gleich wie vor 4 Wochen';
}
/** Dieselbe Veränderung als Pill: Pfeil und Zahl, Mint besser, Koralle schlechter. */
function fitPill(dd) {
  if (dd == null) return '';
  if (!dd) return '<span class="pill st-off">±0</span>';
  // Bis 2 Punkte ist es eher Schwankung als Veränderung
  return `<span class="pill st-${Math.abs(dd) < 3 ? 'off' : dd > 0 ? 'good' : 'bad'}" aria-label="${esc(`${dd > 0 ? '+' : '−'}${Math.abs(dd)} in 4 Wochen`)}">${dd > 0 ? ICON.up : ICON.down}${Math.abs(dd)}</span>`;
}
/** Die fünf Teile, je mit Wert und dünnem Balken. */
const partSt = (v) => (v >= 70 ? 'st-good' : v >= 40 ? 'st-warn' : 'st-bad');
const fitPartsHtml = (f) => `<div class="fit-parts">${f.parts.map((p) => `<div><span>${esc(p.label)}</span><b class="num">${nf0.format(p.score)}</b>
  <div class="meter"><i class="${partSt(p.score)}" style="width:${p.score}%"></i></div></div>`).join('')}</div>`;

function fitnessCard(date) {
  const f = Core.fitness(db, idx, date, fitMe(date));
  const head = `<div class="head"><span class="lbl">Fitness</span><span class="end">letzte 4 Wochen</span>${ICON.chev}</div>`;
  if (f.score == null) {
    return `<button class="card fit-card" data-fitness="${date}">${head}
      <p class="note">Für den Fitness-Score braucht es etwa drei Wochen Daten.</p></button>`;
  }
  const dd = fitDeltaN(date, f);
  return `<button class="card fit-card" data-fitness="${date}">${head}
    <div class="fit-top"><span class="num">${countSpan(nf0.format(f.score), f.score)}</span>
      <div class="grow"><div class="fit-t">${esc(f.label)}</div>${dd != null ? `<div class="fit-s">${fitPill(dd)}<span class="muted small"> in 4 Wochen</span></div>` : ''}</div></div>
    ${fitPartsHtml(f)}
  </button>`;
}

const FIT_MISSING = {
  vo2: 'Garmin schätzt sie bei Läufen und Radfahrten im Freien mit Puls (bei Rad mit Leistungsmesser). In den letzten 120 Tagen kam keine.',
  im: 'Es fehlen Intensitätsminuten von mindestens drei Wochen.',
  rhr: 'Es fehlt der Ruhepuls von mindestens zehn Tagen.',
  steps: 'Es fehlen Schritte von mindestens zwei Wochen.',
  days: 'Es fehlen Tageswerte von mindestens drei Wochen.',
};
const FIT_TREND = { vo2: null, im: 'im', rhr: 'rhr', steps: 'steps', days: 'trainMin' };

/** Was der Wert eines Teils bedeutet, in einem Satz. */
function fitPartText(p, me) {
  switch (p.key) {
    case 'vo2': {
      const who = me.sex === 'm' ? 'der Männer' : me.sex === 'f' ? 'der Frauen' : 'der Menschen';
      const age = fin(me.age) ? ` um ${Math.round(me.age / 5) * 5}` : '';
      return `VO2max ${nf0.format(p.value)} (${dayLabel(p.date)}), ${p.approx ? 'ungefähr' : 'etwa'} besser als ${nf0.format(p.score)} % ${who}${age}`;
    }
    case 'im': return `Ø ${nf0.format(p.value)} Intensitätsminuten pro Woche, die WHO empfiehlt 150–300`;
    case 'rhr': return `typisch ${nf0.format(p.value)} bpm (Median)`;
    case 'steps': return `typisch ${nf0.format(p.value)} Schritte am Tag (Median)`;
    case 'days': return `${nf1.format(p.value)} aktive Tage pro Woche: mindestens 20 min Training oder 30 Intensitätsminuten`;
  }
  return '';
}

function fitNextText(f) {
  const p = f.parts.find((x) => x.key === f.next);
  if (!p) return '';
  switch (p.key) {
    case 'vo2': return 'Am meisten bringt die Ausdauer. Die VO2max steigt am ehesten mit viel lockerem Umfang und ein, zwei harten Einheiten (Intervalle) pro Woche, über Wochen bis Monate.';
    case 'im': return p.value < 150
      ? `Am meisten bringen mehr Intensitätsminuten: Bis zu 150 pro Woche fehlen im Schnitt ${nf0.format(150 - p.value)}. Zügiges Gehen zählt schon, intensive Minuten doppelt.`
      : 'Am meisten bringen mehr Intensitätsminuten. 150 pro Woche sind erreicht, bis 300 steigt der Nutzen weiter.';
    case 'rhr': return 'Am meisten ist beim Ruhepuls zu holen. Er sinkt mit Ausdauertraining über Wochen; wenig Schlaf, Stress, Alkohol und Infekte treiben ihn kurzfristig hoch.';
    case 'steps': return `Am meisten bringen mehr Schritte im Alltag. Bis 7500 am Tag steigt der Nutzen am stärksten${p.value < 7500 ? `, Dir fehlen typischerweise ${nf0.format(7500 - p.value)}` : ', bis 10 000 weiter'}.`;
    case 'days': return 'Am meisten bringt Regelmäßigkeit: lieber öfter und kürzer als selten und lang. Drei bis fünf aktive Tage pro Woche sind das Ziel.';
  }
  return '';
}

function openFitness(date) {
  const me = fitMe(date);
  const f = Core.fitness(db, idx, date, me);
  let h = '';
  if (f.score != null) {
    const dd = fitDeltaN(date, f);
    const when = [dayLabel(date) === 'Heute' ? '' : 'Stand ' + dayLabel(date), dd != null ? 'in 4 Wochen' : ''].filter(Boolean).join(' · ');
    h += `<div class="card"><div class="fit-big"><span class="num">${countSpan(nf0.format(f.score), f.score)}</span>
      <div class="grow"><div class="fit-t">${esc(f.label)}</div>
      <div class="fit-s">${fitPill(dd)}<span class="muted small"> ${esc(when || 'Stand der letzten vier Wochen')}</span></div></div></div>
      ${fitPartsHtml(f)}</div>`;

    const from = maxDate(firstDate(), Core.addDays(date, -179));
    const dates = Core.dateRange(from, date);
    const vals = Core.fitnessSeries(db, idx, from, date, me);
    if (vals.filter(fin).length >= 2) {
      const rd = (i) => `<span>${esc(dayLabel(dates[i]))}</span><b>${fin(vals[i]) ? nf0.format(vals[i]) : '–'}</b>`;
      h += `<div class="sec-h">Verlauf<span class="muted">${dates.length > 120 ? '6 Monate' : nf0.format(dates.length) + ' Tage'}</span></div>
        <div class="card">${chartBox(Charts.trend({ dates, vals, avg: vals, h: 150, fmtY: (v) => nf0.format(v) }), rd, rd(dates.length - 1), 's')}</div>`;
    }
    if (f.next) h += `<div class="hint" style="margin-top:var(--s2)">${ICON.info}<div class="grow"><span>${esc(fitNextText(f))}</span></div></div>`;
  } else {
    h += '<p class="dlg-t">Für den Fitness-Score braucht es mindestens drei der fünf Teile, die meisten davon aus drei Wochen Daten.</p>';
  }

  h += `<div class="sec-h">Woraus er besteht</div><div class="rows">${f.parts.map((p) => {
    const tk = FIT_TREND[p.key];
    const attr = p.key === 'vo2' ? 'data-nav="training"' : `data-trend="${tk}"`;
    return `<button class="row fit-row" ${attr}><span class="grow"><span class="t">${esc(p.label)}<em>${f.score != null ? `zählt ${nf0.format(p.share * 100)} %` : ''}</em></span>
      <span class="sub">${esc(fitPartText(p, me))}</span>
      <div class="meter"><i class="${partSt(p.score)}" style="width:${p.score}%"></i></div></span>
      <span class="end"><b class="num">${nf0.format(p.score)}</b></span>${ICON.chev}</button>`;
  }).join('')}${f.missing.map((k) => {
    const def = Core.FIT_PARTS.find((x) => x.key === k);
    return `<div class="row"><span class="grow"><span class="t muted">${esc(def.label)} fehlt</span><span class="sub">${esc(FIT_MISSING[k])}</span></span></div>`;
  }).join('')}</div>`;

  const yr = new Date().getFullYear();
  h += `<div class="sec-h">Über Dich</div>
    <p class="note" style="margin:0 2px var(--s2)">VO2max hängt stark von Alter und Geschlecht ab. Mit beidem vergleicht der Score mit Deiner Gruppe statt mit allen. Bleibt auf diesem Gerät.</p>
    <div class="fit-me">
      <label>Jahrgang<input id="fitBorn" type="number" inputmode="numeric" min="1900" max="${yr - 10}" placeholder="z. B. 1990" value="${db.settings.born || ''}"></label>
      <div class="lbl">Geschlecht<div class="seg" id="fitSex">${[['m', 'Mann'], ['f', 'Frau'], ['', 'offen']].map(([v, l]) => `<button data-v="${v}" class="${db.settings.sex === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
    </div>`;

  h += `<div class="sec-h">Wie gerechnet wird</div>
    <p class="note" style="margin:0 2px">Fünf Teile, jeder 0–100 gegen einen festen Maßstab, nicht gegen Deinen eigenen Schnitt. Gezählt werden die vier Wochen vor dem Tag, VO2max ist der letzte Wert der letzten 120 Tage.</p>
    <div class="card qrows" style="margin-top:var(--s2)">
      <div><span>VO2max · 35 %</span><b>Garmins Tabelle nach Alter und Geschlecht</b></div>
      <div><span>Intensität · 25 %</span><b>150 / Woche = 60, 300 = 85</b></div>
      <div><span>Ruhepuls · 15 %</span><b>62 = 60, 52 = 85</b></div>
      <div><span>Schritte · 15 %</span><b>7500 = 65, 10 000 = 85</b></div>
      <div><span>Aktive Tage · 10 %</span><b>3 Tage / Woche = 65, 5 = 100</b></div>
    </div>
    <p class="note" style="margin:var(--s1) 2px 0">Fehlt ein Teil, zählen die übrigen anteilig mehr. HRV fehlt bewusst: Sie unterscheidet sich von Mensch zu Mensch so stark, dass es keinen festen Maßstab gibt. Das ist eine eigene Zahl dieser App, nicht Garmins Fitnessalter.</p>`;

  openSheet('Fitness', h, null);
  // Nach einer Änderung neu zeichnen, ohne nach oben zu springen
  const redo = () => { const y = $('#sheetBody').scrollTop; save(); renderToday(); openFitness(date); $('#sheetBody').scrollTop = y; };
  $('#sheetBody').onclick = (e) => {
    const b = e.target.closest('#fitSex button[data-v]');
    if (b) { db.settings.sex = b.dataset.v; redo(); return; }
    if (e.target.closest('[data-trend],[data-nav]')) closeSheet();
  };
  $('#fitBorn').onchange = (e) => {
    const v = Math.round(+e.target.value);
    db.settings.born = v >= 1900 && v <= yr - 10 ? v : null;
    if (e.target.value && !db.settings.born) toast('Jahrgang zwischen 1900 und ' + (yr - 10));
    redo();
  };
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

function openNight(date, scroll) {
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
  const sq = sleepQual(d);
  h += `<div class="card sleep-card"><div class="sl-top">
      ${fin(d.slpScore) ? `<div class="sl-score"><span class="num">${countSpan(nf0.format(d.slpScore), d.slpScore)}</span>${sq.word ? `<span class="pill st-${sq.st}">${esc(sq.word)}</span>` : ''}</div>` : ''}
      <div class="sl-facts"><span><b>${esc(Core.fmtDur(d.slp))}</b> geschlafen</span>
        ${need ? `<span>Bedarf ${esc(Core.fmtDur(need))} · <b class="st-${needSt}">${esc(Core.fmtDelta('slp', d.slp - need))}</b></span>` : ''}
        ${fin(d.awakeN) || fin(d.awake) ? `<span>${fin(d.awakeN) ? `${nf0.format(d.awakeN)}× aufgewacht` : 'wach'}${fin(d.awake) ? ` · <b>${esc(Core.fmtDur(d.awake))}</b> wach` : ''}</span>` : ''}</div>
    </div>
    ${fb || ins ? `<div class="sl-fb">${fb ? `<b>${esc(fb)}</b>` : ''}${ins ? `<span>${esc(ins)}</span>` : ''}</div>` : ''}
    ${fixNoteHtml(d)}
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
  h += `<div class="legend" style="margin-top:var(--s1)">${Object.keys(opt).length ? '<span><i class="l-opt"></i>Garmins Idealbereich</span>' : ''}<span><i class="l-mark"></i>Dein Schnitt (30 Nächte)</span></div></div>`;

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

  h += `<div class="btn-row" style="margin-top:var(--s3)"><button class="btn" data-trend="${fin(d.slpScore) ? 'slpScore' : 'slp'}">Schlaf-Trends</button></div>`;

  openSheet('Schlaf', h, null);
  $('#sheetBody').onclick = (e) => {
    const b = e.target.closest('[data-nstep]');
    if (b && b.dataset.nstep) { openNight(b.dataset.nstep); return; }
    // Wachstrecke als Schlaf markieren: Nacht neu zeichnen, an derselben Stelle bleiben
    const wb = e.target.closest('[data-wfx]');
    if (wb) {
      const top = $('#sheetBody').scrollTop;
      toggleWake(date, wb.dataset.wfx);
      openNight(date, top);
      return;
    }
    // Der Sprung zu den Trends läuft über den Klick-Handler der Seite — das Sheet muss dafür zu
    if (e.target.closest('[data-trend]')) closeSheet();
  };

  loadNight(date).then((n) => {
    // Auswertung merken, auch wenn das Sheet inzwischen zu ist — sie zählt für die Muster
    if (db.days[date] && db.days[date].nv !== NIGHT_ANA_V) { noteNight(date, n); save(); }
    const box = $('#nightCurves');
    if (!box || nightDate !== date || $('#sheet').classList.contains('hidden')) return;
    box.innerHTML = nightCurvesHtml(date, n);
    if (scroll) $('#sheetBody').scrollTop = scroll;
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
   hat — sie gilt deshalb nur zwei Stunden. NIGHT_V folgt `v` aus
   Core.mapNight: Fassung 2 liest auch Garmins unruhige Momente. `inSync`:
   aufgerufen vom Abgleich, der sich anhalten lässt und Fortschritt zeigt. */
const NIGHT_V = 2;
const nightCache = new Map();
async function loadNight(date, inSync) {
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
    try { return await api(path, inSync ? { sync: true } : undefined); } catch (e) {
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
  // Ein Teil schlug fehl (nicht nur „gibt es nicht"): nicht dauerhaft merken, beim nächsten Öffnen neu
  if (broken) n.partial = true;
  nightCache.set(key, n);
  if (!broken) await idbPut(key, n);
  return n;
}

/* Auswertung einer Nacht (sleep.js) in den Tageswerten merken: Pulsspitzen,
   Garmins unruhige Momente, Lage des Pulstiefpunkts. Erst damit werden
   Muster über viele Nächte möglich. Als erledigt (`nv`) gilt eine Nacht erst,
   wenn ihre Messreihen vollständig kamen — bei den letzten beiden Nächten
   außerdem erst, wenn der Puls die Nacht abdeckt: Die Uhr synchronisiert
   manchmal in Etappen, und eine halbe Nacht hätte zu wenig Spitzen. */
const NIGHT_ANA_V = 1;               // hochzählen, wenn Sleep.nightEvents anders rechnet
function noteNight(date, n) {
  const x = db.days[date];
  if (!x) return;
  for (const k of Sleep.NIGHT_FIELDS) delete x[k];
  const ev = n ? Sleep.nightEvents(n) : null;
  if (ev) Object.assign(x, Sleep.nightSummary(ev));
  const recent = date >= Core.addDays(Core.today(), -1);
  if (!n || (!n.partial && (!recent || (ev && ev.cover >= 0.8)))) x.nv = NIGHT_ANA_V;
}

/* Nächte im Hintergrund auswerten. Jeder Abgleich nimmt sich bis zu
   NIGHT_BATCH noch nicht ausgewertete Nächte der letzten NIGHT_BACK Tage vor,
   neueste zuerst. Eine Nacht sind 5–6 Anfragen (danach liegt sie in
   IndexedDB und öffnet sofort); hinter dem Worker mit seinen
   526-Wiederholungen etwa 15 s. So wächst der ausgewertete Verlauf mit jedem
   Abgleich, ohne einen einzelnen minutenlang zu machen. */
const NIGHT_BATCH = 3, NIGHT_BACK = 60;
async function analyzeNights() {
  const t = Core.today();
  let done = 0;
  for (let i = 0; i < NIGHT_BACK && done < NIGHT_BATCH; i++) {
    const d = Core.addDays(t, -i), x = db.days[d];
    if (!x || !fin(x.slp) || x.nv === NIGHT_ANA_V) continue;
    checkStop();
    progress(`Nacht auswerten · ${dfDay.format(pdate(d))}`);
    done++;
    try {
      noteNight(d, await loadNight(d, true));
    } catch (e) {
      if (fatal(e)) throw e;
      // Für diese Nacht kennt Garmin kein Schlaffenster: nicht bei jedem Abgleich neu fragen
      x.nv = NIGHT_ANA_V;
    }
    save();
  }
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
    h += nightWakeHtml(date, n, g);
  }
  // Pulsspitzen (sleep.js) als Striche in der Pulskurve; Antippen nennt sie
  const ev = Sleep.nightEvents(n);
  const spk = (ev && ev.spikes) || [];
  const spikeAt = (x) => spk.find((s) => x >= n.s0 + s.a - 3 && x <= n.s0 + s.b + 3);
  const curve = (key, label, unit, cls, first, marks) => {
    const ys = g[key];
    if (ys.filter(fin).length < 3) return '';
    const fy = (v) => nf0.format(v);
    const reader = (i) => {
      const s = marks && spikeAt(xs[i]);
      return `<span>${esc(Core.fmtClock(xs[i]))}</span><b>${fin(ys[i]) ? esc(fy(ys[i]) + unit) : '–'}</b>${s ? `<span class="end mk-t">Pulsspitze +${nf0.format(s.up)}</span>` : ''}`;
    };
    return `<div class="card"><div class="card-h">${esc(label)}</div>${chartBox(Charts.curve(xs, ys, { fmtY: fy, fmtX: Core.fmtClock, xUnit: 60, cls, fill: true, marks }), reader, first, 's')}</div>`;
  };
  const stat = (pts) => { const v = (pts || []).map((p) => p[1]); return v.length ? { avg: Core.mean(v), lo: Math.min(...v), hi: Math.max(...v), at: pts[v.indexOf(Math.min(...v))][0] } : null; };
  const hr = stat(n.hr), hrv = stat(n.hrv), ox = stat(n.spo2);
  h += curve('hr', 'Puls', ' bpm', 'c-hr', hr ? `<span>Ø</span><b>${nf0.format(hr.avg)} bpm</b><span class="end">tiefster ${nf0.format(hr.lo)} um ${esc(Core.fmtClock(n.s0 + hr.at))}</span>` : '', spk.map((s) => n.s0 + s.at));
  h += curve('hrv', 'HRV', ' ms', 'c-hrv', hrv ? `<span>Ø</span><b>${nf0.format(hrv.avg)} ms</b><span class="end">${nf0.format(hrv.lo)}–${nf0.format(hrv.hi)} ms</span>` : '');
  const bb0 = n.bb && n.bb.length ? n.bb[0][1] : null, bb1 = n.bb && n.bb.length ? n.bb[n.bb.length - 1][1] : null;
  const bbTxt = fin(n.bbImp) ? `<span>in der Nacht</span><b>${n.bbImp > 0 ? '+' : ''}${nf0.format(n.bbImp)}</b>` : '';
  h += curve('bb', 'Body Battery', '', 'c-bb', (bbTxt || '') + (fin(bb0) ? `<span class="end">${nf0.format(bb0)} → ${nf0.format(bb1)}</span>` : ''));
  h += curve('spo2', 'SpO2', ' %', 'c-spo2', ox ? `<span>Ø</span><b>${nf0.format(ox.avg)} %</b><span class="end">tiefster ${nf0.format(ox.lo)} %</span>` : '');
  if (!['hr', 'hrv', 'bb', 'spo2'].some((k) => g[k].filter(fin).length >= 3)) h += '<p class="note">Für diese Nacht hat Garmin keine Messreihen.</p>';
  if (n.unm) h += `<p class="note">${esc(Core.fmtDur(n.unm))} ließen sich keiner Phase zuordnen.</p>`;
  if (n.note) h += `<div class="hint">${ICON.info}<div class="grow"><strong>Deine Notiz</strong><span>${esc(n.note)}</span></div></div>`;
  return h + nightPatternHtml(date, n, ev);
}

/** Wann Du wach gewesen sein könntest, wenn Garmin den Phasenverlauf nicht
    mitschickt (Sleep.wakeHints): Strecken mit erhöhtem Puls und Lücken
    ohne Puls, gegen Garmins Summe der Wachzeit. Strecken ab 6 min lassen
    sich als Schlaf markieren (toggleWake), dann rechnet die App die Nacht
    ohne sie. */
function nightWakeHtml(date, n, g) {
  const w = Sleep.wakeHints(n), d = db.days[date] || {}, gd = Sleep.garminNight(d);
  const xs = g.xs;
  const ups = (w && w.up) || [], gaps = (w && w.gaps) || [];
  const fx = d.wfx || [];
  const marked = (s) => fx.some(([a, b]) => s.a < b && s.b > a);
  const clock = (m) => Core.fmtClock(n.s0 + m);
  const mins = (m) => Core.fmtDur(m * 60);
  const garmin = fin(gd.awake) ? `Garmin: <b class="num">${esc(Core.fmtDur(gd.awake))}</b> wach${fin(gd.awakeN) ? `, ${nf0.format(gd.awakeN)}× aufgewacht` : ''}` : '';
  let h = `<div class="card" id="nightWake"><div class="card-h">Wann wach?<span class="muted">aus dem Puls geschätzt</span></div>`;
  if (garmin) h += `<p class="note" style="margin:0 0 var(--s1)">${garmin}. Wann genau, gibt Garmins Personal API nicht heraus.</p>`;
  if (!w || (!ups.length && !gaps.length)) {
    h += w && w.up
      ? '<p class="note">Im Puls nichts Auffälliges: Er lag die ganze Nacht nah an Deinem Schlafniveau, und die Uhr hat lückenlos gemessen.</p>'
      : '<p class="note">Für diese Nacht ist zu wenig Puls da.</p>';
    if (fx.length) h += `<p class="note">Du hattest hier ${fx.length === 1 ? 'eine Strecke' : `${nf0.format(fx.length)} Strecken`} als Schlaf markiert. <button class="btn btn-sm" data-wfx="clear">Markierung aufheben</button></p>`;
    return h + '</div>';
  }

  // Als Schlaf markierte Strecken liegen in einer eigenen, blassen Bahn
  const segs = ups.map((s) => [n.s0 + s.a, n.s0 + s.b, marked(s) ? 2 : 0])
    .concat(gaps.map((s) => [n.s0 + s.a, n.s0 + s.b, marked(s) ? 2 : 1]));
  const rows = [['erhöht', 'ph-awake'], ['Lücke', 'wk-gap']];
  if (fx.length) rows.push(['Schlaf', 'wk-ok']);
  const reader = (i) => {
    const m = i * g.step;
    const u = ups.find((s) => m >= s.a - 2 && m <= s.b + 2), gp = gaps.find((s) => m >= s.a && m <= s.b);
    const own = (u && marked(u)) || (gp && marked(gp)) ? ' · von Dir als Schlaf markiert' : '';
    const what = u ? `<b>Puls erhöht</b><span class="end mk-t">+${nf0.format(u.up)} · ${esc(clock(u.a))}–${esc(clock(u.b))}${own}</span>`
      : gp ? `<b>kein Puls</b><span class="end">${esc(clock(gp.a))}–${esc(clock(gp.b))}${own}</span>`
      : `<b>${fin(g.hr[i]) ? nf0.format(g.hr[i]) + ' bpm' : '–'}</b><span class="end">ruhig</span>`;
    return `<span>${esc(Core.fmtClock(xs[i]))}</span>${what}`;
  };
  const sum = [ups.length ? `erhöhter Puls <b>${esc(mins(w.upMin))}</b>` : '', gaps.length ? `ohne Puls <b>${esc(mins(w.gapMin))}</b>` : ''].filter(Boolean).join('<span>·</span>');
  h += chartBox(Charts.lanes(xs, segs, rows, { fmtX: Core.fmtClock }), reader, sum, 's');

  // Liste nach Uhrzeit, je mit Knopf „Schlaf"; kurze Spitzen (unter 6 min) nur gezählt, sie stehen unten bei den Pulsspitzen
  const SHORT = 6, edge = (s) => (s.a < Sleep.WAKE.edge || s.b > n.len - Sleep.WAKE.edge ? 1 : 0);
  const items = ups.filter((s) => s.dur >= SHORT).map((s) => [s, `Puls +${nf0.format(s.up)}${s.edge === 'start' ? ' · beim Einschlafen' : s.edge === 'end' ? ' · beim Aufwachen' : ''}`, 'warn'])
    .concat(gaps.map((s) => [s, 'kein Puls gemessen', '']))
    .sort((x, y) => x[0].a - y[0].a);
  const short = ups.filter((s) => s.dur < SHORT);
  if (items.length) {
    h += `<div class="qrows np-rows wk-rows">${items.map(([s, sub, st]) => {
      const on = marked(s);
      return `<div><span>${esc(clock(s.a))}–${esc(clock(s.b))}<small>${esc(on ? 'von Dir als Schlaf markiert' : sub)}</small></span>`
        + `<b class="num${on ? ' st-off' : st ? ' st-' + st : ''}">${esc(mins(s.dur))}</b>`
        + `<button class="btn btn-sm${on ? ' on' : ''}" data-wfx="${s.a},${s.b},${edge(s)}" aria-pressed="${on}" aria-label="${on ? 'Wieder als wach zählen' : 'Als Schlaf zählen'}">Schlaf</button></div>`;
    }).join('')}</div>`;
  }
  if (short.length) h += `<p class="note">Dazu ${short.length === 1 ? 'eine kurze Pulsspitze' : `${nf0.format(short.length)} kurze Pulsspitzen`} (${short.map((s) => clock(s.a)).join(', ')}): kurz wach oder fast wach, meist ohne Erinnerung daran.</p>`;

  // Einordnung gegen Garmins Summe
  const seen = (w.upMin || 0) + w.gapMin, aw = fin(gd.awake) ? gd.awake / 60 : null;
  const notes = [];
  if (items.length) notes.push('Weißt Du, dass Du in einer Strecke geschlafen hast, tipp auf „Schlaf“. Die App zieht sie von Garmins Wachzeit ab und rechnet den Score neu, überall mit dem Vermerk „korrigiert“. Nochmal tippen nimmt es zurück.');
  if (aw != null && aw >= 20 && seen < aw * 0.5) notes.push(`Von Garmins ${esc(mins(aw))} sieht man im Puls nur ${esc(mins(seen))}. Für den Rest stützt sich Garmin auf die Bewegung, die die Personal API nicht mitschickt: Umdrehen oder unruhiges Liegen kann dann als wach zählen, obwohl Du geschlafen hast.`);
  if (gaps.length) notes.push('In den Lücken hat die Uhr keinen Puls gemessen, meist weil das Band locker saß oder der Arm darauf lag. Was Garmin dort einträgt, ist geschätzt.');
  if (ups.some((s) => s.dur >= SHORT)) notes.push('Erhöhter Puls: mindestens 8 Schläge über Deinem Schlafniveau dieser Stunde. Liegst Du wach, steigt er meist um 10 und mehr.');
  return h + notes.map((t) => `<p class="note">${t}</p>`).join('') + '</div>';
}

/** Kennzeichen einer korrigierten Nacht: „korrigiert · Garmin 72". */
function fixPill(d) {
  if (!d || !d.gx) return '';
  return `<span class="pill st-off">korrigiert${fin(d.gx.slpScore) && d.gx.slpScore !== d.slpScore ? ` · Garmin ${nf0.format(d.gx.slpScore)}` : ''}</span>`;
}

/** Was an einer korrigierten Nacht anders ist als bei Garmin und wie
    sicher die Schätzung des Scores ist. */
function fixNoteHtml(d) {
  if (!d || !d.gx) return '';
  const g = d.gx, m = fixModel();
  const sec = fin(g.awake) && fin(d.awake) ? g.awake - d.awake : 0;
  const marked = (d.wfx || []).reduce((s, [a, b]) => s + (b - a), 0) * 60;
  const parts = [`<b>${esc(Core.fmtDur(sec))}</b> Wachzeit als Schlaf gezählt${marked > sec + 59 ? ` (markiert ${esc(Core.fmtDur(marked))}, mehr Wachzeit hat Garmin nicht)` : ''}`];
  if (fin(g.awakeN) && g.awakeN !== d.awakeN) parts.push(`${nf0.format(g.awakeN - d.awakeN)}× weniger aufgewacht`);
  let h = `<div class="hint fix-note">${ICON.info}<div class="grow"><strong>Korrigiert</strong><span>${parts.join(', ')} (von Dir unter „Wann wach?“ markiert).`;
  if (fin(g.slpScore)) {
    h += ` Garmins Score: ${nf0.format(g.slpScore)}`;
    h += m && fin(d.slpScore) && d.slpScore !== g.slpScore
      ? `. Neu geschätzt aus ${nf0.format(m.n)} Deiner Nächte, das Modell trifft Garmins Score im Mittel auf ± ${nf1.format(m.err)} Punkte.`
      : m ? '. Am Score ändert das laut Deinen Nächten nichts Messbares.' : `. Für eine Schätzung des Scores braucht die App ${Sleep.FIX_MIN} Nächte, er bleibt bis dahin Garmins.`;
  }
  return h + '</span></div></div>';
}

/* Score-Modell für korrigierte Nächte (Sleep.scoreModel): einmal je Abgleich
   bzw. Sitzung gerechnet, es hängt nur an Garmins Werten aller Nächte. */
let fixModelC;
function fixModel() {
  if (fixModelC === undefined) fixModelC = Sleep.scoreModel(db.days);
  return fixModelC;
}

/** Eine Strecke als Schlaf markieren oder die Markierung zurücknehmen
    (überlappende alte Markierungen fallen weg, die Nacht kann sich beim
    Neuladen leicht verschoben haben). 'clear' hebt alle auf. */
function toggleWake(date, spec) {
  const x = db.days[date];
  if (!x) return;
  let fx = x.wfx || [];
  if (spec === 'clear') fx = [];
  else {
    const [a, b, e] = spec.split(',').map(Number);
    if (!(b > a)) return;
    const rest = fx.filter(([p, q]) => !(p < b && q > a));
    fx = rest.length === fx.length ? rest.concat([[a, b, e ? 1 : 0]]).sort((p, q) => p[0] - q[0]) : rest;
  }
  if (fx.length) x.wfx = fx; else delete x.wfx;
  Sleep.applyFix(x, fixModel());
  save(); reindex(); render();
}

/** Was sich in dieser Nacht erkennen lässt: Pulsspitzen, ruhigste Strecke,
    Pulstiefpunkt, Garmins unruhige Momente und — mit Phasenverlauf — der
    Aufbau aus Zyklen. Jeweils gegen Deinen Schnitt, sobald es ihn gibt. */
function nightPatternHtml(date, n, ev) {
  if (!ev || !(ev.spikes || ev.low || ev.garmin || ev.struct)) return '';
  const clock = (m) => Core.fmtClock(n.s0 + m);
  const mins = (m) => Core.fmtDur(m * 60);
  const avgOf = (key) => nightMean(date, (x) => (fin(x[key]) ? x[key] : null));
  const rows = [];
  let h = '<div class="sec-h">Unruhe und Aufbau</div><div class="card">';

  if (ev.spikes) {
    const k = ev.spikes.length, avg = avgOf('rm');
    const st = avg == null ? '' : k <= avg - 1 ? 'good' : k >= avg + 2 ? 'warn' : '';
    h += `<div class="np-h"><b class="num${st ? ' st-' + st : ''}">${nf0.format(k)}</b><span>${k === 1 ? 'Pulsspitze' : 'Pulsspitzen'}${avg != null ? ` · Dein Ø ${esc(meanFmt('rm', avg))}` : ''}</span></div>`;
    if (k) {
      h += `<div class="tchips">${ev.spikes.map((s) => `<span><b class="num">${esc(clock(s.at))}</b>+${nf0.format(s.up)}</span>`).join('')}</div>`;
      const th = [0, 0, 0];
      for (const s of ev.spikes) th[Math.min(2, Math.floor(s.at / (ev.len / 3)))]++;
      if (k >= 2) rows.push(['Verteilung', `${th[0]} · ${th[1]} · ${th[2]}`, 'erstes, mittleres, letztes Drittel']);
    } else {
      h += '<p class="note" style="margin-top:4px">Kein kurzer Pulsanstieg — eine ruhige Nacht.</p>';
    }
  }
  if (ev.calm && ev.calm.dur >= 30) rows.push(['Längste ruhige Strecke', mins(ev.calm.dur), `${clock(ev.calm.a)}–${clock(ev.calm.b)}`]);
  if (ev.low) {
    const p = ev.low.pct, avg = avgOf('hrLow');
    const word = p <= 50 ? 'früh' : p <= 70 ? 'in der zweiten Hälfte' : 'spät';
    rows.push(['Pulstiefpunkt', `${clock(ev.low.at)} · ${nf0.format(p)} %`, `${word}${avg != null ? ` · Dein Ø ${nf0.format(avg)} %` : ''}`, p <= 50 ? 'good' : p > 70 ? 'warn' : '']);
  }
  if (ev.garmin) rows.push(['Unruhige Momente', nf0.format(ev.garmin.n), 'laut Garmin, aus der Bewegung']);
  const sv = ev.struct;
  if (sv) {
    if (sv.cycles) rows.push(['Schlafzyklen', nf0.format(sv.cycles), 'je mit REM-Phase, üblich 4–6']);
    if (fin(sv.deepFirst)) rows.push(['Tiefschlaf in der 1. Hälfte', nf0.format(sv.deepFirst) + ' %', 'üblich: der größte Teil', sv.deepFirst >= 60 ? 'good' : 'warn']);
    if (fin(sv.remLate)) rows.push(['REM in der 2. Hälfte', nf0.format(sv.remLate) + ' %', 'üblich: der größte Teil', sv.remLate >= 55 ? 'good' : '']);
    if (fin(sv.firstDeep)) rows.push(['Erster Tiefschlaf nach', mins(sv.firstDeep), '']);
    if (fin(sv.firstRem)) rows.push(['Erster REM-Schlaf nach', mins(sv.firstRem), 'üblich 1–2 h']);
    rows.push(['Wach mitten in der Nacht', sv.wakes.length ? `${nf0.format(sv.wakes.length)}×` : 'nie', sv.wakes.length ? sv.wakes.map(([a]) => clock(a)).join(', ') : '']);
  }
  if (rows.length) {
    h += `<div class="qrows np-rows">${rows.map(([l, v, sub, st]) => `<div><span>${esc(l)}${sub ? `<small>${esc(sub)}</small>` : ''}</span><b class="num${st ? ' st-' + st : ''}">${esc(v)}</b></div>`).join('')}</div>`;
  }
  if (ev.spikes) h += '<p class="note">Pulsspitze: Der Puls steigt für ein paar Minuten um mindestens 8 Schläge über seinen Verlauf — meist eine Weckreaktion oder kurzes Wachsein, an das Du Dich nicht erinnerst. Beim Einschlafen und Aufwachen zählt die App sie nicht. Pulstiefpunkt: wo der Puls über eine halbe Stunde gemittelt am tiefsten lag, in Prozent der Nacht.</p>';
  else if (!ev.struct && !ev.garmin) h += '<p class="note">Für Pulsspitzen deckt der Puls zu wenig von der Nacht ab.</p>';
  return h + '</div>';
}

/** Wie weit eine Kachel für seltene Werte zurückschaut. VO2max kommt nur
    mit Läufen und Fahrten im Freien, im Winter oft wochenlang keine — 120
    Tage wie im Fitness-Score. */
const sparseDays = (key) => (key === 'vo2' ? 120 : 60);

/** Kurze Labels für die Metrik-Karten, wo der Name aus Core zu lang ist. */
const TILE_LABEL = { slpResp: 'Atmung (Nacht)' };

/** Pill mit der Veränderung: Pfeil und Zahl. Mint, wenn es in die gute
    Richtung geht, Koralle in die schlechte, grau ohne Richtung oder bei
    weniger als einem Viertel Deiner üblichen Schwankung (Rauschen). */
function deltaPill(key, v, prev, base, what) {
  if (!fin(v) || !fin(prev)) return '';
  const m = M[key] || {};
  const d = v - prev;
  const txt = Core.fmtDelta(key, d);
  if (!txt) return '';
  if (txt[0] === '±') return `<span class="pill st-off" aria-label="${esc('unverändert ' + what)}">±0</span>`;
  const tiny = base && fin(base.sd) && Math.abs(d) < base.sd * 0.25;
  const st = tiny || !m.dir ? 'off' : d * m.dir > 0 ? 'good' : 'bad';
  // Ohne Einheit: Sie steht schon am Wert, die Pill bleibt so kurz
  const bare = m.unit && txt.endsWith(' ' + m.unit) ? txt.slice(1, -m.unit.length - 1) : txt.slice(1);
  return `<span class="pill st-${st}" aria-label="${esc(txt + ' ' + what)}">${d > 0 ? ICON.up : ICON.down}${esc(bare)}</span>`;
}

/** Metrik-Karte: Label, Wert mit der Veränderung zum Vortag als Pill, die
    letzten sieben Tage als Sparkline mit Deinem Normalbereich als Band; der
    letzte Punkt in der Farbe seines Zustands. Intensitätsminuten zählen als
    Woche gegen das Wochenziel, Belastung als 7-Tage-Summe — so, wie man
    darüber nachdenkt. Seltene Werte (Gewicht, VO2max) vergleichen mit der
    Messung davor und zeigen ein längeres Fenster. */
function tile(key, date, wide) {
  const m = M[key];
  const t = Core.today();
  const sw = wide ? 252 : 92;               // Breite der Sparkline neben der Pill, in px der Karte
  if (key === 'im') {
    const ws = Core.weekStart(date);
    const vals = Core.dateRange(ws, date).map((x) => Core.value(db, idx, 'im', x)).filter(fin);
    const tot = Math.round(vals.reduce((s, v) => s + v, 0));
    const goal = (db.days[date] || {}).imGoal || 150;
    const pct = Math.min(100, (tot / goal) * 100);
    return `<button class="mcard" data-trend="im"><span class="lbl">Intensität · Woche</span>
      <span class="mval"><span class="num">${countSpan(nf0.format(tot), tot)}<small>/ ${nf0.format(goal)} min</small></span></span>
      <div class="meter"><i class="${tot >= goal ? 'full' : ''}" style="width:${pct}%"></i></div>
      <span class="sub">${tot >= goal ? 'Wochenziel erreicht' : `noch ${nf0.format(goal - tot)} min bis zum Ziel`}</span></button>`;
  }
  if (key === 'load') {
    const ls = Core.loadStatus(db, idx, date);
    const vals = Core.loadSeries(db, idx, Core.addDays(date, -6), date).map((r) => r.acute);
    const st = ls ? { low: 'ok', ok: 'good', high: 'warn', spike: 'bad' }[ls.status] : 'off';
    return `<button class="mcard" data-nav="training"><span class="lbl">Belastung · 7 Tage</span>
      <span class="mval"><span class="num">${ls ? countSpan(nf0.format(ls.acute), Math.round(ls.acute)) : '–'}</span></span>
      <div class="mtrend">${Charts.spark(vals, { band: ls ? [ls.chronic * 0.8, ls.chronic * 1.3] : null, st, w: wide ? 311 : 136 })}</div>
      <span class="sub">${ls ? `<b class="st-${st}">${esc(ls.short)}</b> · üblich ${nf0.format(ls.chronic)}` : 'braucht 3 Wochen Daten'}</span></button>`;
  }
  // Seltene Werte (Gewicht, VO2max): der letzte bekannte zählt
  const look = sparseDays(key);
  let v = Core.value(db, idx, key, date), vDate = date;
  if (m.sparse && !fin(v)) {
    for (let i = 1; i <= look && !fin(v); i++) { vDate = Core.addDays(date, -i); v = Core.value(db, idx, key, vDate); }
  }
  const base = Core.baseline(db, idx, key, date, m.sparse ? 90 : 30, m.sparse ? 3 : 10);
  // Was sich über den Tag erst ansammelt, ist heute noch nicht fertig: kein Urteil, kein Vergleich
  const partial = date === t && ACCUM.includes(key);
  const st = partial ? null : Core.judge(v, base, m.dir);
  let prev = null;
  if (m.sparse) {
    for (let i = 1; i <= look && prev == null; i++) { const x = Core.value(db, idx, key, Core.addDays(vDate, -i)); if (fin(x)) prev = x; }
  } else prev = Core.value(db, idx, key, Core.addDays(date, -1));
  const pill = partial ? '' : deltaPill(key, v, prev, base, m.sparse ? 'zur Messung davor' : 'zum Vortag');
  // Seltene Werte: die letzten zwölf Messungen, sonst wird die kleine Linie zum Rauschen
  const vals = m.sparse
    ? Core.series(db, idx, key, Core.addDays(date, 1 - look), date).filter(fin).slice(-12)
    : Core.series(db, idx, key, Core.addDays(date, -6), date);
  let extra = '';
  if (m.sparse && fin(v)) extra = `<span class="sub">${esc(vDate === date ? 'heute gemessen' : vDate === Core.addDays(t, -1) ? 'gestern gemessen' : 'zuletzt ' + dfShort.format(pdate(vDate)))}</span>`;
  if (partial && fin(v)) extra = '<span class="sub">bis jetzt</span>';
  if (key === 'steps' && fin(v)) {
    const goal = (db.days[date] || {}).stepGoal;
    if (goal) extra = `<div class="meter"><i class="${v >= goal ? 'full' : ''}" style="width:${Math.min(100, (v / goal) * 100)}%"></i></div><span class="sub">${partial ? 'bis jetzt · ' : ''}${v >= goal ? 'Tagesziel erreicht' : `Ziel ${nf0.format(goal)}`}</span>`;
  }
  // Den VO2max-Trend gibt es erst ab zwei Werten, davor zeigt Training den einen
  const attr = key === 'vo2' && Object.keys(idx.vo2).length < 2 ? 'data-nav="training"' : `data-trend="${key}"`;
  return `<button class="mcard" ${attr}><span class="lbl">${esc(TILE_LABEL[key] || m.label)}</span>
    <span class="mval"><span class="num">${numHtml(key, v)}</span></span>
    <div class="mtrend">${Charts.spark(vals, { band: base && !m.sparse ? [base.lo, base.hi] : null, connect: m.sparse, st: st || 'off', partial, w: pill ? sw : sw + 52 })}${pill}</div>
    ${extra}</button>`;
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

/* Zeitraum der Detailansicht: kurz für den Blick auf die letzten Tage, lang
   für die Trends über Monate und Jahre, um die es der App geht. */
const RANGES = [[7, 'Woche'], [30, 'Monat'], [91, '3 Mon.'], [365, 'Jahr'], [0, 'Alles']];
const RANGE_WORD = { 7: ['letzte 7 Tage', 'der Woche davor'], 30: ['letzte 30 Tage', 'den 30 Tagen davor'], 91: ['letzte 3 Monate', 'den 3 Monaten davor'], 365: ['letzte 12 Monate', 'dem Jahr davor'] };

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
    if (k === 'deepPct' || k === 'remPct') { if (days.some((d) => fin(d[k.slice(0, -3)]) && d.slp > 0)) out.add(k); continue; }
    // Nur aus ausgewerteten Nächten: erst ab ein paar Nächten ein eigener Chip
    if (M[k].minN) { if (days.filter((d) => fin(d[k])).length >= M[k].minN) out.add(k); continue; }
    if (days.some((d) => fin(d[k]))) out.add(k);
  }
  return out;
}

/** Kurze Einordnung unter dem Diagramm, in ganzen Sätzen: Niveau gegen den
    Zeitraum davor (und ob das besser ist), bei langen Zeiträumen die
    Tendenz, und wie viele Tage in Deinem Normalbereich lagen. */
function trendText(key, ps, o) {
  const m = M[key] || {};
  const isSum = m.agg === 'sum';
  const b = (v) => `<b>${esc(Core.fmt(key, v))}</b>`;
  const out = [];
  let lead = isSum ? `Im Schnitt ${b(ps.avg)} pro Tag` : `Im Schnitt ${b(ps.avg)}`;
  if (fin(ps.prevAvg) && o.prevLbl) {
    const d = ps.avg - ps.prevAvg;
    const txt = Core.fmtDelta(key, d);
    if (!txt || txt[0] === '±') lead += `, genauso viel wie in ${o.prevLbl}`;
    else {
      const more = m.fmt === 'clock' ? (d > 0 ? 'später' : 'früher') : (d > 0 ? 'mehr' : 'weniger');
      const judge = !m.dir ? '' : d * m.dir > 0 ? ', also besser' : ', also schlechter';
      lead += `, ${esc(txt.slice(1))} ${more} als in ${o.prevLbl}${judge}`;
    }
  }
  out.push(lead + '.');
  if (o.long && fin(ps.perMonth)) {
    const txt = Core.fmtDelta(key, ps.perMonth);
    out.push(!txt || txt[0] === '±' ? 'Über den Zeitraum ohne klare Tendenz.' : `Tendenz: ${esc(txt)} pro Monat.`);
  }
  if (o.lo && o.hi) {
    let n = 0, inside = 0, below = 0;
    o.vals.forEach((v, i) => {
      if (!fin(v) || !fin(o.lo[i]) || !fin(o.hi[i])) return;
      n++;
      if (v < o.lo[i]) below++; else if (v <= o.hi[i]) inside++;
    });
    if (n >= 5) {
      const above = n - inside - below;
      const off = m.dir ? (m.dir > 0 ? below : above) : 0;
      out.push(`${nf0.format(inside)} von ${nf0.format(n)} Tagen lagen in Deinem Normalbereich${off ? `, ${nf0.format(off)} ${m.dir > 0 ? 'darunter' : 'darüber'}` : ''}.`);
    }
  }
  return out.join(' ');
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
  h += `<div class="seg top" role="tablist" aria-label="Zeitraum">${RANGES.map(([r, l]) => `<button role="tab" aria-selected="${r === trendRange}" class="${r === trendRange ? 'on' : ''}" data-set="trendRange:${r}">${l}</button>`).join('')}</div>`;
  // Achsenstriche bei vollen Stunden bzw. Uhrzeiten statt bei krummen Sekundenwerten
  const unit = m.fmt === 'dur' ? 3600 : (m.fmt === 'min' || m.fmt === 'clock') ? 60 : 1;

  const ps = Core.periodStats(db, idx, trendKey, from, t);
  // Schlafsaldo: die Nulllinie heißt „Bedarf gedeckt"
  const goal = trendKey === 'steps' ? (db.days[t] || db.days[Core.addDays(t, -1)] || {}).stepGoal : trendKey === 'debt' ? 0 : null;
  const week = dates.length <= 10;
  // Von Dir korrigierte Nächte (Wann wach?) beim Ablesen kennzeichnen
  const fixKey = Sleep.FIX_KEYS.includes(trendKey) || ['deepPct', 'remPct', 'debt'].includes(trendKey);
  const reader = (i) => {
    const v = vals[i];
    const fixd = fixKey && fin(v) && (db.days[dates[i]] || {}).gx;
    return `<span>${esc(dayLabel(dates[i]))}</span><b>${esc(Core.fmt(trendKey, v))}</b>${fixd ? '<span class="st-off">korrigiert</span>' : ''}`
      + (fin(avg[i]) && !week ? `<span class="end">Ø${m.sparse ? '' : ' 7 T'} ${esc(Core.fmt(trendKey, avg[i]))}</span>` : '');
  };
  let last = vals.length - 1;
  while (last > 0 && !fin(vals[last])) last--;

  const [rangeLbl, prevLbl] = RANGE_WORD[trendRange] || [`seit ${dfDate.format(pdate(from))}`, ''];
  h += '<div class="card">';
  if (ps) {
    // Veränderung des Tagesmittels gegen den gleich langen Zeitraum davor
    const delta = fin(ps.prevAvg) ? ps.avg - ps.prevAvg : null;
    const base = band ? { sd: Core.sd(vals.filter(fin)) } : null;
    h += `<div class="tr-head"><span class="lbl">${esc(m.label)} · ${isSum ? 'Summe' : 'Ø'} ${esc(rangeLbl)}</span>
      <div class="tr-big"><span class="num">${numHtml(trendKey, isSum ? ps.total : ps.avg)}</span>${delta != null ? deltaPill(trendKey, ps.avg, ps.prevAvg, base, 'zum Zeitraum davor') : ''}</div></div>`;
  }
  const svg = Charts.trend({ dates, vals, avg, lo, hi, goal, unit, bars: isSum && dates.length <= 120, zero: isSum, fmtY: (v) => Core.fmt(trendKey, v, true) });
  h += `<div class="tr-chart">${chartBox(svg, reader, last >= 0 && fin(vals[last]) ? reader(last) : '')}</div>`;
  const lineLbl = week && !(isSum && dates.length <= 120) ? 'Tageswert' : m.sparse ? 'Mittel 4 Wochen' : 'Mittel 7 Tage';
  h += `<div class="legend">${week && !isSum ? '' : '<span><i class="l-pt"></i>Tag</span>'}<span><i class="l-avg"></i>${lineLbl}</span>${band ? '<span><i class="l-band"></i>Dein Normalbereich</span>' : ''}${goal != null ? `<span><i class="l-goal"></i>${trendKey === 'debt' ? 'Bedarf gedeckt' : 'Ziel'}</span>` : ''}</div>`;
  if (ps) h += `<p class="tr-text">${trendText(trendKey, ps, { vals, lo, hi, prevLbl, long: dates.length >= 60 })}</p>`;
  if (m.hint || band) h += `<p class="note">${m.hint ? esc(m.hint) + '. ' : ''}${band ? 'Der Normalbereich ist Dein Mittel ± eine Standardabweichung über die 30 Tage davor; etwa zwei von drei Tagen liegen darin.' : ''}</p>`;
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
  // Mehr als im gleichen Abschnitt davor in Mint, weniger neutral: weniger Training ist kein Fehler
  const cmp = (a, b, f) => (b || a
    ? (a === b ? '<span class="pill st-off">±0</span>'
      : `<span class="pill st-${a > b ? 'good' : 'off'}">${a > b ? ICON.up : ICON.down}${esc(f(Math.abs(a - b)))}</span>`)
    : '');

  let h = `<div class="seg top">${PERIODS.map(([p, l]) => `<button class="${p === trainPeriod ? 'on' : ''}" data-set="trainPeriod:${p}">${l}</button>`).join('')}</div>`;
  h += `<div class="card"><div class="stat-row">
    <div class="stat"><span class="stat-l">Einheiten</span><span class="stat-v">${countSpan(nf0.format(cur.n), cur.n)}</span>${cmp(cur.n, prev.n, nf0.format)}</div>
    <div class="stat"><span class="stat-l">Zeit</span><span class="stat-v">${esc(Core.fmtDur(cur.dur))}</span>${cmp(cur.dur, prev.dur, Core.fmtDur)}</div>
    <div class="stat"><span class="stat-l">Distanz</span><span class="stat-v">${esc(km(cur.dist))}</span>${cmp(cur.dist, prev.dist, km)}</div>
  </div><p class="note">Gegen den gleichen Abschnitt ${trainPeriod === 'week' ? 'der Vorwoche' : trainPeriod === 'month' ? 'des Vormonats' : 'des Vorjahrs'}.</p></div>`;

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
      ${ls ? `<div class="tr-head"><span class="lbl">7 Tage gegen üblich</span>
        <div class="tr-big"><span class="num">${countSpan(nf1.format(ls.ratio), Math.round(ls.ratio * 10) / 10, 1)}<small>×</small></span><span class="pill st-${stc}">${esc(ls.short)}</span></div>
        <span class="note" style="margin:0">${nf0.format(ls.acute)} in den letzten 7 Tagen, üblich sind ${nf0.format(ls.chronic)}</span></div>` : ''}
      <div class="tr-chart">${chartBox(Charts.load(rows), rl, rl(rows.length - 1))}</div>
      <div class="legend"><span><i class="l-acute"></i>letzte 7 Tage</span><span><i class="l-chronic"></i>üblich (Wochenmittel aus 4 Wochen)</span><span><i class="l-ok"></i>gut verträglich</span></div>
      <p class="note">Belastung ist Garmins Trainingslast je Einheit (ohne Wert: aus Dauer und Puls geschätzt). Bis etwa 1,3× des Üblichen gilt als gut verträglich, ab 1,5× steigt das Verletzungsrisiko.</p></div>`;
  }

  // VO2max aus den Aktivitäten
  const vo2d = Object.keys(idx.vo2).sort();
  if (vo2d.length >= 2) {
    const from = maxDate(vo2d[0], Core.addDays(t, -364));
    const dates = Core.dateRange(from, t);
    const vals = dates.map((d) => (fin(idx.vo2[d]) ? idx.vo2[d] : null));
    // Garmins Schätzung springt von Lauf zu Lauf um einen Punkt: als Linie das Mittel über 30 Tage
    const smooth = Core.rolling(vals, 30, 1);
    const rv2 = (i) => `<span>${esc(dayLabel(dates[i]))}</span><b>${fin(vals[i]) ? nf0.format(vals[i]) : '–'}</b>${fin(smooth[i]) ? `<span class="end">Ø 30 T ${nf1.format(smooth[i])}</span>` : ''}`;
    const latest = idx.vo2[vo2d[vo2d.length - 1]];
    h += `<div class="sec-h">VO2max<span class="muted">aus Läufen und Fahrten</span></div><div class="card">
      <div class="tr-head"><span class="lbl">Zuletzt · ${esc(dfDate.format(pdate(vo2d[vo2d.length - 1])))}</span>
        <div class="tr-big"><span class="num">${countSpan(nf0.format(latest), latest)}</span></div></div>
      <div class="tr-chart">${chartBox(Charts.trend({ dates, vals, avg: smooth, h: 150, fmtY: (v) => nf0.format(v) }), rv2, '')}</div>
      <div class="legend"><span><i class="l-pt"></i>Messung</span><span><i class="l-avg"></i>Mittel 30 Tage</span></div></div>`;
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
  if (list.length > trainShow) h += `<div class="btn-row" style="margin-top:var(--s2)"><button class="btn" data-action="more">Weitere ${nf0.format(Math.min(30, list.length - trainShow))} zeigen</button></div>`;
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
  let h = `<p class="note" style="margin:0 0 var(--s2)">${esc(dfLong.format(pdate(a.date)))} · ${esc(a.start.slice(11, 16))} · ${esc(Core.typeLabel(a.type))}${a.loc ? ' · ' + esc(a.loc) : ''}${a.pr ? ' · Bestleistung' : ''}</p>`;
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
    h += '<div class="legend" style="margin-bottom:var(--s2)"><span><i class="lz1"></i>niedrig</span><span><i class="lz3"></i>mittel</span><span><i class="lz5"></i>hoch</span><span><i class="l-start"></i>Start</span><span><i class="l-end"></i>Ziel</span></div>';
  }
  const curve = (key, label, fmtY, cls, opt) => {
    if (!st[key]) return '';
    const reader = (i) => `<span>${esc(xs[i] != null ? hms(xs[i]) : '')}</span><b>${esc(fin(st[key][i]) ? fmtY(st[key][i]) : '–')}</b><span class="end">${st.dist && fin(st.dist[i]) ? esc(km(st.dist[i])) : ''}</span>`;
    const good = st[key].filter(fin);
    const first = good.length ? `<span>Ø</span><b>${esc(fmtY(Core.mean(good)))}</b><span class="end">max. ${esc(fmtY(Math.max(...good)))}</span>` : '';
    return `<div class="card" style="margin-top:var(--s1)"><div class="card-h">${esc(label)}</div>${chartBox(Charts.curve(xs, st[key], Object.assign({ fmtY, fmtX: xFmt, cls, fill: true }, opt || {})), reader, first, 's')}</div>`;
  };
  h += curve('hr', 'Puls', (v) => nf0.format(v), 'c-hr');
  if (st.spd) {
    const pace = usesPace(a.type);
    // Tempo als min/km: Stillstand (unter 1 km/h) würde die Skala sprengen
    const vals = pace ? st.spd.map((v) => (fin(v) && v > 0.28 ? 1000 / v : null)) : st.spd.map((v) => (fin(v) ? v * 3.6 : null));
    const reader = (i) => `<span>${esc(hms(xs[i]))}</span><b>${esc(fin(vals[i]) ? (pace ? hms(vals[i]) + ' /km' : nf1.format(vals[i]) + ' km/h') : '–')}</b>`;
    h += `<div class="card" style="margin-top:var(--s1)"><div class="card-h">${pace ? 'Tempo' : 'Geschwindigkeit'}</div>${chartBox(Charts.curve(xs, vals, { fmtY: pace ? (v) => hms(v) : (v) => nf0.format(v), fmtX: xFmt, invert: pace, fill: !pace }), reader, '', 's')}</div>`;
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

  // Zwei Reiter: Schlafmuster (sleep.js) und die Zusammenhänge einzelner Paare; der Zeitraum gilt für beide
  let h = `<div class="seg top">${[['sleep', 'Schlaf'], ['pairs', 'Zusammenhänge']].map(([k, l]) => `<button class="${k === patTab ? 'on' : ''}" data-set="patTab:${k}">${l}</button>`).join('')}</div>`;
  h += `<div class="seg sm">${PAT_RANGES.map(([r, l]) => `<button class="${r === patRange ? 'on' : ''}" data-set="patRange:${r}">${l}</button>`).join('')}</div>`;
  if (patTab === 'sleep') {
    el.innerHTML = h + sleepPatternsHtml(from, t);
    const chips = $('.chips', el), on = $('.chip.on', el);
    if (chips && on) chips.scrollLeft = on.offsetLeft - chips.clientWidth / 2 + on.offsetWidth / 2;
    return;
  }

  const res = Core.insights(db, idx, from, t);
  const ok = res.filter((r) => r.enough).sort((a, b) => (b.solid - a.solid) || (Math.abs(b.r) - Math.abs(a.r)));
  const few = res.filter((r) => !r.enough);
  h += '<p class="note" style="margin:0 2px var(--s2)">Was hängt bei Dir womit zusammen? Die Tage werden nach der Ursache gedrittelt; verglichen wird das obere mit dem unteren Drittel. Oben steht, was am deutlichsten ist.</p>';
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

/* ── 10b. Schlafmuster ──────────────────────────────────────── */
/* Gerechnet in sleep.js. Oben der Steckbrief: Die Nächte werden nach einer
   Zielgröße gedrittelt, darunter steht, worin sich das obere vom unteren
   Drittel unterscheidet — am Tag davor, in der Nacht, danach. Dann Phasen,
   Unruhe und Wochentage. */

const PF_GROUPS = [['before', 'Am Tag davor'], ['night', 'In der Nacht'], ['after', 'Danach']];
const WEEKDAY_LONG = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
const pctTxt = (x) => nf0.format(x * 100) + '\u00a0%';
const signed = (r, s) => (r > 0 ? '+' : r < 0 ? '−' : '±') + s;
/** Mittel einer Kennzahl. Zählwerte immer mit einer Nachkommastelle — sonst stünde „2×“ neben „2,2×“. */
const meanFmt = (k, v) => ((M[k] || {}).count && fin(v) ? nf1.format(v) + M[k].unit : Core.fmt(k, v));

/** Wert einer Größe im Steckbrief: ja/nein als Anteil der Nächte, sonst wie die Kennzahl. */
function pfVal(f, v) {
  if (f.bin) return pctTxt(v);
  if (f.k === 'load') return nf0.format(v);
  if (f.k === 'napMin') return Core.fmtDur(v * 60);
  return meanFmt(f.k, v);
}
/** Unterschied. Anteile und Prozentwerte in Prozentpunkten — „+12 %" sähe
    nach einer relativen Änderung aus. */
function pfDelta(f, d) {
  const r = Math.round(f.bin ? d * 100 : d);
  if (f.bin || (M[f.k] || {}).unit === '%') return signed(r, nf0.format(Math.abs(r)) + ' Pkt.');
  if (f.k === 'load') return signed(r, nf0.format(Math.abs(r)));
  if (f.k === 'napMin') return signed(r, Core.fmtDur(Math.abs(r) * 60));
  return Core.fmtDelta(f.k, d);
}

function sleepPatternsHtml(from, t) {
  const tgs = Sleep.targets(db, idx, from, t);
  let h = '<p class="note" style="margin:0 2px var(--s2)">Was Deine Nächte prägt: worin sich unruhige von ruhigen Nächten unterscheiden, wovon Tief- und REM-Schlaf abhängen und wann in der Nacht die Unruhe kommt.</p>';
  if (!tgs.length) {
    h += `<div class="empty"><h2>Noch zu wenig Nächte</h2><p>Der Vergleich der Nächte braucht mindestens ${Sleep.MIN_NIGHTS} im Zeitraum. Ein längerer Zeitraum oder mehr Verlauf hilft.</p></div>`;
  } else {
    if (!tgs.some((x) => x.k === sleepTarget)) sleepTarget = tgs[0].k;
    h += '<div class="sec-h">Was Deine Nächte unterscheidet</div>';
    h += `<div class="chips">${tgs.map((x) => `<button class="chip${x.k === sleepTarget ? ' on' : ''}" data-set="sleepTarget:${x.k}">${esc(x.label)}</button>`).join('')}</div>`;
    h += profileHtml(Sleep.profile(db, idx, sleepTarget, from, t));
  }
  return h + coffeeHtml(from, t) + phasesHtml(from, t) + unrestHtml(from, t) + nightWeekHtml(from, t);
}

/** Kaffee und Schlaf (Sleep.coffee): spätes gegen frühes Drittel der Tage
    nach der Uhrzeit der letzten Tasse, jeweils die Nacht danach; dazu Tage
    ohne gegen Tage mit Kaffee. */
function coffeeHtml(from, t) {
  const c = Sleep.coffee(db, idx, from, t);
  let h = '<div class="sec-h" id="cofSec">Kaffee</div>';
  const need = Sleep.MIN_NIGHTS;
  if (!c.logged) {
    return h + `<button class="card cof-empty" data-coffee="${Core.today()}"><span class="cof-ic">${ICON.coffee}</span><span class="grow">Trag auf Heute unter <b>Letzter Kaffee</b> ein, wann Du zuletzt Kaffee getrunken hast. Ab ${need} Tagen mit einer Nacht danach zeigt die App hier, ob späte Tassen Deinen Schlaf verändern.</span>${ICON.chev}</button>`;
  }
  // Größe der Nacht wie im Steckbrief: Wert, Unterschied, Farbe nur bei klarer Richtung
  const f = (o) => ({ k: o.k });
  const tbl = (rows, hiS, loS) => `<table class="pf-t"><thead><tr><th></th><th>${hiS}</th><th>${loS}</th><th>Unterschied</th></tr></thead><tbody>${rows.map((r) => {
    const dir = (M[r.o.k] || {}).dir || 0;
    const st = !r.solid || !dir ? '' : r.diff * dir > 0 ? 'good' : 'warn';
    return `<tr${r.solid ? '' : ' class="dim"'}><td>${esc(r.o.label)}</td><td>${esc(pfVal(f(r.o), r.mH))}</td><td>${esc(pfVal(f(r.o), r.mL))}</td><td${st ? ` class="st-${st}"` : ''}>${esc(pfDelta(f(r.o), r.diff))}</td></tr>`;
  }).join('')}</tbody></table>`;
  const top = (rows, lead) => {
    const s = rows.filter((r) => r.solid).slice(0, 3);
    return s.length ? `<div class="pf-lead">${esc(lead)}</div><div class="pf-top">${s.map((r) => `<div><b>${esc(r.diff > 0 ? r.o.more : r.o.less)}</b><span>${esc(pfVal(f(r.o), r.mH))} statt ${esc(pfVal(f(r.o), r.mL))}</span></div>`).join('')}</div>` : '';
  };

  if (!c.enough) {
    const pct = Math.min(100, Math.round((c.n / need) * 100));
    h += `<div class="card"><div class="card-h">Später gegen früher Kaffee<span class="muted">${nf0.format(c.n)} von ${need} Tagen</span></div>
      <div class="meter"><i style="width:${pct}%"></i></div>
      <p class="note">Gezählt werden Tage mit eingetragener Uhrzeit, auf die eine Nacht mit Schlafdaten folgt.${c.n ? ` Bisher im Schnitt zuletzt um ${esc(Core.fmtClock(Core.mean(c.pts.map((p) => p.y))))} Uhr.` : ''} Für den Vergleich braucht es ${need}, davon mindestens ${Sleep.MIN_GROUP} späte und ${Sleep.MIN_GROUP} frühe.</p></div>`;
  } else {
    const box = (cut, name, n, g) => `<div><b class="num">${cut}</b><span>${name}<br>${nf0.format(n)} Nächte${fin(g) ? `<br>${esc(Core.fmtDur(g * 60))} vor dem Schlaf` : ''}</span></div>`;
    h += `<div class="card pf"><div class="vs">${box('ab ' + esc(Core.fmtClock(c.cutHi)), 'Später Kaffee', c.nHi, c.gapHi)}${box('bis ' + esc(Core.fmtClock(c.cutLo)), 'Früher Kaffee', c.nLo, c.gapLo)}</div>`;
    h += top(c.rows, 'Nach spätem Kaffee am deutlichsten anders')
      || '<p class="note">Nach spätem Kaffee schläfst Du im Zeitraum nicht so deutlich anders als nach frühem, dass es kein Zufall sein könnte.</p>';
    h += tbl(c.rows, 'spät', 'früh');
    const sc = c.pts.map((p) => ({ x: p.y, y: Sleep.val(db, idx, 'slpScore', p.d) })).filter((p) => fin(p.y));
    if (sc.length >= 10) {
      h += openScatter.has('coffee')
        ? `<div class="chart">${Charts.scatter(sc, { fmtX: (v) => Core.fmtClock(v), fmtY: (v) => nf0.format(v), fit: true, xLo: c.cutLo, xHi: c.cutHi, xLabel: 'Letzter Kaffee' })}</div>
           <button class="link" data-scatter="coffee">Punkte ausblenden</button>`
        : '<button class="link" data-scatter="coffee">Schlafscore nach Uhrzeit als Punkte zeigen</button>';
    }
    h += '<p class="note">Verglichen wird das Drittel der Tage mit dem spätesten letzten Kaffee mit dem Drittel mit dem frühesten, jeweils die Nacht danach; bei Gleichstand sind die Gruppen etwas größer. Koffein wird im Mittel in etwa fünf Stunden zur Hälfte abgebaut, deshalb steht dabei, wie lange die letzte Tasse meist vor dem Einschlafen lag (Median). Ein Unterschied ist noch keine Ursache: Wer spät Kaffee trinkt, ist vielleicht auch sonst länger auf.</p></div>';
  }

  if (c.none) {
    h += `<div class="card pf"><div class="card-h">Ohne gegen mit Kaffee<span class="muted">${nf0.format(c.nNone)} gegen ${nf0.format(c.n)} Nächte</span></div>`;
    h += top(c.none, 'Nach Tagen ohne Kaffee am deutlichsten anders')
      || '<p class="note">Nach Tagen ohne Kaffee schläfst Du im Zeitraum nicht deutlich anders als nach Tagen mit.</p>';
    h += tbl(c.none, 'ohne', 'mit') + '</div>';
  }
  return h;
}

/** Steckbrief: obere gegen untere Nächte, die deutlichsten Unterschiede
    zuerst, darunter alle deutlichen nach Tag davor / Nacht / danach. */
function profileHtml(p) {
  const tg = p.target;
  if (!p.enough) return `<div class="card"><p class="note" style="margin:0">Für diesen Vergleich fehlen noch Nächte (${p.n} von mindestens ${Sleep.MIN_NIGHTS}, je Gruppe 6).</p></div>`;
  const box = (hi) => {
    const n = hi ? p.nHi : p.nLo, name = hi ? tg.hi : tg.lo;
    if (tg.bin) return `<div><b>${nf0.format(n)}<small> Nächte</small></b><span>${esc(name)}<br>${hi ? 'Garmin: mittel oder schwach' : 'Garmin: gut oder besser'}</span></div>`;
    const cut = hi ? `ab ${Core.fmt(tg.k, p.cutHi)}` : `bis ${Core.fmt(tg.k, p.cutLo)}`;
    return `<div><b>Ø ${esc(meanFmt(tg.k, hi ? p.yHi : p.yLo))}</b><span>${esc(name)}<br>${esc(cut)} · ${nf0.format(n)} Nächte</span></div>`;
  };
  let h = `<div class="card pf"><div class="vs">${box(true)}${box(false)}</div>`;
  const top = Sleep.headline(p, 3);
  if (top.length) {
    h += `<div class="pf-lead">${esc(tg.hi)}: am deutlichsten anders</div><div class="pf-top">${top.map((r) => `<div><b>${esc(r.diff > 0 ? r.f.more : r.f.less)}</b><span>${esc(pfVal(r.f, r.mH))} statt ${esc(pfVal(r.f, r.mL))}</span></div>`).join('')}</div>`;
  } else {
    h += '<p class="note">Am Tag davor und in der Nacht selbst unterscheidet sich im Zeitraum nichts so deutlich, dass es kein Zufall sein könnte.</p>';
  }
  const shown = p.rows.filter((r) => pfAll || r.solid);
  if (shown.length) {
    h += `<table class="pf-t"><thead><tr><th></th><th>${esc(tg.hiS)}</th><th>${esc(tg.loS)}</th><th>Unterschied</th></tr></thead><tbody>`;
    for (const [g, gl] of PF_GROUPS) {
      const rs = shown.filter((r) => r.f.g === g);
      if (!rs.length) continue;
      h += `<tr class="pf-g"><td colspan="4">${gl}</td></tr>`;
      for (const r of rs) {
        // Farbe nur, wo „mehr" klar besser oder schlechter ist
        const dir = r.f.k === 'restlBad' ? -1 : (M[r.f.k] || {}).dir || 0;
        const st = !r.solid || !dir ? '' : r.diff * dir > 0 ? 'good' : 'warn';
        h += `<tr${r.solid ? '' : ' class="dim"'}><td>${esc(r.f.label)}</td><td>${esc(pfVal(r.f, r.mH))}</td><td>${esc(pfVal(r.f, r.mL))}</td><td${st ? ` class="st-${st}"` : ''}>${esc(pfDelta(r.f, r.diff))}</td></tr>`;
      }
    }
    h += '</tbody></table>';
  }
  const weak = p.rows.filter((r) => !r.solid).length;
  if (weak) h += `<button class="link" data-action="pfAll">${pfAll ? 'Nur deutliche Unterschiede zeigen' : `${weak} weitere Größen ohne deutlichen Unterschied zeigen`}</button>`;
  h += `<p class="note">${tg.bin ? 'Verglichen werden die Nächte, deren Unruhe Garmin mittel oder schwach bewertet, mit den übrigen.' : 'Verglichen wird das Drittel Deiner Nächte mit den höchsten Werten mit dem Drittel mit den niedrigsten; bei Gleichstand sind die Gruppen etwas größer.'} Gezeigt ist, was sich deutlich unterscheidet — mit einer strengeren Grenze als bei den Zusammenhängen, weil ${p.rows.length} Größen auf einmal geprüft werden. „Danach“ ist der folgende Tag. Ein Unterschied ist noch keine Ursache.</p></div>`;
  return h;
}

/** Phasen über viele Nächte: was eine Stunde mehr Schlaf bringt und wie oft
    jede Phase in Garmins Idealbereich lag. */
function phasesHtml(from, t) {
  const g = Sleep.phaseGain(db, from, t);
  const id = Sleep.ideal(db, (db.profile.sleep || {}).opt, from, t);
  if (!(g && g.deep && g.light && g.rem) && !id) return '';
  const ks = ['deep', 'light', 'rem'];
  const mins = (v) => signed(Math.round(v), nf0.format(Math.abs(Math.round(v))) + ' min');
  let h = '<div class="sec-h">Phasen</div>';
  if (g && g.deep && g.light && g.rem) {
    const tot = ks.reduce((s, k) => s + Math.max(0, g[k].slope), 0) || 1;
    h += `<div class="card"><div class="card-h">Eine Stunde mehr Schlaf<span class="muted">${nf0.format(g.n)} Nächte</span></div>`;
    // Gestapelt nur, wenn keine Phase mit mehr Schlaf weniger wird — negative Teile lassen sich nicht stapeln
    if (ks.every((k) => g[k].slope >= 0)) h += `<div class="phases">${ks.map((k) => `<i class="ph-${k}" style="width:${(g[k].slope / tot) * 100}%"></i>`).join('')}</div>`;
    h += `<div class="legend">${ks.map((k) => `<span><i class="ph-${k}"></i>${PHASE_LABEL[k]} <b>${esc(mins(g[k].slope))}</b></span>`).join('')}${g.awake ? `<span><i class="ph-awake"></i>dazu wach <b>${esc(mins(g.awake.slope))}</b></span>` : ''}</div>`;
    const m = g.most;
    h += m
      ? `<p class="note">Kurze Nächte kosten Dich vor allem ${PHASE_LABEL[m.k]}: Eine Stunde weniger Schlaf sind etwa ${nf0.format(g[m.k].slope)} min weniger davon, obwohl er sonst nur ${nf0.format(g[m.k].share)} % Deines Schlafs ausmacht.</p>`
      : '<p class="note">Eine Stunde mehr Schlaf verteilt sich bei Dir etwa so auf die Phasen wie Dein Schlaf sonst.</p>';
    h += '<p class="note">Gerechnet über alle Nächte im Zeitraum: Wie viel mehr jeder Phase hattest Du in Nächten, die eine Stunde länger waren?</p></div>';
  }
  if (id) {
    h += '<div class="card"><div class="card-h">Wie oft im Idealbereich<span class="muted">laut Garmin</span></div>';
    for (const k of ks) {
      const c = id[k];
      if (!c) continue;
      const w = (x) => (x / c.n) * 100;
      h += `<div class="rg-row"><div class="rg-h"><b>${PHASE_LABEL[k]}</b><span class="muted">${nf0.format(c.opt[0])}–${nf0.format(c.opt[1])} %</span><span class="rg-v">${nf0.format(w(c.in))} % der Nächte</span></div>
        <div class="rg">${['lo', 'in', 'hi'].map((z) => (c[z] ? `<i class="rg-${z}" style="width:${w(c[z])}%"></i>` : '')).join('')}</div></div>`;
    }
    h += '<div class="legend" style="margin-top:var(--s1)"><span><i class="rg-lo"></i>darunter</span><span><i class="rg-in"></i>im Bereich</span><span><i class="rg-hi"></i>darüber</span></div>';
    const short = ['deep', 'rem'].filter((k) => id[k]).sort((a, b) => id[b].lo / id[b].n - id[a].lo / id[a].n)[0];
    if (short && id[short].lo / id[short].n >= 0.4) {
      h += `<p class="note">${PHASE_LABEL[short]} liegt in ${pctTxt(id[short].lo / id[short].n)} der Nächte unter Garmins Bereich. Wovon das bei Dir abhängt, zeigt oben der Vergleich „${short === 'deep' ? 'Tiefschlaf' : 'REM-Schlaf'}“.</p>`;
    }
    h += '<p class="note">Garmins Bereiche stammen aus der neuesten Nacht und gelten hier für den ganzen Zeitraum.</p></div>';
  }
  return h;
}

/** Unruhe über viele Nächte: wie oft aufgewacht, Garmins Bewertung, ob
    unruhige Nächte gehäuft kommen und in welcher Stunde der Nacht die
    Pulsspitzen liegen. */
function unrestHtml(from, t) {
  const u = Sleep.unrest(db, idx, from, t);
  const hs = u.hours;
  let h = '<div class="sec-h">Unruhe</div>';
  if (u.awake) {
    const a = u.awake;
    const items = a.hist.map((c, i) => ({ label: i === 5 ? '5+' : String(i), v: (c / a.n) * 100 }));
    const often = a.hist.slice(3).reduce((s, c) => s + c, 0) / a.n;
    h += `<div class="card trend-bars"><div class="card-h">Aufgewacht pro Nacht<span class="muted">Ø ${esc(meanFmt('awakeN', a.avg))} · ${nf0.format(a.n)} Nächte</span></div>
      ${Charts.bars(items, { fmtY: (v) => nf0.format(v) + ' %', values: true, noAxis: true, h: 110 })}
      <p class="note">Anteil der Nächte nach Zahl der Aufwacher. In ${pctTxt(often)} der Nächte bist Du dreimal oder öfter aufgewacht.</p>`;
    const s = u.streak;
    if (s) {
      h += `<div class="ins-h" style="margin-top:var(--s2)"><span class="badge ${s.solid ? 'deutlich' : ''}">${s.solid ? (s.pA > s.pB ? 'kommen gehäuft' : 'folgen selten aufeinander') : 'eher Zufall'}</span></div>
        <div class="ins-t">Nach einer unruhigen Nacht (ab ${esc(Core.fmt('awakeN', s.cut))} aufgewacht) war die nächste in ${pctTxt(s.pA)} der Fälle wieder unruhig, nach anderen Nächten in ${pctTxt(s.pB)}.</div>`;
      if (s.solid && s.pA > s.pB) h += '<p class="note">Unruhige Nächte kommen bei Dir in Serien. Oft steckt dann eine Phase dahinter — Stress, ein Infekt, viel Training — und nicht die einzelne Nacht.</p>';
    }
    h += '</div>';
  }
  if (u.garmin) {
    const { q, n } = u.garmin;
    h += `<div class="card"><div class="card-h">Garmins Bewertung der Unruhe<span class="muted">${nf0.format(n)} Nächte</span></div>
      <div class="phases">${'EGFP'.split('').map((c) => (q[c] ? `<i class="q-${c}" style="width:${(q[c] / n) * 100}%"></i>` : '')).join('')}</div>
      <div class="legend">${'EGFP'.split('').filter((c) => q[c]).map((c) => `<span><i class="q-${c}"></i>${Q_WORD[c]} <b>${pctTxt(q[c] / n)}</b></span>`).join('')}</div></div>`;
  }
  h += `<div class="card"><div class="card-h">Pulsspitzen je Nachtstunde${hs.nights ? `<span class="muted">${nf0.format(hs.nights)} Nächte</span>` : ''}</div>`;
  if (hs.nights >= 10 && hs.hours.length >= 3) {
    const items = hs.hours.map((x) => ({ label: `${x.h + 1}.`, v: x.rate, cur: !!hs.peak && x.h === hs.peak.h }));
    const avg = Core.mean(Core.series(db, idx, 'rm', from, t).filter(fin));
    h += Charts.bars(items, { fmtY: (v) => nf1.format(v), values: true, noAxis: true, h: 110 });
    h += `<p class="note">Pulsspitzen je Nacht in der 1., 2., 3. … Stunde nach dem Einschlafen, im Schnitt ${esc(meanFmt('rm', avg))} pro Nacht.${hs.peak ? ` Am unruhigsten ist bei Dir die ${hs.peak.h + 1}. Stunde.` : ''} Eine Stunde zählt nur für die Nächte, die so lang waren.</p>`;
  } else {
    h += `<p class="note" style="margin:0">Pulsspitzen gibt es bisher für ${nf0.format(hs.nights)} ${hs.nights === 1 ? 'Nacht' : 'Nächte'} im Zeitraum. Die App wertet bei jedem Abgleich bis zu ${NIGHT_BATCH} weitere der letzten ${NIGHT_BACK} Tage aus, dazu jede Nacht, die Du öffnest. Ab 10 Nächten steht hier, wann in der Nacht die Unruhe kommt.</p>`;
  }
  return h + '</div>';
}

/** Nächte nach Wochentag als Tabelle, jede Zelle gegen Dein Mittel im
    Zeitraum. Gefärbt wird erst, wenn der Unterschied größer ist als das, was
    bei so wenigen Nächten je Wochentag ohnehin schwankt. */
function nightWeekHtml(from, t) {
  const COLS = [
    ['slpScore', 'Score', (v) => nf0.format(v)],
    ['slp', 'Dauer', (v) => splitVal('slp', v)[0]],
    ['deepPct', 'Tief', (v) => nf0.format(v) + '%'],
    ['remPct', 'REM', (v) => nf0.format(v) + '%'],
    ['awakeN', 'Wach', (v) => meanFmt('awakeN', v)],
  ];
  const cols = [];
  for (const [k, l, f] of COLS) {
    const prof = Core.weekdayProfile(db, idx, k, from, t);
    if (prof.some((p) => p.n < 3)) continue;
    const all = Core.series(db, idx, k, from, t).filter(fin);
    cols.push({ k, l, f, prof, mean: Core.mean(all), sd: Core.sd(all) || 0, dir: M[k].dir });
  }
  if (cols.length < 2) return '';
  const mark = (c, p) => {
    const lim = Math.max(0.25 * c.sd, (2 * c.sd) / Math.sqrt(p.n));
    const d = p.v - c.mean;
    return Math.abs(d) < lim ? 'ok' : d * c.dir > 0 ? 'good' : 'warn';
  };
  let h = `<div class="sec-h">Nach Wochentag<span class="muted">Mittel je Nacht</span></div><div class="card"><div class="wk-wrap"><table class="wk static"><thead><tr><th>Nacht auf</th>${cols.map((c) => `<th>${c.l}</th>`).join('')}</tr></thead><tbody>`;
  for (let i = 0; i < 7; i++) {
    h += `<tr><td>${['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'][i]}</td>`;
    for (const c of cols) {
      const p = c.prof[i];
      h += fin(p.v) ? `<td class="st-${mark(c, p)}">${esc(c.f(p.v))}</td>` : '<td class="na">–</td>';
    }
    h += '</tr>';
  }
  h += '</tbody></table></div>';
  const aw = cols.find((c) => c.k === 'awakeN');
  if (aw) {
    let w = 0;
    aw.prof.forEach((p, i) => { if (p.v > aw.prof[w].v) w = i; });
    if (mark(aw, aw.prof[w]) === 'warn') h += `<p class="note">Am unruhigsten sind bei Dir die Nächte auf ${WEEKDAY_LONG[w]}: Ø ${esc(meanFmt('awakeN', aw.prof[w].v))} aufgewacht, über alle Nächte Ø ${esc(meanFmt('awakeN', aw.mean))}.</p>`;
  }
  return h + '<p class="note">Farbig, wenn ein Wochentag deutlich besser oder schlechter ist als Dein Mittel. Die Nacht auf Samstag ist die von Freitag auf Samstag.</p></div>';
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
    ${db.sync.error ? `<div class="hint err" style="margin:0 0 var(--s2)">${ICON.warn}<div class="grow"><strong>Letzter Abgleich fehlgeschlagen</strong><span>${esc(db.sync.error)}</span></div></div>` : ''}
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
    <div class="btn-row" style="margin-top:var(--s2)">
      <button class="btn" id="btnSyncNow">Jetzt abgleichen</button>
      <button class="btn" id="btnReload">Alles neu laden</button>
    </div>

    <div class="sec-h">Darstellung</div>
    <div class="seg" id="setTheme">${Object.entries(THEMES).map(([k, v]) => `<button data-v="${k}" class="${db.theme === k ? 'on' : ''}">${v.label}</button>`).join('')}</div>

    <div class="sec-h">Sicherung</div>
    <p class="note" style="margin:0 2px var(--s2)">Die Daten liegen nur auf diesem Gerät. Garmin hat sie zwar auch — aber ein Jahr Verlauf neu zu laden dauert Minuten, und „Browserdaten löschen" nimmt alles mit. Ein Backup enthält Daten und Einstellungen, nicht den Schlüssel.${db.lastBackup ? ' Letztes Backup: ' + esc(dfDate.format(new Date(db.lastBackup))) + '.' : ''}</p>
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
    const cf = e.target.closest('[data-coffee]');
    if (cf) { openCoffee(cf.dataset.coffee); return; }
    if (e.target.closest('[data-coffee-now]')) { const v = nowMin(), d = Core.today(); setCoffee(d, v); render(); coffeeToast(d, v); return; }
    const fi = e.target.closest('[data-fitness]');
    if (fi) { openFitness(fi.dataset.fitness); return; }
    const dy = e.target.closest('[data-day]');
    if (dy) { dayView = dy.dataset.day === Core.today() ? null : dy.dataset.day; animNext = true; render(); armBack(); return; }
    const ds = e.target.closest('[data-daystep]');
    if (ds) {
      const cur = dayView || Core.today();
      const nd = Core.addDays(cur, +ds.dataset.daystep);
      dayView = nd >= Core.today() ? null : nd;
      animNext = true; render(); armBack(); return;
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
      else if (k === 'patTab') patTab = v;
      else if (k === 'sleepTarget') { sleepTarget = v; pfAll = false; }
      animNext = true; render(); return;
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
      else if (act === 'pfAll') { pfAll = !pfAll; render(); }
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
