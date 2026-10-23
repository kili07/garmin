'use strict';
/* ═══════════════════════════════════════════════════════════════
   Garmin-Übersicht — Schlafmuster

   Erkennt Muster im Schlaf. Reine Funktionen wie in core.js: kein DOM, kein
   Speicher, kein Netz — tests/sleep-test.js prüft sie in Node.

   Inhalt
   1. Eine Nacht: Pulsspitzen (unruhige Momente), ruhigste Strecke,
      Pulstiefpunkt und, wenn Garmin den Phasenverlauf mitschickt, der
      Aufbau der Nacht aus Zyklen
   2. Steckbrief über viele Nächte: Was unterscheidet unruhige von ruhigen
      Nächten, solche mit viel von solchen mit wenig Tief- oder REM-Schlaf?
   3. Phasen über die Schlafdauer, Idealbereich, Verteilung der Unruhe,
      Häufung unruhiger Nächte, Pulsspitzen nach Stunde der Nacht

   Baut auf Core auf (Datum, Statistik, value). Eigene Datei, weil der Teil
   eigenständig ist und über 300 Zeilen hat (Bauanleitung, Abschnitt 2).
   ═══════════════════════════════════════════════════════════════ */

const Sleep = ((Core) => {

const { fin, mean, sd, median, linreg, pearson, addDays, dateRange } = Core;

/* ── 1. Eine Nacht ──────────────────────────────────────────── */

/* Pulsspitzen: Der Puls springt im Schlaf kurz an, wenn der Körper halb
   aufwacht, sich umdreht oder kurz wach ist — meist ohne Erinnerung daran
   (Weckreaktion). Garmin liefert den Puls als Mittel über etwa zwei Minuten;
   ganz kurze Weckreaktionen gehen darin unter, längere und kurzes
   Wachsein bleiben deutlich sichtbar. Gemessen wird gegen den gleitenden
   Median, damit der langsame Verlauf der Nacht (fällt bis zur Mitte, steigt
   zum Morgen) nicht als Spitze zählt. */
const SPIKE = {
  win: 30,        // Median über ± 30 min
  edge: 10,       // die ersten und letzten 10 min nicht: Einschlafen und Aufwachen sind keine Unruhe
  merge: 6,       // Spitzen bis 6 min auseinander sind ein Moment
  min: 8,         // mindestens 8 Schläge über dem Median …
  k: 3.5,         // … und das 3,5-Fache des üblichen Rauschens dieser Nacht
};

/** Anteil der Nacht (in 5-Minuten-Stücken), für den Pulswerte da sind. */
function coverage(pts, len) {
  if (!(len > 0)) return 0;
  const bins = new Set();
  for (const [m] of pts || []) if (m >= 0 && m <= len) bins.add(Math.floor(m / 5));
  return Math.min(1, bins.size / (Math.floor(len / 5) + 1));
}

function spikes(hr, len) {
  const n = hr.length, base = new Array(n);
  let lo = 0, hi = 0;
  for (let i = 0; i < n; i++) {
    const m = hr[i][0];
    while (hr[lo][0] < m - SPIKE.win) lo++;
    while (hi < n && hr[hi][0] <= m + SPIKE.win) hi++;
    base[i] = median(hr.slice(lo, hi).map((p) => p[1]));
  }
  const res = hr.map((p, i) => p[1] - base[i]);
  // Rauschen als Median der Abweichungen — Spitzen selbst ziehen ihn kaum hoch
  const sigma = 1.4826 * median(res.map(Math.abs)) || 1;
  const thr = Math.max(SPIKE.min, SPIKE.k * sigma);
  const out = [];
  for (let i = 0; i < n; i++) {
    const m = hr[i][0];
    if (res[i] < thr || m < SPIKE.edge || m > len - SPIKE.edge) continue;
    const last = out[out.length - 1];
    if (last && m - last.b <= SPIKE.merge) {
      last.b = m;
      if (res[i] > last.up) { last.up = res[i]; last.at = m; last.hr = hr[i][1]; }
    } else {
      out.push({ a: m, b: m, at: m, up: res[i], hr: hr[i][1] });
    }
  }
  return out.map((s) => ({ a: s.a, b: s.b, at: s.at, up: Math.round(s.up), hr: Math.round(s.hr) }));
}

/** Wann der Puls am tiefsten war, geglättet über ± 15 min — ein einzelner
    tiefer Messwert soll nicht entscheiden. */
function hrLow(hr, len) {
  let lo = 0, hi = 0, s = 0, best = null;
  for (let i = 0; i < hr.length; i++) {
    const m = hr[i][0];
    while (hi < hr.length && hr[hi][0] <= m + 15) { s += hr[hi][1]; hi++; }
    while (hr[lo][0] < m - 15) { s -= hr[lo][1]; lo++; }
    const v = s / (hi - lo);
    if (!best || v < best.hr) best = { at: m, hr: v };
  }
  return best ? { at: best.at, pct: (best.at / len) * 100, hr: Math.round(best.hr) } : null;
}

/** Aufbau aus dem Phasenverlauf (0 Tief, 1 Leicht, 2 REM, 3 Wach). Üblich:
    Tiefschlaf vor allem in der ersten Nachthälfte, REM in der zweiten, vier
    bis sechs Zyklen, die jeweils mit einer REM-Phase enden. */
function structure(lv, len) {
  const half = len / 2;
  const part = (a, b, x, y) => Math.max(0, Math.min(b, y) - Math.max(a, x));
  let deep = 0, deep1 = 0, rem = 0, rem2 = 0;
  for (const [a, b, k] of lv) {
    if (k === 0) { deep += b - a; deep1 += part(a, b, 0, half); }
    if (k === 2) { rem += b - a; rem2 += part(a, b, half, len); }
  }
  const first = (k) => { const s = lv.find((l) => l[2] === k); return s ? s[0] : null; };
  // REM-Abschnitte mit weniger als 20 min dazwischen sind eine Episode
  let cycles = 0, lastRem = -Infinity;
  for (const [a, b, k] of lv) if (k === 2) { if (a - lastRem >= 20) cycles++; lastRem = b; }
  return {
    deepFirst: deep ? (deep1 / deep) * 100 : null,
    remLate: rem ? (rem2 / rem) * 100 : null,
    firstDeep: first(0), firstRem: first(2), cycles,
    // Wach mitten in der Nacht, nicht beim Einschlafen oder Aufwachen
    wakes: lv.filter(([a, b, k]) => k === 3 && a >= SPIKE.edge && b <= len - SPIKE.edge).map(([a, b]) => [a, b]),
  };
}

/** Längste Strecke ohne Pulsspitze und ohne Wachphase. */
function calmest(breaks, len) {
  let cur = 0, best = null;
  for (const [a, b] of breaks.slice().sort((x, y) => x[0] - y[0])) {
    if (!best || a - cur > best.dur) best = { a: cur, b: a, dur: a - cur };
    cur = Math.max(cur, b);
  }
  if (!best || len - cur > best.dur) best = { a: cur, b: len, dur: len - cur };
  return best;
}

/** Alles, was sich aus den Messreihen einer Nacht (Core.mapNight) erkennen
    lässt. Minuten zählen ab dem Einschlafen. */
function nightEvents(n) {
  if (!n || !(n.len > 0)) return null;
  const len = n.len;
  const hr = (n.hr || []).filter((p) => p[0] >= 0 && p[0] <= len);
  const ev = { len, cover: coverage(hr, len) };
  // Unter der halben Nacht mit Puls wäre jede Zählung zu niedrig
  if (hr.length >= 20 && ev.cover >= 0.5) {
    ev.spikes = spikes(hr, len);
    ev.low = hrLow(hr, len);
  }
  // Garmins eigene Zählung aus der Bewegung, falls die Antwort sie trägt
  if (Array.isArray(n.rmg) || fin(n.rmgN)) ev.garmin = { n: fin(n.rmgN) ? n.rmgN : n.rmg.length, at: n.rmg || [] };
  if (n.lv && n.lv.length) ev.struct = structure(n.lv, len);
  if (ev.spikes || ev.struct) {
    const breaks = (ev.spikes || []).map((s) => [s.a, s.b]).concat(ev.struct ? ev.struct.wakes : []);
    ev.calm = calmest(breaks, len);
  }
  return ev;
}

/* Was von einer Nacht für Muster über viele Nächte gebraucht wird. Landet in
   den Tageswerten (localStorage), deshalb klein: Zahl und Zeitpunkte der
   Pulsspitzen, Garmins Zählung, Lage des Pulstiefpunkts. `nv` setzt app.js
   (mit welcher Fassung ausgewertet). */
const NIGHT_FIELDS = ['rm', 'rmAt', 'rmG', 'hrLow', 'nv'];
function nightSummary(ev) {
  if (!ev) return {};
  return Core.clean({
    rm: ev.spikes ? ev.spikes.length : undefined,
    rmAt: ev.spikes && ev.spikes.length ? ev.spikes.map((s) => s.at) : undefined,
    rmG: ev.garmin ? ev.garmin.n : undefined,
    hrLow: ev.low ? Math.round(ev.low.pct) : undefined,
  });
}

/* ── 2. Steckbrief über viele Nächte ────────────────────────── */
/* Die Nächte werden nach einer Zielgröße gedrittelt (z. B. wie oft Du
   aufgewacht bist). Für jede andere Größe wird verglichen, wie sie im
   oberen und im unteren Drittel aussah: am Tag davor, in der Nacht selbst und
   danach. Übrig bleibt, was sich deutlich unterscheidet. Weil rund zwanzig
   Größen auf einmal geprüft werden, gilt eine strengere Schwelle als bei den
   Zusammenhängen in core.js: |t| ≥ 2,5 statt 2 — sonst stünde fast in jedem
   Steckbrief ein Zufallstreffer. */

const MIN_NIGHTS = 20, MIN_GROUP = 6, T_SOLID = 2.5;

/* Verglichene Größen. lag 1 = der Tag vor der Nacht (der Schlaf-Eintrag
   eines Tages ist die Nacht davor), lag 0 = die Nacht selbst bzw. der Tag
   danach. bin = ja/nein, verglichen als Anteil der Nächte. fam: Größen
   derselben Familie hängen schon per Definition zusammen (wer oft aufwacht,
   ist länger wach) — sie stehen in der Tabelle, aber nicht in der
   Zusammenfassung. */
const FACTORS = [
  { id: 'load', k: 'load', lag: 1, g: 'before', label: 'Belastung', more: 'Mehr Training am Vortag', less: 'Weniger Training am Vortag' },
  { id: 'late', k: 'late', lag: 1, g: 'before', bin: true, label: 'Abendtraining', more: 'Öfter Training am Abend davor', less: 'Seltener Training am Abend davor' },
  { id: 'stress1', k: 'stress', lag: 1, g: 'before', label: 'Stress', more: 'Mehr Stress am Vortag', less: 'Weniger Stress am Vortag' },
  { id: 'steps', k: 'steps', lag: 1, g: 'before', label: 'Schritte', more: 'Mehr Schritte am Vortag', less: 'Weniger Schritte am Vortag' },
  { id: 'nap', k: 'napMin', lag: 1, g: 'before', label: 'Nickerchen', more: 'Längere Nickerchen am Vortag', less: 'Kürzere Nickerchen am Vortag' },
  { id: 'debt', k: 'debt', lag: 1, g: 'before', label: 'Schlafsaldo', more: 'Weniger Schlafmangel davor', less: 'Mehr Schlafmangel davor' },
  { id: 'bed', k: 'bed', lag: 0, g: 'night', label: 'Eingeschlafen', more: 'Später eingeschlafen', less: 'Früher eingeschlafen' },
  { id: 'slp', k: 'slp', lag: 0, g: 'night', label: 'Schlafdauer', more: 'Länger geschlafen', less: 'Kürzer geschlafen' },
  { id: 'wkend', k: 'wkend', lag: 0, g: 'night', bin: true, label: 'Wochenende', more: 'Öfter Nächte aufs Wochenende', less: 'Öfter Nächte unter der Woche' },
  { id: 'slpHr', k: 'slpHr', lag: 0, g: 'night', label: 'Puls', more: 'Höherer Puls im Schlaf', less: 'Niedrigerer Puls im Schlaf' },
  { id: 'hrLow', k: 'hrLow', lag: 0, g: 'night', fam: 'hr', label: 'Pulstiefpunkt', more: 'Tiefster Puls später in der Nacht', less: 'Tiefster Puls früher in der Nacht' },
  { id: 'hrv', k: 'hrv', lag: 0, g: 'night', label: 'HRV', more: 'Höhere HRV', less: 'Niedrigere HRV' },
  { id: 'slpStress', k: 'slpStress', lag: 0, g: 'night', label: 'Stress', more: 'Mehr Stress im Schlaf', less: 'Weniger Stress im Schlaf' },
  { id: 'slpResp', k: 'slpResp', lag: 0, g: 'night', label: 'Atmung', more: 'Schneller geatmet', less: 'Langsamer geatmet' },
  { id: 'awakeN', k: 'awakeN', lag: 0, g: 'night', fam: 'unrest', label: 'Aufgewacht', more: 'Öfter aufgewacht', less: 'Seltener aufgewacht' },
  { id: 'awake', k: 'awake', lag: 0, g: 'night', fam: 'unrest', label: 'Wachzeit', more: 'Länger wach gelegen', less: 'Kürzer wach gelegen' },
  { id: 'rm', k: 'rm', lag: 0, g: 'night', fam: 'unrest', label: 'Pulsspitzen', more: 'Mehr Pulsspitzen', less: 'Weniger Pulsspitzen' },
  { id: 'rmG', k: 'rmG', lag: 0, g: 'night', fam: 'unrest', label: 'Unruhige Momente', more: 'Mehr unruhige Momente', less: 'Weniger unruhige Momente' },
  { id: 'restlBad', k: 'restlBad', lag: 0, g: 'night', fam: 'unrest', bin: true, label: 'Unruhig laut Garmin', more: 'Öfter unruhig laut Garmin', less: 'Seltener unruhig laut Garmin' },
  { id: 'deepPct', k: 'deepPct', lag: 0, g: 'night', fam: 'phase', label: 'Tiefschlaf', more: 'Mehr Tiefschlaf', less: 'Weniger Tiefschlaf' },
  { id: 'remPct', k: 'remPct', lag: 0, g: 'night', fam: 'phase', label: 'REM-Schlaf', more: 'Mehr REM-Schlaf', less: 'Weniger REM-Schlaf' },
  { id: 'rhr', k: 'rhr', lag: 0, g: 'after', label: 'Ruhepuls', more: 'Höherer Ruhepuls', less: 'Niedrigerer Ruhepuls' },
  { id: 'bbMax', k: 'bbMax', lag: 0, g: 'after', label: 'Body Battery', more: 'Mehr Body Battery am Morgen', less: 'Weniger Body Battery am Morgen' },
  { id: 'stress0', k: 'stress', lag: 0, g: 'after', label: 'Stress', more: 'Mehr Stress am Tag danach', less: 'Weniger Stress am Tag danach' },
];

/* Wonach gedrittelt wird. hi/lo: Namen der beiden Gruppen. */
const TARGETS = [
  { k: 'awakeN', fam: 'unrest', label: 'Aufwachen', hi: 'Unruhige Nächte', lo: 'Ruhige Nächte', hiS: 'unruhig', loS: 'ruhig' },
  { k: 'rmG', fam: 'unrest', label: 'Unruhige Momente', hi: 'Viele unruhige Momente', lo: 'Wenige unruhige Momente', hiS: 'viele', loS: 'wenige' },
  { k: 'rm', fam: 'unrest', label: 'Pulsspitzen', hi: 'Viele Pulsspitzen', lo: 'Wenige Pulsspitzen', hiS: 'viele', loS: 'wenige' },
  { k: 'restlBad', fam: 'unrest', bin: true, label: 'Unruhe laut Garmin', hi: 'Unruhig laut Garmin', lo: 'Ruhig laut Garmin', hiS: 'unruhig', loS: 'ruhig' },
  { k: 'awake', fam: 'unrest', label: 'Wachzeit', hi: 'Lange wach gelegen', lo: 'Kaum wach gelegen', hiS: 'lange wach', loS: 'kaum wach' },
  { k: 'deepPct', fam: 'phase', label: 'Tiefschlaf', hi: 'Viel Tiefschlaf', lo: 'Wenig Tiefschlaf', hiS: 'viel', loS: 'wenig' },
  { k: 'remPct', fam: 'phase', label: 'REM-Schlaf', hi: 'Viel REM-Schlaf', lo: 'Wenig REM-Schlaf', hiS: 'viel', loS: 'wenig' },
  { k: 'hrLow', fam: 'hr', label: 'Pulstiefpunkt', hi: 'Später Pulstiefpunkt', lo: 'Früher Pulstiefpunkt', hiS: 'spät', loS: 'früh' },
];

/** Wert einer Größe an einem Tag: was Core.value kennt, dazu drei Größen,
    die nur hier gebraucht werden. */
function val(db, idx, key, date) {
  const d = (db.days || {})[date];
  switch (key) {
    // Garmins Teilbewertung „Unruhe" mittel oder schwach
    case 'restlBad': { const q = Core.sleepPart(d && d.sq, 'restl'); return q ? (q === 'F' || q === 'P' ? 1 : 0) : undefined; }
    // Kein Nickerchen ist 0 — aber nur an Tagen, von denen es Schlafdaten gibt
    case 'napMin': return d && fin(d.slp) ? (d.nap || 0) / 60 : undefined;
    // Nacht auf Samstag oder Sonntag
    case 'wkend': return d && fin(d.slp) ? (Core.weekday(date) >= 5 ? 1 : 0) : undefined;
    default: return Core.value(db, idx, key, date);
  }
}

/** Nächte nach der Zielgröße ins obere und untere Drittel. Bei Zählwerten
    (einmal, zweimal aufgewacht) gibt es viele Gleichstände — die bleiben
    beisammen, dann sind die Gruppen eben etwas größer als ein Drittel. */
function split(pts, bin) {
  let hi, lo;
  if (bin) {
    hi = pts.filter((p) => p.y > 0); lo = pts.filter((p) => !(p.y > 0));
  } else {
    const ys = pts.map((p) => p.y).sort((a, b) => a - b), n = ys.length;
    const a = ys[Math.floor((n - 1) / 3)], b = ys[Math.ceil((2 * (n - 1)) / 3)];
    if (a < b) { lo = pts.filter((p) => p.y <= a); hi = pts.filter((p) => p.y >= b); }
    else { lo = pts.filter((p) => p.y < a); hi = pts.filter((p) => p.y > a); }
  }
  return {
    hi, lo,
    cutHi: !bin && hi.length ? Math.min(...hi.map((p) => p.y)) : null,
    cutLo: !bin && lo.length ? Math.max(...lo.map((p) => p.y)) : null,
  };
}

/** Zwei Gruppen vergleichen: Welch-t für Messwerte, z-Wert zweier Anteile
    für ja/nein. Beides ist ab etwa |2| selten Zufall. */
function compare(h, l, bin) {
  const mH = mean(h), mL = mean(l);
  let se;
  if (bin) {
    const p = (mH * h.length + mL * l.length) / (h.length + l.length);
    se = Math.sqrt(p * (1 - p) * (1 / h.length + 1 / l.length));
  } else {
    const sH = sd(h), sL = sd(l);
    se = Math.sqrt((sH * sH) / h.length + (sL * sL) / l.length);
  }
  if (!se) return null;
  const t = (mH - mL) / se;
  return { nH: h.length, nL: l.length, mH, mL, diff: mH - mL, t, solid: Math.abs(t) >= T_SOLID };
}

function nightPoints(db, idx, key, from, to) {
  const pts = [];
  for (const d of dateRange(from, to)) { const y = val(db, idx, key, d); if (fin(y)) pts.push({ d, y }); }
  return pts;
}

/** Zielgrößen mit genug Nächten im Zeitraum. */
function targets(db, idx, from, to) {
  return TARGETS.filter((t) => {
    const pts = nightPoints(db, idx, t.k, from, to);
    if (pts.length < MIN_NIGHTS) return false;
    const s = split(pts, t.bin);
    return s.hi.length >= MIN_GROUP && s.lo.length >= MIN_GROUP;
  });
}

/** Steckbrief: obere gegen untere Nächte bei Zielgröße `tk`. */
function profile(db, idx, tk, from, to) {
  const tg = TARGETS.find((t) => t.k === tk);
  if (!tg) return null;
  const pts = nightPoints(db, idx, tk, from, to);
  const out = { target: tg, n: pts.length, enough: false };
  if (pts.length < MIN_NIGHTS) return out;
  const s = split(pts, tg.bin);
  if (s.hi.length < MIN_GROUP || s.lo.length < MIN_GROUP) return out;
  const rows = [];
  for (const f of FACTORS) {
    if (f.k === tk) continue;
    const xs = (grp) => grp.map((p) => val(db, idx, f.k, addDays(p.d, -f.lag))).filter(fin);
    const h = xs(s.hi), l = xs(s.lo);
    if (h.length < 5 || l.length < 5) continue;
    const c = compare(h, l, f.bin);
    if (c) rows.push(Object.assign({ f }, c));
  }
  rows.sort((a, b) => Math.abs(b.t) - Math.abs(a.t));
  return Object.assign(out, {
    enough: true, nHi: s.hi.length, nLo: s.lo.length, cutHi: s.cutHi, cutLo: s.cutLo,
    yHi: mean(s.hi.map((p) => p.y)), yLo: mean(s.lo.map((p) => p.y)), rows,
  });
}

/** Die deutlichsten Unterschiede für den Satz über der Tabelle: zuerst, was
    am Tag davor war (das lässt sich ändern), dann die Nacht selbst — ohne
    Größen, die mit der Zielgröße ohnehin zusammenhängen. */
function headline(p, max) {
  if (!p || !p.enough) return [];
  const ok = (r) => r.solid && !(r.f.fam && r.f.fam === p.target.fam);
  return p.rows.filter((r) => ok(r) && r.f.g === 'before')
    .concat(p.rows.filter((r) => ok(r) && r.f.g === 'night'))
    .slice(0, max || 3);
}

/* ── 3. Phasen, Idealbereich, Unruhe ────────────────────────── */

/** Was eine Stunde mehr Schlaf bringt: Steigung jeder Phase (Minuten) über
    der Schlafdauer (Stunden). Tief, Leicht und REM ergeben zusammen etwa
    60 min, weil Garmins Schlafzeit ihre Summe ist; die Wachzeit kommt dazu.
    Weil REM vor allem in den späten Zyklen liegt, kosten kurze Nächte
    meist überproportional REM. */
function phaseGain(db, from, to) {
  const rows = [];
  for (const d of dateRange(from, to)) {
    const x = (db.days || {})[d];
    if (x && x.slp > 0 && fin(x.deep) && fin(x.light) && fin(x.rem)) rows.push(x);
  }
  const hrs = rows.map((x) => x.slp / 3600);
  // Unter 20 min Streuung der Schlafdauer lässt sich keine Steigung ablesen
  if (rows.length < MIN_NIGHTS || sd(hrs) < 1 / 3) return null;
  const out = { n: rows.length };
  for (const k of ['deep', 'light', 'rem', 'awake']) {
    const pts = rows.filter((x) => fin(x[k]));
    if (pts.length < MIN_NIGHTS) continue;
    const xs = pts.map((x) => x.slp / 3600), ys = pts.map((x) => x[k] / 60);
    const lr = linreg(xs, ys), r = pearson(xs, ys) || 0, n = pts.length;
    if (!lr) continue;
    out[k] = {
      slope: lr.slope,
      share: k === 'awake' ? null : mean(pts.map((x) => x[k] / x.slp)) * 100,
      t: Math.abs(r) >= 1 ? 99 : r * Math.sqrt((n - 2) / (1 - r * r)),
    };
  }
  // Welche Phase bekommt von einer Stunde mehr deutlich mehr ab als ihr üblicher Anteil?
  let most = null;
  for (const k of ['deep', 'light', 'rem']) {
    const x = out[k];
    if (!x || Math.abs(x.t) < 2) continue;
    const extra = (x.slope / 60) * 100 - x.share;
    if (extra >= 5 && (!most || extra > most.extra)) most = { k, extra };
  }
  out.most = most;
  return out;
}

/** Wie oft der Anteil jeder Phase unter, in oder über Garmins Idealbereich lag. */
function ideal(db, opt, from, to) {
  if (!opt) return null;
  const out = {};
  for (const k of ['deep', 'light', 'rem']) {
    const o = opt[k];
    if (!o) continue;
    const c = { lo: 0, in: 0, hi: 0, n: 0, opt: o };
    for (const d of dateRange(from, to)) {
      const x = (db.days || {})[d];
      if (!x || !(x.slp > 0) || !fin(x[k])) continue;
      const p = (x[k] / x.slp) * 100;
      c[p < o[0] ? 'lo' : p > o[1] ? 'hi' : 'in']++;
      c.n++;
    }
    if (c.n >= 7) out[k] = c;
  }
  return Object.keys(out).length ? out : null;
}

/** Kommen unruhige Nächte gehäuft? Unruhig = oberes Drittel beim Aufwachen.
    Verglichen wird, wie oft auf eine unruhige Nacht wieder eine folgt und wie
    oft auf eine andere. Nur ein Vergleich, deshalb die übliche Schwelle 2. */
function persistence(db, idx, from, to) {
  const pts = nightPoints(db, idx, 'awakeN', from, to);
  if (pts.length < MIN_NIGHTS) return null;
  const s = split(pts, false);
  if (s.hi.length < MIN_GROUP || s.lo.length < MIN_GROUP) return null;
  const hiSet = new Set(s.hi.map((p) => p.d)), known = new Set(pts.map((p) => p.d));
  let nA = 0, kA = 0, nB = 0, kB = 0;
  for (const p of pts) {
    const prev = addDays(p.d, -1);
    if (!known.has(prev)) continue;
    if (hiSet.has(prev)) { nA++; if (hiSet.has(p.d)) kA++; } else { nB++; if (hiSet.has(p.d)) kB++; }
  }
  if (nA < MIN_GROUP || nB < MIN_GROUP) return null;
  const c = compare(new Array(nA).fill(0).fill(1, 0, kA), new Array(nB).fill(0).fill(1, 0, kB), true);
  return { cut: s.cutHi, nA, pA: kA / nA, nB, pB: kB / nB, t: c ? c.t : 0, solid: !!c && Math.abs(c.t) >= 2 };
}

/** Pulsspitzen nach Stunde seit dem Einschlafen, als Rate je Nacht: Eine
    Stunde zählt nur so weit, wie die Nacht sie erreicht hat — sonst sähen die
    späten Stunden ruhiger aus, nur weil viele Nächte vorher enden. */
function byHour(db, from, to) {
  const cnt = [], exp = [];
  let nights = 0;
  for (const d of dateRange(from, to)) {
    const x = (db.days || {})[d];
    if (!x || !fin(x.rm) || !fin(x.bed) || !fin(x.wake)) continue;
    const span = x.wake + 1440 - x.bed;
    if (!(span > 60 && span < 16 * 60)) continue;
    nights++;
    for (let h = 0; h * 60 < span; h++) {
      exp[h] = (exp[h] || 0) + Math.min(1, (span - h * 60) / 60);
      cnt[h] = cnt[h] || 0;
    }
    for (const m of Array.isArray(x.rmAt) ? x.rmAt : []) {
      const h = Math.floor(m / 60);
      if (fin(m) && h >= 0 && h < exp.length) cnt[h] = (cnt[h] || 0) + 1;
    }
  }
  const hours = [];
  for (let h = 0; h < exp.length; h++) if (exp[h] >= 5) hours.push({ h, n: cnt[h] || 0, exp: exp[h], rate: (cnt[h] || 0) / exp[h] });
  let peak = null;
  for (const x of hours) if (x.n && (!peak || x.rate > peak.rate)) peak = x;
  return { nights, hours, peak };
}

/** Unruhe im Zeitraum: Verteilung des Aufwachens, Garmins Bewertung,
    Häufung, Pulsspitzen nach Stunde der Nacht. */
function unrest(db, idx, from, to) {
  const hist = [0, 0, 0, 0, 0, 0], aw = [];
  const q = { E: 0, G: 0, F: 0, P: 0 };
  let qn = 0;
  for (const d of dateRange(from, to)) {
    const x = (db.days || {})[d];
    if (!x) continue;
    if (fin(x.awakeN)) { hist[Math.min(5, Math.max(0, Math.round(x.awakeN)))]++; aw.push(x.awakeN); }
    const r = Core.sleepPart(x.sq, 'restl');
    if (r) { q[r]++; qn++; }
  }
  return {
    awake: aw.length >= 7 ? { hist, n: aw.length, avg: mean(aw) } : null,
    garmin: qn >= 7 ? { q, n: qn } : null,
    streak: persistence(db, idx, from, to),
    hours: byHour(db, from, to),
  };
}

return {
  SPIKE, NIGHT_FIELDS, FACTORS, TARGETS, MIN_NIGHTS, T_SOLID,
  coverage, nightEvents, nightSummary,
  val, split, compare, targets, profile, headline,
  phaseGain, ideal, persistence, byHour, unrest,
};
})(typeof Core !== 'undefined' ? Core : require('./core.js'));

if (typeof module === 'object' && module.exports) module.exports = Sleep;
