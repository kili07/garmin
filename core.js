'use strict';
/* ═══════════════════════════════════════════════════════════════
   Garmin-Übersicht — Kernlogik ohne Oberfläche

   Alles hier ist reine Funktion: kein DOM, kein Speicher, kein Netz. Deshalb
   eigene Datei — tests/core-test.js lädt sie direkt in Node und prüft
   Umrechnung der Garmin-Antworten, Normalbereiche, Belastung und
   Zusammenhänge, ohne dass ein Browser laufen muss.

   Inhalt
   1. Datum
   2. Statistik
   3. Garmin-Antworten → Tageswerte und Aktivitäten
   4. Kennzahlen: Bezeichnung, Einheit, Formatierung, Richtung
   5. Index: Werte, die aus mehreren Quellen zusammenkommen
   6. Normalbereich und Bewertung
   7. Erholung heute
   8. Trainingsbelastung
   9. Zusammenhänge
   10. Auswertungen über Zeiträume
   ═══════════════════════════════════════════════════════════════ */

const Core = (() => {

/* ── 1. Datum ───────────────────────────────────────────────── */
/* Kalendertage sind überall Text 'YYYY-MM-DD'. Gerechnet wird über 12 Uhr
   mittags, damit die Zeitumstellung keinen Tag verschluckt oder verdoppelt. */

const DAY_MS = 86400000;
const pad = (n) => String(n).padStart(2, '0');

function isoDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function parseDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 12); }
function addDays(s, n) { const d = parseDate(s); d.setDate(d.getDate() + n); return isoDate(d); }
/** Tage von a bis b (positiv, wenn b später liegt). */
function dayDiff(a, b) { return Math.round((parseDate(b) - parseDate(a)) / DAY_MS); }
function today(now) { return isoDate(now || new Date()); }
function dateRange(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
/** Wochentag mit Montag = 0 — so zählt man hier, nicht wie getDay() ab Sonntag. */
function weekday(s) { return (parseDate(s).getDay() + 6) % 7; }
function weekStart(s) { return addDays(s, -weekday(s)); }
function monthKey(s) { return s.slice(0, 7); }

/** Zeitraum in Stücke zu höchstens maxDays Tagen, neueste zuerst — so steht
    beim Abruf das Wichtigste nach dem ersten Stück schon da. */
function chunks(from, to, maxDays) {
  const out = [];
  let end = to;
  while (end >= from) {
    let start = addDays(end, -(maxDays - 1));
    if (start < from) start = from;
    out.push([start, end]);
    end = addDays(start, -1);
  }
  return out;
}

/** Garmin liefert lokale Zeitpunkte mal als Text ohne Zone
    ("2026-10-22T23:14:00.0"), mal als Millisekunden, in denen die lokale
    Uhrzeit als UTC steckt. Beides wird hier zu Datum + Minuten seit
    Mitternacht. Eine angehängte Zone bei einem „Local"-Feld ist Unsinn und
    wird ignoriert — die Ziffern sind die Ortszeit. */
function localParts(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && isFinite(v)) {
    const d = new Date(v);
    return {
      date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
      min: d.getUTCHours() * 60 + d.getUTCMinutes(),
    };
  }
  const m = String(v).match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return null;
  return { date: m[1], min: m[2] ? +m[2] * 60 + +m[3] : 0 };
}

/* ── 2. Statistik ───────────────────────────────────────────── */

const fin = (v) => typeof v === 'number' && isFinite(v);
const sum = (a) => a.reduce((s, v) => s + v, 0);
const mean = (a) => (a.length ? sum(a) / a.length : null);
function sd(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(sum(a.map((v) => (v - m) * (v - m))) / (a.length - 1));
}
function quantile(a, q) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const p = (s.length - 1) * q;
  const lo = Math.floor(p), hi = Math.ceil(p);
  return s[lo] + (s[hi] - s[lo]) * (p - lo);
}
const median = (a) => quantile(a, 0.5);
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (!sxx || !syy) return null;
  return sxy / Math.sqrt(sxx * syy);
}
function linreg(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  if (!sxx) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx };
}
/** Gleitender Mittelwert über `win` Einträge rückwärts. Lücken (null) zählen
    nicht mit; ein Wert entsteht erst ab `minN` echten Werten im Fenster,
    sonst täuscht ein einzelner Tag einen Trend vor. */
function rolling(vals, win, minN) {
  const out = new Array(vals.length).fill(null);
  let s = 0, n = 0;
  for (let i = 0; i < vals.length; i++) {
    if (fin(vals[i])) { s += vals[i]; n++; }
    const j = i - win;
    if (j >= 0 && fin(vals[j])) { s -= vals[j]; n--; }
    if (n >= (minN || 1)) out[i] = s / n;
  }
  return out;
}

/* ── 3. Garmin-Antworten → Tageswerte und Aktivitäten ───────── */
/* Feldnamen laut OpenAPI-Beschreibung der Personal API
   (tests/fixtures/garmin-personal-openapi.json). Gespeichert wird nur, was
   die Übersicht braucht, unter kurzen Schlüsseln — fünf Jahre passen so
   bequem in localStorage. Fehlende Werte fehlen auch im Datensatz. */

const num = (v) => (v == null || v === '' ? undefined : (isFinite(+v) ? +v : undefined));

/** Nur die Felder mit echtem Wert übernehmen. */
function clean(o) {
  const out = {};
  for (const k in o) {
    const v = o[k];
    if (v === undefined || v === null || (typeof v === 'number' && !isFinite(v))) continue;
    if (Array.isArray(v) && !v.length) continue;
    out[k] = v;
  }
  return out;
}

/** UserDailySummaryV2DTO aus /usersummary-service/v2/dailysummaries */
function mapDaily(s) {
  if (!s || !s.calendarDate) return null;
  const mv = s.movement || {}, st = mv.steps || {}, cal = s.calories || {}, hr = s.heartRate || {};
  const im = s.intensityMinutes || {}, str = s.stress || {}, bb = s.bodyBattery || {};
  const resp = s.respiration || {}, ox = s.pulseOx || {};
  // Stress unter 0 heißt bei Garmin „keine Messung" (−1, −2)
  const stress = num(str.avgLevel);
  return {
    date: String(s.calendarDate).slice(0, 10),
    v: clean({
      steps: num(st.value), stepGoal: num(st.goal), dist: num(st.distanceInMeters),
      floors: num((mv.floorsAscended || {}).value),
      kcal: num(cal.burnedTotal), kcalAct: num(cal.burnedActive),
      rhr: num(hr.restingValue), hrMin: num(hr.minValue), hrMax: num(hr.maxValue),
      imMod: num(im.moderate), imVig: num(im.vigorous), imGoal: num(im.goal),
      stress: stress != null && stress >= 0 ? stress : undefined, stressMax: num(str.maxLevel),
      sRest: num(str.restProportion), sLow: num(str.lowStressProportion),
      sMed: num(str.mediumStressProportion), sHigh: num(str.highStressProportion),
      bbMax: num(bb.maxValue), bbMin: num(bb.minValue), bbChg: num(bb.chargedValue),
      bbDrn: num(bb.drainedValue), bbNow: num(bb.latestValue),
      resp: num(resp.avgValue), spo2: num(ox.avgValue),
    }),
  };
}

/** DailySleepDTO aus /sleep-service/sleep/dailySleepSummariesByDate.
    calendarDate ist der Morgen des Aufwachens — die Nacht davor. */
function mapSleep(s) {
  if (!s || !s.calendarDate) return null;
  const sc = (s.sleepScores && s.sleepScores.overall) || {};
  const start = localParts(s.sleepStartTimestampLocal), end = localParts(s.sleepEndTimestampLocal);
  const need = s.sleepNeed && num(s.sleepNeed.actual);
  const total = num(s.sleepTimeSeconds);
  return {
    date: String(s.calendarDate).slice(0, 10),
    v: clean({
      slp: total > 0 ? total : undefined,
      deep: num(s.deepSleepSeconds), light: num(s.lightSleepSeconds),
      rem: num(s.remSleepSeconds), awake: num(s.awakeSleepSeconds),
      nap: num(s.napTimeSeconds) || undefined,
      slpScore: num(sc.value), slpQ: sc.qualifierKey || undefined,
      // Einschlafen vor Mitternacht und danach auf einer Achse: 23:30 → 1410, 0:30 → 1470
      bed: start ? (start.min < 12 * 60 ? start.min + 1440 : start.min) : undefined,
      wake: end ? end.min : undefined,
      slpHr: num(s.avgHeartRate), slpStress: num(s.avgSleepStress),
      slpResp: num(s.averageRespirationValue), slpSpo2: num(s.averageSpO2Value),
      awakeN: num(s.awakeCount),
      // Schlafbedarf kommt in Minuten; ein Wert über 2000 kann nur Sekunden sein
      need: need ? (need > 2000 ? Math.round(need / 60) : need) : undefined,
    }),
  };
}

/** HrvSummaryDTO aus /hrv-service/hrv/daily/{from}/{to} */
function mapHrv(s) {
  if (!s || !s.calendarDate) return null;
  const b = s.baseline || {};
  return {
    date: String(s.calendarDate).slice(0, 10),
    v: clean({
      hrv: num(s.lastNightAvg), hrvWeek: num(s.weeklyAvg), hrv5: num(s.lastNight5MinHigh),
      hrvLo: num(b.balancedLow), hrvHi: num(b.balancedUpper),
      hrvSt: s.status && s.status !== 'NONE' ? s.status : undefined,
    }),
  };
}

/** DailyWeightSummary aus /weight-service/weight/range/{from}/{to} */
function mapWeight(s) {
  if (!s || !s.summaryDate) return null;
  const w = s.latestWeight || (s.allWeightMetrics || [])[0] || {};
  let kg = num(w.weight);
  // Die Doku sagt Kilogramm; Garmin Connect selbst rechnet intern in Gramm
  if (kg > 1000) kg = kg / 1000;
  return {
    date: String(s.summaryDate).slice(0, 10),
    v: clean({ weight: kg, fat: num(w.bodyFat), bmi: num(w.bmi), muscle: num(w.muscleMass) }),
  };
}

const SPLITS = [1000, 1609, 5000, 10000, 21098, 42195];

/** SummarizedActivityDTO aus /activitylist-service/activities/search/activities */
function mapActivity(a) {
  if (!a || a.activityId == null) return null;
  const t = a.activityType || {};
  const start = String(a.startTimeLocal || '');
  const zones = [1, 2, 3, 4, 5].map((i) => num(a['hrTimeInZone_' + i]) || 0);
  const best = {};
  for (const m of SPLITS) { const v = num(a['fastestSplit_' + m]); if (v > 0) best[m] = Math.round(v * 10) / 10; }
  return clean({
    id: a.activityId,
    name: a.activityName || '',
    type: t.typeKey || 'other',
    start: start.slice(0, 16),                    // 'YYYY-MM-DD HH:mm', Ortszeit
    date: start.slice(0, 10),
    dur: num(a.duration), mov: num(a.movingDuration),
    dist: num(a.distance) || undefined, gain: num(a.elevationGain),
    hr: num(a.averageHR), hrMax: num(a.maxHR), kcal: num(a.calories),
    spd: num(a.averageSpeed), gap: num(a.avgGradeAdjustedSpeed),
    cad: num(a.averageRunningCadenceInStepsPerMinute) || num(a.averageBikingCadenceInRevPerMinute),
    pwr: num(a.avgPower), np: num(a.normPower),
    te: num(a.aerobicTrainingEffect), teAn: num(a.anaerobicTrainingEffect),
    teL: a.trainingEffectLabel || undefined,
    load: num(a.activityTrainingLoad), vo2: num(a.vO2MaxValue) || undefined,
    z: zones.some((v) => v > 0) ? zones.map(Math.round) : undefined,
    best: Object.keys(best).length ? best : undefined,
    pr: a.isPR || a.pr || undefined,
    ev: (a.eventType && a.eventType.typeKey) || undefined,
    laps: num(a.lapCount), steps: num(a.steps) || undefined,
    loc: a.locationName || undefined,
    bb: num(a.differenceBodyBattery),
    parent: num(a.parentId),
    gps: a.hasPolyline || undefined,
  });
}

/** Neue Tageswerte in den Bestand mischen: Felder einer Quelle ersetzen,
    die anderer Quellen bleiben. Ein leerer Abruf löscht nichts. */
function mergeDay(days, rec, fields) {
  if (!rec || !rec.date) return;
  const d = days[rec.date] || (days[rec.date] = {});
  if (fields) for (const k of fields) delete d[k];
  Object.assign(d, rec.v);
  if (!Object.keys(d).length) delete days[rec.date];
}
const FIELDS = {
  daily: ['steps', 'stepGoal', 'dist', 'floors', 'kcal', 'kcalAct', 'rhr', 'hrMin', 'hrMax', 'imMod', 'imVig',
    'imGoal', 'stress', 'stressMax', 'sRest', 'sLow', 'sMed', 'sHigh', 'bbMax', 'bbMin', 'bbChg', 'bbDrn', 'bbNow',
    'resp', 'spo2'],
  sleep: ['slp', 'deep', 'light', 'rem', 'awake', 'nap', 'slpScore', 'slpQ', 'bed', 'wake', 'slpHr', 'slpStress',
    'slpResp', 'slpSpo2', 'awakeN', 'need'],
  hrv: ['hrv', 'hrvWeek', 'hrv5', 'hrvLo', 'hrvHi', 'hrvSt'],
  weight: ['weight', 'fat', 'bmi', 'muscle'],
};

/* ── 4. Kennzahlen ──────────────────────────────────────────── */
/* dir: +1 = mehr ist besser, −1 = weniger ist besser, 0 = keine Wertung.
   agg: wie Wochen und Monate zusammengefasst werden — Mittel pro Tag oder
   Summe. fmt: dur = Sekunden, min = Minuten, clock = Minuten seit Mitternacht. */

const METRICS = {
  slpScore: { label: 'Schlafscore', group: 'Schlaf', dir: 1 },
  slp: { label: 'Schlafdauer', group: 'Schlaf', fmt: 'dur', dir: 1 },
  deep: { label: 'Tiefschlaf', group: 'Schlaf', fmt: 'dur', dir: 1 },
  rem: { label: 'REM-Schlaf', group: 'Schlaf', fmt: 'dur', dir: 1 },
  bed: { label: 'Einschlafzeit', group: 'Schlaf', fmt: 'clock', dir: 0 },
  wake: { label: 'Aufwachzeit', group: 'Schlaf', fmt: 'clock', dir: 0 },
  hrv: { label: 'HRV', group: 'Erholung', unit: 'ms', dir: 1 },
  rhr: { label: 'Ruhepuls', group: 'Erholung', unit: 'bpm', dir: -1 },
  bbMax: { label: 'Body Battery', group: 'Erholung', dir: 1, hint: 'Höchstwert des Tages, meist am Morgen' },
  bbChg: { label: 'Body Battery geladen', group: 'Erholung', dir: 1 },
  slpResp: { label: 'Atemfrequenz (Nacht)', group: 'Erholung', unit: '/min', dec: 1, dir: 0 },
  spo2: { label: 'SpO2', group: 'Erholung', unit: '%', dir: 1 },
  stress: { label: 'Stress', group: 'Alltag', dir: -1, hint: 'Tagesmittel, 0–100' },
  steps: { label: 'Schritte', group: 'Alltag', dir: 1 },
  im: { label: 'Intensitätsminuten', group: 'Alltag', unit: 'min', dir: 1, agg: 'sum', hint: 'intensive Minuten zählen doppelt' },
  kcalAct: { label: 'Aktive Kalorien', group: 'Alltag', unit: 'kcal', dir: 1 },
  floors: { label: 'Etagen', group: 'Alltag', dir: 1 },
  load: { label: 'Trainingsbelastung', group: 'Training', dir: 0, agg: 'sum', zero: true },
  trainMin: { label: 'Trainingszeit', group: 'Training', fmt: 'min', dir: 0, agg: 'sum', zero: true },
  vo2: { label: 'VO2max', group: 'Training', dir: 1, sparse: true },
  weight: { label: 'Gewicht', group: 'Körper', unit: 'kg', dec: 1, dir: 0, sparse: true },
  fat: { label: 'Körperfett', group: 'Körper', unit: '%', dec: 1, dir: -1, sparse: true },
};
const GROUPS = ['Schlaf', 'Erholung', 'Alltag', 'Training', 'Körper'];

const nf0 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nfx = (dec) => (dec ? nf1 : nf0);

/** Sekunden → „7:32 h", unter einer Stunde „45 min". */
function fmtDur(s) {
  if (!fin(s)) return '–';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' min';
  return `${Math.floor(m / 60)}:${pad(m % 60)} h`;
}
/** Minuten seit Mitternacht (auch über 24 h) → „23:40". */
function fmtClock(m) {
  if (!fin(m)) return '–';
  const r = ((Math.round(m) % 1440) + 1440) % 1440;
  return `${Math.floor(r / 60)}:${pad(r % 60)}`;
}
/** Wert einer Kennzahl mit Einheit. `bare` lässt die Einheit weg (für Achsen). */
function fmt(key, v, bare) {
  if (!fin(v)) return '–';
  const m = METRICS[key] || {};
  if (m.fmt === 'dur') return fmtDur(v);
  if (m.fmt === 'min') return fmtDur(v * 60);
  if (m.fmt === 'clock') return fmtClock(v);
  const s = nfx(m.dec).format(v);
  return bare || !m.unit ? s : `${s} ${m.unit}`;
}
/** Unterschied zweier Werte als „+12 min", „−3 bpm", „+0:40 h". */
function fmtDelta(key, d) {
  if (!fin(d)) return '';
  const m = METRICS[key] || {};
  const a = Math.abs(d);
  // Vorzeichen erst nach dem Runden: +0,3 bpm angezeigt als „+0 bpm" sähe nach Veränderung aus
  const shown = m.fmt === 'dur' ? Math.round(a / 60) : m.dec ? Math.round(a * 10) : Math.round(a);
  const sign = !shown ? '±' : d > 0 ? '+' : '−';
  let s;
  if (m.fmt === 'dur') s = fmtDur(a);
  else if (m.fmt === 'min') s = fmtDur(a * 60);
  else if (m.fmt === 'clock') s = a < 60 ? Math.round(a) + ' min' : fmtDur(a * 60);
  else s = nfx(m.dec).format(a) + (m.unit ? ' ' + m.unit : '');
  return sign + s;
}

/* ── 5. Index ───────────────────────────────────────────────── */
/* Tageswerte, die nicht direkt von Garmin kommen: Belastung und
   Trainingszeit aus den Aktivitäten, Intensitätsminuten gewichtet,
   VO2max vom letzten Lauf/der letzten Fahrt des Tages. */

/** Belastung einer Aktivität. Garmins eigener Wert, wenn vorhanden; sonst
    TRIMP nach Banister aus Dauer und Puls — ältere Uhren liefern keinen
    Garmin-Wert, und eine Einheit ganz ohne Belastung würde die Kurve
    verfälschen. */
function actLoad(a, rhr, maxHr) {
  if (fin(a.load) && a.load > 0) return a.load;
  if (!fin(a.hr) || !fin(a.dur) || !rhr || !maxHr || maxHr <= rhr) return 0;
  const r = Math.max(0, Math.min(1, (a.hr - rhr) / (maxHr - rhr)));
  return (a.dur / 60) * r * 0.64 * Math.exp(1.92 * r);
}

function buildIndex(db) {
  const load = {}, trainMin = {}, late = {}, vo2 = {};
  const prof = db.profile || {};
  for (const a of db.acts || []) {
    if (!a.date) continue;
    // Teile einer Mehrsport-Einheit stecken auch im Ganzen — nicht doppelt zählen
    if (a.parent) continue;
    const day = (db.days || {})[a.date] || {};
    load[a.date] = (load[a.date] || 0) + actLoad(a, day.rhr || prof.rhr, prof.maxHr);
    trainMin[a.date] = (trainMin[a.date] || 0) + (a.dur || 0) / 60;
    const h = +a.start.slice(11, 13);
    const endH = h + (a.dur || 0) / 3600;
    if (endH >= 19 && (a.dur || 0) >= 20 * 60) late[a.date] = 1;
    if (fin(a.vo2)) vo2[a.date] = a.vo2;
  }
  return { load, trainMin, late, vo2 };
}

/** Wert einer Kennzahl an einem Tag. Belastung und Trainingszeit sind an
    Tagen ohne Aktivität 0, nicht „unbekannt" — sonst fehlten Ruhetage in
    jeder Auswertung. */
function value(db, idx, key, date) {
  const d = (db.days || {})[date];
  switch (key) {
    case 'load': return hasDay(db, date) ? (idx.load[date] || 0) : undefined;
    case 'trainMin': return hasDay(db, date) ? (idx.trainMin[date] || 0) : undefined;
    case 'late': return hasDay(db, date) ? (idx.late[date] ? 1 : 0) : undefined;
    case 'vo2': return idx.vo2[date];
    case 'im':
      if (!d || (d.imMod == null && d.imVig == null)) return undefined;
      return (d.imMod || 0) + 2 * (d.imVig || 0);
    default: return d ? d[key] : undefined;
  }
}
/** Gibt es für diesen Tag überhaupt Uhrdaten? Vor der ersten Uhr oder an
    Tagen ohne Tragen darf keine „0 Belastung" entstehen. */
function hasDay(db, date) {
  const d = (db.days || {})[date];
  return !!(d && (d.steps != null || d.rhr != null || d.slp != null));
}

/** Werte einer Kennzahl für jeden Tag des Zeitraums, Lücken als null. */
function series(db, idx, key, from, to) {
  return dateRange(from, to).map((d) => { const v = value(db, idx, key, d); return fin(v) ? v : null; });
}

/** Normalband für eine ganze Reihe: an jedem Tag Mittel ± Standardabweichung
    der `win` Tage davor — dieselbe Rechnung wie baseline(), nur am Stück. */
function rollingBand(vals, win, minN) {
  const lo = new Array(vals.length).fill(null), hi = lo.slice();
  for (let i = 0; i < vals.length; i++) {
    const w = vals.slice(Math.max(0, i - win), i).filter(fin);
    if (w.length < (minN || 10)) continue;
    const m = mean(w), s = Math.max(sd(w) || 0, Math.abs(m) * 0.03, 0.5);
    lo[i] = m - s; hi[i] = m + s;
  }
  return { lo, hi };
}

/* ── 6. Normalbereich und Bewertung ─────────────────────────── */

/** Dein üblicher Bereich: Mittelwert ± eine Standardabweichung der letzten
    `win` Tage vor `date` (der Tag selbst zählt nicht mit, sonst zöge ein
    Ausreißer seinen eigenen Maßstab mit). Etwa zwei von drei Tagen liegen
    darin. Unter `minN` Werten gibt es keinen Bereich. */
function baseline(db, idx, key, date, win, minN) {
  const vals = series(db, idx, key, addDays(date, -(win || 30)), addDays(date, -1)).filter(fin);
  if (vals.length < (minN || 10)) return null;
  const m = mean(vals);
  // Mindestbreite, damit sehr gleichmäßige Werte nicht bei jeder Kleinigkeit ausschlagen
  const s = Math.max(sd(vals) || 0, Math.abs(m) * 0.03, 0.5);
  return { mean: m, sd: s, lo: m - s, hi: m + s, n: vals.length };
}

/** Lage eines Werts zum Normalbereich: good / ok / warn / bad, oder 'off'
    für Kennzahlen ohne Richtung, die außerhalb liegen. */
function judge(v, base, dir) {
  if (!fin(v) || !base) return null;
  const z = (v - base.mean) / base.sd;
  if (!dir) return Math.abs(z) <= 1 ? 'ok' : 'off';
  const s = z * dir;
  if (s >= 1) return 'good';
  if (s > -1) return 'ok';
  if (s > -2) return 'warn';
  return 'bad';
}

/* ── 7. Erholung heute ──────────────────────────────────────── */
/* Garmins „Training Readiness" gibt die Personal API nicht her. Statt eine
   eigene Zahl zu erfinden, zeigt die App die Signale, aus denen sich so ein
   Wert zusammensetzt, jedes gegen Deinen eigenen Normalbereich. */

function readiness(db, idx, date) {
  const d = (db.days || {})[date] || {};
  const sig = [];

  if (fin(d.hrv)) {
    // Garmins eigener Bereich (3 Wochen) ist besser abgestimmt als unserer
    let st, base;
    if (fin(d.hrvLo) && fin(d.hrvHi)) {
      base = { lo: d.hrvLo, hi: d.hrvHi };
      const w = (d.hrvHi - d.hrvLo) || 1;
      st = d.hrv > d.hrvHi ? 'good' : d.hrv >= d.hrvLo ? 'ok' : d.hrv >= d.hrvLo - w * 0.5 ? 'warn' : 'bad';
    } else {
      base = baseline(db, idx, 'hrv', date, 21, 10);
      st = judge(d.hrv, base, 1);
    }
    sig.push({ key: 'hrv', label: 'HRV', value: d.hrv, base, status: st });
  }
  if (fin(d.rhr)) {
    const base = baseline(db, idx, 'rhr', date, 30, 10);
    sig.push({ key: 'rhr', label: 'Ruhepuls', value: d.rhr, base, status: judge(d.rhr, base, -1) });
  }
  if (fin(d.slp)) {
    let st = null;
    if (fin(d.slpScore)) st = d.slpScore >= 80 ? 'good' : d.slpScore >= 65 ? 'ok' : d.slpScore >= 50 ? 'warn' : 'bad';
    // Deutlich unter dem Schlafbedarf zählt, auch wenn der Score noch passt
    if (fin(d.need) && d.slp / 60 < d.need - 90 && st !== 'bad') st = 'warn';
    if (!st) st = judge(d.slp, baseline(db, idx, 'slp', date, 30, 10), 1);
    sig.push({ key: 'slpScore', label: 'Schlaf', value: fin(d.slpScore) ? d.slpScore : d.slp, valueKey: fin(d.slpScore) ? 'slpScore' : 'slp', status: st });
  }
  const ls = loadStatus(db, idx, addDays(date, -1));
  if (ls) {
    const st = { low: 'ok', ok: 'ok', high: 'warn', spike: 'bad' }[ls.status];
    sig.push({ key: 'load', label: 'Belastung', value: ls.ratio, status: st, text: ls.short });
  }
  if (fin(d.bbMax)) {
    const st = d.bbMax >= 75 ? 'good' : d.bbMax >= 50 ? 'ok' : d.bbMax >= 30 ? 'warn' : 'bad';
    sig.push({ key: 'bbMax', label: 'Body Battery', value: d.bbMax, status: st });
  }

  const rated = sig.filter((s) => s.status);
  const bad = rated.filter((s) => s.status === 'bad').length;
  const warn = rated.filter((s) => s.status === 'warn').length;
  const good = rated.filter((s) => s.status === 'good').length;
  let verdict;
  if (rated.length < 2) {
    verdict = { status: null, title: 'Noch zu wenig Daten', text: 'Für eine Einschätzung braucht es mindestens zwei Messwerte von heute Nacht.' };
  } else if (bad >= 1 && bad + warn >= 2) {
    verdict = { status: 'bad', title: 'Eher angeschlagen', text: 'Mehrere Signale liegen deutlich unter Deinem Normalbereich. Ein ruhiger Tag tut wahrscheinlich gut.' };
  } else if (bad + warn >= 2) {
    verdict = { status: 'warn', title: 'Nicht ganz erholt', text: 'Zwei oder mehr Signale liegen unter Deinem Normalbereich.' };
  } else if (bad + warn === 0 && good >= 2) {
    verdict = { status: 'good', title: 'Gut erholt', text: 'Alle Signale liegen im oder über Deinem Normalbereich.' };
  } else {
    verdict = { status: 'ok', title: 'Im normalen Bereich', text: bad + warn ? 'Ein Signal weicht ab, der Rest passt.' : 'Die Signale liegen in Deinem üblichen Bereich.' };
  }
  return { signals: sig, verdict };
}

/* ── 8. Trainingsbelastung ──────────────────────────────────── */
/* Akut = Summe der letzten 7 Tage, chronisch = Wochenmittel der letzten
   28 Tage. Das Verhältnis zeigt, ob Du gerade mehr machst als Dein Körper
   gewohnt ist. 0,8–1,3 gilt in der Sportwissenschaft als gut verträglich,
   über 1,5 steigt das Verletzungsrisiko deutlich. */

function loadStatus(db, idx, date) {
  const last28 = series(db, idx, 'load', addDays(date, -27), date);
  const known = last28.filter(fin).length;
  if (known < 21) return null;
  const acute = sum(last28.slice(21).filter(fin));
  const chronic = sum(last28.filter(fin)) / 4;
  if (chronic < 1) return null;
  const ratio = acute / chronic;
  let status, text, short;
  if (ratio < 0.8) { status = 'low'; text = 'weniger als sonst'; short = 'weniger'; }
  else if (ratio <= 1.3) { status = 'ok'; text = 'im üblichen Rahmen'; short = 'wie üblich'; }
  else if (ratio <= 1.5) { status = 'high'; text = 'deutlich mehr als sonst'; short = 'deutlich mehr'; }
  else { status = 'spike'; text = 'sprunghaft gestiegen'; short = 'stark erhöht'; }
  return { acute, chronic, ratio, status, text, short };
}

/** Akute und chronische Belastung für jeden Tag (für die Kurve). */
function loadSeries(db, idx, from, to) {
  const start = addDays(from, -27);
  const vals = series(db, idx, 'load', start, to).map((v) => (fin(v) ? v : 0));
  const out = [];
  for (let i = 27; i < vals.length; i++) {
    const a = sum(vals.slice(i - 6, i + 1));
    const c = sum(vals.slice(i - 27, i + 1)) / 4;
    out.push({ date: addDays(start, i), acute: a, chronic: c });
  }
  return out;
}

/* ── 9. Zusammenhänge ───────────────────────────────────────── */
/* Jedes Paar: Ursache x (am Vortag, wenn lag = 1) und Wirkung y. Die Tage
   werden nach x gedrittelt; verglichen wird das obere mit dem unteren
   Drittel. Das ist anschaulicher als ein Korrelationskoeffizient und
   robuster gegen Ausreißer — r steht trotzdem daneben. */

const PAIRS = [
  { id: 'load-hrv', x: 'load', lag: 1, y: 'hrv', hi: 'Nach Tagen mit viel Training', lo: 'nach ruhigen Tagen' },
  { id: 'load-rhr', x: 'load', lag: 1, y: 'rhr', hi: 'Nach Tagen mit viel Training', lo: 'nach ruhigen Tagen' },
  { id: 'load-slp', x: 'load', lag: 1, y: 'slpScore', hi: 'Nach Tagen mit viel Training', lo: 'nach ruhigen Tagen' },
  { id: 'late-slp', x: 'late', lag: 1, y: 'slpScore', bin: true, hi: 'Nach Training am Abend (Ende ab 19 Uhr)', lo: 'an anderen Tagen' },
  { id: 'late-hrv', x: 'late', lag: 1, y: 'hrv', bin: true, hi: 'Nach Training am Abend (Ende ab 19 Uhr)', lo: 'an anderen Tagen' },
  { id: 'slp-hrv', x: 'slp', lag: 0, y: 'hrv', hi: 'Nach langen Nächten', lo: 'nach kurzen' },
  { id: 'slp-bb', x: 'slp', lag: 0, y: 'bbMax', hi: 'Nach langen Nächten', lo: 'nach kurzen' },
  { id: 'bed-score', x: 'bed', lag: 0, y: 'slpScore', hi: 'Nach spätem Einschlafen', lo: 'nach frühem' },
  { id: 'bed-slp', x: 'bed', lag: 0, y: 'slp', hi: 'Nach spätem Einschlafen', lo: 'nach frühem' },
  { id: 'stress-slp', x: 'stress', lag: 1, y: 'slpScore', hi: 'Nach stressigen Tagen', lo: 'nach entspannten' },
  { id: 'stress-hrv', x: 'stress', lag: 1, y: 'hrv', hi: 'Nach stressigen Tagen', lo: 'nach entspannten' },
  { id: 'steps-slp', x: 'steps', lag: 1, y: 'slpScore', hi: 'Nach Tagen mit vielen Schritten', lo: 'nach Tagen mit wenigen' },
  { id: 'score-stress', x: 'slpScore', lag: 0, y: 'stress', hi: 'Nach guten Nächten', lo: 'nach schlechten' },
];

function strengthOf(r) {
  const a = Math.abs(r);
  if (a >= 0.5) return 'stark';
  if (a >= 0.3) return 'deutlich';
  if (a >= 0.15) return 'leicht';
  return 'kaum';
}

/** Ein Paar auswerten. Liefert null bei zu wenig Tagen. */
function relate(db, idx, pair, from, to, minN) {
  const pts = [];
  for (const d of dateRange(from, to)) {
    const x = value(db, idx, pair.x, addDays(d, -pair.lag));
    const y = value(db, idx, pair.y, d);
    if (fin(x) && fin(y)) pts.push({ x, y, d });
  }
  const need = minN || 20;
  if (pts.length < need) return { pair, n: pts.length, enough: false };
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const r = pearson(xs, ys);
  let hiG, loG, xHi = null, xLo = null;
  if (pair.bin) {
    hiG = pts.filter((p) => p.x > 0); loG = pts.filter((p) => !(p.x > 0));
    if (hiG.length < 6 || loG.length < 6) return { pair, n: pts.length, enough: false };
  } else {
    const s = pts.slice().sort((a, b) => a.x - b.x);
    const k = Math.floor(s.length / 3);
    loG = s.slice(0, k); hiG = s.slice(s.length - k);
    xLo = loG[loG.length - 1].x; xHi = hiG[0].x;
    // Alle Werte gleich (z. B. fast nie Training): Drittel unterscheiden sich nicht
    if (xHi <= xLo) return { pair, n: pts.length, enough: false };
  }
  const yHi = mean(hiG.map((p) => p.y)), yLo = mean(loG.map((p) => p.y));
  const diff = yHi - yLo;
  const n = pts.length;
  const rr = r == null ? 0 : r;
  // t-Wert der Korrelation; ab |t| ≈ 2 ist ein Zufallsbefund unwahrscheinlich (p < 0,05)
  const t = Math.abs(rr) >= 1 ? 99 : rr * Math.sqrt((n - 2) / (1 - rr * rr));
  return {
    pair, n, enough: true, pts, r: rr, t, strength: strengthOf(rr), solid: Math.abs(t) >= 2,
    yHi, yLo, diff, pct: yLo ? diff / Math.abs(yLo) : null, xHi, xLo, nHi: hiG.length, nLo: loG.length,
    // Wirkung im Sinne der Zielgröße: positiv heißt „besser"
    effect: diff * ((METRICS[pair.y] || {}).dir || 0),
  };
}

function insights(db, idx, from, to) {
  return PAIRS.map((p) => relate(db, idx, p, from, to)).filter(Boolean);
}

/* ── 10. Auswertungen über Zeiträume ────────────────────────── */

/** Werte nach Woche oder Monat zusammenfassen. */
function aggregate(db, idx, key, from, to, unit) {
  const m = METRICS[key] || {};
  const groups = new Map();
  for (const d of dateRange(from, to)) {
    const k = unit === 'month' ? monthKey(d) : weekStart(d);
    if (!groups.has(k)) groups.set(k, []);
    const v = value(db, idx, key, d);
    if (fin(v)) groups.get(k).push(v);
  }
  return Array.from(groups, ([k, vals]) => ({
    key: k, n: vals.length,
    v: vals.length ? (m.agg === 'sum' ? sum(vals) : mean(vals)) : null,
  }));
}

/** Mittel je Wochentag (Mo … So). */
function weekdayProfile(db, idx, key, from, to) {
  const b = [[], [], [], [], [], [], []];
  for (const d of dateRange(from, to)) {
    const v = value(db, idx, key, d);
    if (fin(v)) b[weekday(d)].push(v);
  }
  return b.map((a) => ({ v: mean(a), n: a.length }));
}

/** Kennwerte eines Zeitraums samt Vergleich mit dem gleich langen davor. */
function periodStats(db, idx, key, from, to) {
  const len = dayDiff(from, to) + 1;
  const cur = series(db, idx, key, from, to);
  const prev = series(db, idx, key, addDays(from, -len), addDays(from, -1)).filter(fin);
  const vals = cur.filter(fin);
  if (!vals.length) return null;
  const m = METRICS[key] || {};
  const xs = [], ys = [];
  cur.forEach((v, i) => { if (fin(v)) { xs.push(i); ys.push(v); } });
  const lr = vals.length >= 10 ? linreg(xs, ys) : null;
  const avg = mean(vals);
  return {
    avg, n: vals.length, min: Math.min(...vals), max: Math.max(...vals),
    total: m.agg === 'sum' ? sum(vals) : null,
    prevAvg: prev.length >= Math.min(7, len / 2) ? mean(prev) : null,
    perMonth: lr ? lr.slope * 30.4 : null,      // Trend als Änderung pro Monat
  };
}

/* Sportarten: Garmin kennt über hundert typeKeys. Für Wochenumfänge und
   Farben reichen wenige Gruppen, erkannt am Namen. */
const SPORTS = [
  { id: 'run', label: 'Laufen', re: /run|jog/ },
  { id: 'bike', label: 'Radfahren', re: /cycl|bik|ride|mtb/ },
  { id: 'swim', label: 'Schwimmen', re: /swim/ },
  { id: 'walk', label: 'Gehen & Wandern', re: /walk|hik|mountaineer/ },
  { id: 'strength', label: 'Kraft', re: /strength|weight/ },
  { id: 'winter', label: 'Wintersport', re: /ski|snow|skat/ },
  { id: 'other', label: 'Sonstiges', re: /.*/ },
];
function sportOf(type) { return SPORTS.find((s) => s.re.test(type || '')).id; }
const TYPE_LABELS = {
  running: 'Laufen', trail_running: 'Traillauf', treadmill_running: 'Laufband', track_running: 'Bahnlauf',
  indoor_running: 'Laufen drinnen', virtual_run: 'Virtueller Lauf', street_running: 'Straßenlauf',
  cycling: 'Radfahren', road_biking: 'Rennrad', mountain_biking: 'Mountainbike', gravel_cycling: 'Gravel',
  indoor_cycling: 'Indoor-Rad', virtual_ride: 'Virtuelle Fahrt', e_bike_fitness: 'E-Bike', e_bike_mountain: 'E-MTB',
  lap_swimming: 'Schwimmbad', open_water_swimming: 'Freiwasser', walking: 'Gehen', casual_walking: 'Spazieren',
  speed_walking: 'Walking', hiking: 'Wandern', strength_training: 'Krafttraining', hiit: 'HIIT', yoga: 'Yoga',
  pilates: 'Pilates', cardio: 'Cardio', indoor_cardio: 'Cardio', elliptical: 'Crosstrainer', indoor_rowing: 'Rudergerät',
  rowing: 'Rudern', stair_climbing: 'Treppensteigen', resort_skiing_snowboarding_ws: 'Ski & Snowboard',
  resort_skiing: 'Ski alpin', cross_country_skiing_ws: 'Langlauf', backcountry_skiing: 'Skitour',
  multi_sport: 'Mehrsport', triathlon: 'Triathlon', breathwork: 'Atemübung', tennis: 'Tennis', soccer: 'Fußball',
  bouldering: 'Bouldern', indoor_climbing: 'Klettern drinnen', rock_climbing: 'Klettern', other: 'Sonstiges',
};
function typeLabel(t) {
  if (TYPE_LABELS[t]) return TYPE_LABELS[t];
  const s = String(t || 'other').replace(/_ws$|_v\d+$/, '').replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Wochenumfänge: Dauer, Distanz, Anzahl, Belastung, Dauer je Sportart. */
function trainingWeeks(db, idx, lastDate, n) {
  const out = [];
  const first = addDays(weekStart(lastDate), -7 * (n - 1));
  for (let i = 0; i < n; i++) {
    const ws = addDays(first, 7 * i), we = addDays(ws, 6);
    out.push({ start: ws, end: we, dur: 0, dist: 0, count: 0, load: 0, sport: {} });
  }
  for (const a of db.acts || []) {
    if (a.parent || !a.date || a.date < first) continue;
    const w = out[Math.floor(dayDiff(first, a.date) / 7)];
    if (!w) continue;
    const day = (db.days || {})[a.date] || {};
    w.dur += a.dur || 0; w.dist += a.dist || 0; w.count++;
    w.load += actLoad(a, day.rhr || (db.profile || {}).rhr, (db.profile || {}).maxHr);
    const sp = sportOf(a.type);
    w.sport[sp] = (w.sport[sp] || 0) + (a.dur || 0);
  }
  return out;
}

/** Bestzeiten über die Laufstrecken aus Garmins „schnellstem Abschnitt". */
function bestEfforts(db, from) {
  const best = {};
  for (const a of db.acts || []) {
    if (!a.best || (from && a.date < from) || sportOf(a.type) !== 'run') continue;
    for (const k in a.best) {
      const t = a.best[k];
      if (!best[k] || t < best[k].t) best[k] = { t, id: a.id, date: a.date, name: a.name };
    }
  }
  return SPLITS.filter((k) => best[k]).map((k) => Object.assign({ dist: k }, best[k]));
}

return {
  DAY_MS, isoDate, parseDate, addDays, dayDiff, today, dateRange, weekday, weekStart, monthKey, chunks, localParts,
  fin, sum, mean, sd, quantile, median, pearson, linreg, rolling,
  clean, mapDaily, mapSleep, mapHrv, mapWeight, mapActivity, mergeDay, FIELDS, SPLITS,
  METRICS, GROUPS, fmt, fmtDelta, fmtDur, fmtClock,
  actLoad, buildIndex, value, hasDay, series, rollingBand,
  baseline, judge, readiness, loadStatus, loadSeries,
  PAIRS, relate, insights, strengthOf,
  aggregate, weekdayProfile, periodStats, SPORTS, sportOf, typeLabel, trainingWeeks, bestEfforts,
};
})();

if (typeof module === 'object' && module.exports) module.exports = Core;
