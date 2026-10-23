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
   3b. Eine Nacht im Detail (Messreihen der Schlafzeit)
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

/* Garmins Teilbewertungen des Schlafscores, gespeichert als ein Buchstabe je
   Teil in dieser Reihenfolge: 'E' ausgezeichnet, 'G' gut, 'F' mittel,
   'P' schwach, '-' fehlt — also "GEGFEGG" statt sieben Objekten. Der
   Speicher von localStorage gehört allen Apps auf derselben Adresse. */
const SLEEP_PARTS = [
  ['dur', 'totalDuration'], ['deep', 'deepPercentage'], ['light', 'lightPercentage'], ['rem', 'remPercentage'],
  ['restl', 'restlessness'], ['awk', 'awakeCount'], ['str', 'stress'],
];
/** Teilbewertung aus dem gespeicherten Kürzel: 'E', 'G', 'F', 'P' oder null. */
function sleepPart(sq, part) {
  const i = SLEEP_PARTS.findIndex((p) => p[0] === part);
  const c = typeof sq === 'string' && i >= 0 ? sq.charAt(i) : '';
  return 'EGFP'.includes(c) && c ? c : null;
}
/* Einflüsse auf Garmins Schlafbedarf: t Training, s Schlaf der letzten
   Nächte, h HRV, n Nickerchen. Die Doku nennt die Felder nur „Code"; neutral
   ist, was fehlt, 0 ist oder nach „keine Änderung" klingt. */
const NEED_FACTORS = [['t', 'trainingFeedback'], ['s', 'sleepHistoryAdjustment'], ['h', 'hrvAdjustment'], ['n', 'napAdjustment']];
const NEUTRAL = /^(0|NONE|NO_?CHANGE.*|NO_?ADJUSTMENT|NEUTRAL|BALANCED|NORMAL|INVALID|NOT_?AVAILABLE)$/i;
/** Garmins Klartext-Schlüssel nur, wenn er etwas aussagt. */
const keyOrNone = (v) => (typeof v === 'string' && v && !/^(NONE|INVALID|NOT_AVAILABLE)$/.test(v) ? v : undefined);

/** Minuten aus Garmins Schlafbedarf; ein Wert über 2000 kann nur Sekunden sein. */
const needMin = (v) => { v = num(v); return v ? (v > 2000 ? Math.round(v / 60) : v) : undefined; };

/** DailySleepDTO aus /sleep-service/sleep/dailySleepSummariesByDate.
    calendarDate ist der Morgen des Aufwachens — die Nacht davor.
    `ref` trägt, was nicht zur Nacht gehört, sondern zum aktuellen Stand:
    Garmins Idealbereiche der Phasen, der Bedarf für die kommende Nacht und
    das empfohlene Schlaffenster. Die App merkt sich davon nur den neuesten. */
function mapSleep(s) {
  if (!s || !s.calendarDate) return null;
  const scores = (s.sleepScores && typeof s.sleepScores === 'object') ? s.sleepScores : {};
  const sc = scores.overall || {};
  const start = localParts(s.sleepStartTimestampLocal), end = localParts(s.sleepEndTimestampLocal);
  const sn = s.sleepNeed || {};
  const total = num(s.sleepTimeSeconds);
  const sq = SLEEP_PARTS.map(([, k]) => {
    const q = String((scores[k] || {}).qualifierKey || '').charAt(0).toUpperCase();
    return 'EGFP'.includes(q) && q ? q : '-';
  }).join('');
  const adj = NEED_FACTORS.filter(([, k]) => sn[k] != null && sn[k] !== '' && !NEUTRAL.test(String(sn[k]))).map(([c]) => c).join('');
  const brth = String(s.breathingDisruptionSeverity || '').toUpperCase();

  const ref = {};
  const opt = {};
  for (const [p, k] of [['deep', 'deepPercentage'], ['light', 'lightPercentage'], ['rem', 'remPercentage']]) {
    const x = scores[k] || {};
    if (fin(num(x.optimalStart)) && fin(num(x.optimalEnd)) && num(x.optimalEnd) > 0) opt[p] = [num(x.optimalStart), num(x.optimalEnd)];
  }
  if (Object.keys(opt).length) ref.opt = opt;
  const nx = s.nextSleepNeed || {};
  if (needMin(nx.actual)) ref.next = clean({ need: needMin(nx.actual), lo: num(nx.recommendedBedtimeStartMins), hi: num(nx.recommendedBedtimeEndMins) });
  const al = s.sleepAlignment || {};
  if (fin(num(al.optimalSleepWindowStartMins)) && fin(num(al.optimalSleepWindowEndMins))) {
    ref.win = { lo: num(al.optimalSleepWindowStartMins), hi: num(al.optimalSleepWindowEndMins) };
  }

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
      respLo: num(s.lowestRespirationValue), respHi: num(s.highestRespirationValue),
      spo2Lo: num(s.lowestSpO2Value) || undefined,
      awakeN: num(s.awakeCount),
      need: needMin(sn.actual), needBase: needMin(sn.baseline), needAdj: adj || undefined,
      sq: /[EGFP]/.test(sq) ? sq : undefined,
      slpFb: keyOrNone(s.sleepScoreFeedback), slpIns: keyOrNone(s.sleepScoreInsight),
      brth: ['LOW', 'MEDIUM', 'HIGH'].includes(brth) ? brth : undefined,
    }),
    ref: Object.keys(ref).length ? ref : undefined,
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
    'slpResp', 'slpSpo2', 'respLo', 'respHi', 'spo2Lo', 'awakeN', 'need', 'needBase', 'needAdj', 'sq', 'slpFb', 'slpIns', 'brth'],
  hrv: ['hrv', 'hrvWeek', 'hrv5', 'hrvLo', 'hrvHi', 'hrvSt'],
  weight: ['weight', 'fat', 'bmi', 'muscle'],
};

/* ── 3b. Eine Nacht im Detail ───────────────────────────────── */
/* Für die Detailansicht einer Nacht holt die App Garmins Messreihen der
   beiden Kalendertage (Puls, HRV, Body Battery, SpO2) und schneidet die
   Schlafzeit heraus. Gespeichert wird kompakt: [Minute seit Einschlafen, Wert]. */

/** Zeitpunkt als Millisekunden. Text ohne Zone zählt als UTC: bei „GMT"-
    Feldern ist er das, bei „Local"-Feldern stehen darin die Ziffern der
    Ortszeit — die Differenz beider ist dann der Zeitzonen-Versatz. */
function tsMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (/^\d{9,}$/.test(String(v))) return +v;
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
}

/** Spalte einer Garmin-Messreihe. Die Zeilen kommen als [Zeit, Wert, …];
    welche Spalte was ist, steht in einer eigenen Beschreibungsliste. */
function column(desc, idxKey, nameKey, re, not, dflt) {
  const d = (Array.isArray(desc) ? desc : []).find((x) => x && re.test(String(x[nameKey] || '')) && !(not && not.test(String(x[nameKey] || ''))));
  return d && fin(+d[idxKey]) ? +d[idxKey] : dflt;
}

/** Messpunkte [Zeit, Wert] → [Minute seit t0, Wert] im Fenster a…b. */
function cut(pts, t0, a, b, lo, hi) {
  const out = [];
  for (const [tv, vv] of pts) {
    const t = tsMs(tv), v = num(vv);
    if (t == null || !fin(v) || v <= lo || v > hi || t < a || t > b) continue;
    out.push([Math.round((t - t0) / 60000), Math.round(v * 10) / 10]);
  }
  return out.sort((x, y) => x[0] - y[0]);
}
const rowsOf = (arr, ti, vi) => (Array.isArray(arr) ? arr : []).filter(Array.isArray).map((r) => [r[ti], r[vi]]);

/** Rohantworten einer Nacht → kompakter Datensatz.
    raw: { sleep, hrv, hr: [Vortag, Tag], bb: [Berichte], spo2 }
    fb: { t0, t1, off } aus den gespeicherten Tageswerten, falls Garmin das
    Schlaffenster in keiner Antwort mitschickt. */
function mapNight(raw, fb) {
  raw = raw || {};
  const env = raw.sleep || {};
  let s = env;
  // Falls Garmin wie in Garmin Connect einen Umschlag mit Phasenverlauf schickt
  if (s.dailySleepDTO) s = Object.assign({}, s.dailySleepDTO, { sleepLevels: s.sleepLevels || s.dailySleepDTO.sleepLevels });
  const hv = raw.hrv || {}, sp = raw.spo2 || {};

  // Schlaffenster und Versatz Ortszeit−UTC aus der ersten Antwort, die beides hat
  let t0 = null, t1 = null, off = null;
  for (const o of [s, hv, sp]) {
    const a = tsMs(o.sleepStartTimestampGMT), b = tsMs(o.sleepEndTimestampGMT);
    if (a == null || b == null || b <= a) continue;
    t0 = a; t1 = b;
    const la = tsMs(o.sleepStartTimestampLocal);
    if (la != null) off = Math.round((la - a) / 900000) * 15;
    break;
  }
  if (t0 == null && fb && fb.t1 > fb.t0) { t0 = fb.t0; t1 = fb.t1; }
  if (t0 == null) return null;
  if (off == null) off = fb && fin(fb.off) ? fb.off : 0;
  // Etwas Vorlauf und Nachlauf, damit die Kurven an den Rändern nicht ausfransen
  const a = t0 - 15 * 60000, b = t1 + 15 * 60000;

  let hr = [];
  for (const h of [].concat(raw.hr || [])) {
    if (!h) continue;
    const dsc = h.heartRateValueDescriptors;
    hr = hr.concat(cut(rowsOf(h.heartRateValues, column(dsc, 'index', 'key', /time/i, null, 0), column(dsc, 'index', 'key', /heart|rate|value/i, /time/i, 1)), t0, a, b, 20, 240));
  }
  // Beide Kalendertage überlappen um Mitternacht nicht, doppelt ist trotzdem möglich
  hr = hr.sort((x, y) => x[0] - y[0]).filter((p, i, arr) => !i || p[0] !== arr[i - 1][0]);

  const hrv = cut((Array.isArray(hv.hrvReadings) ? hv.hrvReadings : []).map((r) => [r && r.readingTimeGMT, r && r.hrvValue]), t0, a, b, 0, 400);

  let bb = [], bbImp = null;
  for (const r of [].concat(raw.bb || [])) {
    if (!r) continue;
    const dsc = r.bodyBatteryValueDescriptorDTOList;
    const ti = column(dsc, 'bodyBatteryValueDescriptorIndex', 'bodyBatteryValueDescriptorKey', /time/i, null, 0);
    const vi = column(dsc, 'bodyBatteryValueDescriptorIndex', 'bodyBatteryValueDescriptorKey', /level/i, null, 1);
    bb = bb.concat(cut(rowsOf(r.bodyBatteryValuesArray, ti, vi), t0, a, b, -1, 100));
    for (const e of Array.isArray(r.bodyBatteryActivityEvent) ? r.bodyBatteryActivityEvent : []) {
      const es = e && tsMs(e.eventStartTimeGmt);
      // Das Schlaf-Ereignis dieser Nacht: beginnt höchstens drei Stunden vor dem Einschlafen
      if (e && e.eventType === 'SLEEP' && es != null && es >= t0 - 3 * 3600e3 && es <= t1 && fin(num(e.bodyBatteryImpact))) bbImp = num(e.bodyBatteryImpact);
    }
  }
  bb = bb.sort((x, y) => x[0] - y[0]).filter((p, i, arr) => !i || p[0] !== arr[i - 1][0]);

  const sdsc = sp.spO2SingleValuesDescriptorList;
  const spo2 = cut(rowsOf(sp.spO2SingleValues,
    column(sdsc, 'spo2ValueDescriptorIndex', 'spo2ValueDescriptorKey', /time/i, null, 0),
    column(sdsc, 'spo2ValueDescriptorIndex', 'spo2ValueDescriptorKey', /spo2|reading|level|value/i, /time|plottable|confidence|environment/i, 1)), t0, a, b, 50, 100);

  // Phasenverlauf: in Garmins Beschreibung der Personal API nicht enthalten.
  // Kommt er doch (wie in Garmin Connect), wird er gezeigt: 0 Tief, 1 Leicht, 2 REM, 3 Wach.
  const lv = [];
  for (const l of Array.isArray(s.sleepLevels) ? s.sleepLevels : []) {
    const x0 = tsMs(l && l.startGMT), x1 = tsMs(l && l.endGMT), k = Math.round(num(l && l.activityLevel));
    if (x0 == null || x1 == null || x1 <= x0 || !(k >= 0 && k <= 3)) continue;
    lv.push([Math.round((x0 - t0) / 60000), Math.round((x1 - t0) / 60000), k]);
  }
  lv.sort((x, y) => x[0] - y[0]);

  // Unruhige Momente, wie Garmin Connect sie aus der Bewegung zählt: ebenfalls
  // nicht in der Beschreibung der Personal API. Kommen sie doch, zeigt die App sie.
  const rmList = env.sleepRestlessMoments || s.sleepRestlessMoments;
  let rmg;
  if (Array.isArray(rmList)) {
    rmg = [];
    for (const r of rmList) {
      const x = tsMs(r && (r.startGMT != null ? r.startGMT : r.startTimeGMT));
      if (x != null && x >= t0 && x <= t1) rmg.push(Math.round((x - t0) / 60000));
    }
    rmg.sort((x, y) => x - y);
  }
  const rmgN = num(env.restlessMomentsCount != null ? env.restlessMomentsCount : s.restlessMomentsCount);

  const naps = [];
  for (const n of Array.isArray(s.dailyNapDTOS) ? s.dailyNapDTOS : []) {
    const st = n && tsMs(n.napStartTimestampGMT), d = n && num(n.napTimeSec);
    if (st == null || !(d > 0)) continue;
    const o = fin(num(n.napStartTimeOffset)) ? num(n.napStartTimeOffset) : off;
    naps.push({ at: Math.floor((((st + o * 60000) % DAY_MS) + DAY_MS) % DAY_MS / 60000), dur: d });
  }

  // Uhrzeit des Einschlafens auf der Achse von mapSleep (nach Mitternacht + 1440)
  const md = Math.floor(((((t0 + off * 60000) % DAY_MS) + DAY_MS) % DAY_MS) / 60000);
  return clean({
    v: 2, t0, t1, off, s0: md < 12 * 60 ? md + 1440 : md, len: Math.round((t1 - t0) / 60000),
    hr, hrv, bb, spo2, lv, naps, bbImp: bbImp == null ? undefined : bbImp,
    // Leere Liste heißt „Garmin hat gezählt: keine"; clean würde sie verwerfen
    rmg: rmg && rmg.length ? rmg : undefined, rmgN: fin(rmgN) ? rmgN : rmg ? rmg.length : undefined,
    unm: num(s.unmeasurableSleepSeconds) || undefined,
    note: typeof s.userNote === 'string' && s.userNote.trim() ? s.userNote.trim().slice(0, 500) : undefined,
  });
}

/** Lücken bis `maxGap` Punkte geradlinig überbrücken — HRV kommt nur alle
    fünf Minuten, SpO2 setzt kurz aus. Längere Lücken bleiben sichtbar. */
function fillGaps(a, maxGap) {
  let last = -1;
  for (let i = 0; i < a.length; i++) {
    if (a[i] == null) continue;
    if (last >= 0 && i - last > 1 && i - last - 1 <= maxGap) {
      for (let j = last + 1; j < i; j++) a[j] = a[last] + ((a[i] - a[last]) * (j - last)) / (i - last);
    }
    last = i;
  }
  return a;
}

/** Eine Nacht auf ein gemeinsames Raster (alle `step` Minuten) bringen,
    damit alle Kurven dieselbe Zeitachse haben und das Antippen in jeder
    Kurve dieselbe Uhrzeit trifft. xs: Uhrzeit wie bei `bed` (über 1440 =
    nach Mitternacht). */
function nightGrid(n, step) {
  step = step || 5;
  const N = Math.max(2, Math.floor(n.len / step) + 1);
  const xs = Array.from({ length: N }, (_, k) => n.s0 + k * step);
  const bin = (pts) => {
    const s = new Array(N).fill(0), c = new Array(N).fill(0);
    for (const [m, v] of pts || []) {
      const k = Math.round(m / step);
      if (k < 0 || k >= N) continue;
      s[k] += v; c[k]++;
    }
    return fillGaps(s.map((x, k) => (c[k] ? x / c[k] : null)), 3);
  };
  const lv = xs.map((_, k) => {
    const m = k * step;
    const seg = (n.lv || []).find((l) => m >= l[0] && m < l[1]);
    return seg ? seg[2] : null;
  });
  return { xs, step, hr: bin(n.hr), hrv: bin(n.hrv), bb: bin(n.bb), spo2: bin(n.spo2), lv };
}

/* ── 4. Kennzahlen ──────────────────────────────────────────── */
/* dir: +1 = mehr ist besser, −1 = weniger ist besser, 0 = keine Wertung.
   agg: wie Wochen und Monate zusammengefasst werden — Mittel pro Tag oder
   Summe. fmt: dur = Sekunden, min = Minuten, clock = Minuten seit Mitternacht. */

const METRICS = {
  slpScore: { label: 'Schlafscore', group: 'Schlaf', dir: 1 },
  slp: { label: 'Schlafdauer', group: 'Schlaf', fmt: 'dur', dir: 1 },
  deep: { label: 'Tiefschlaf', group: 'Schlaf', fmt: 'dur', dir: 1 },
  light: { label: 'Leichtschlaf', group: 'Schlaf', fmt: 'dur', dir: 0 },
  rem: { label: 'REM-Schlaf', group: 'Schlaf', fmt: 'dur', dir: 1 },
  awake: { label: 'Wach in der Nacht', group: 'Schlaf', fmt: 'dur', dir: -1, hint: 'Zeit zwischen Einschlafen und Aufwachen, in der Du wach warst' },
  awakeN: { label: 'Aufgewacht', group: 'Schlaf', unit: '×', count: true, dir: -1, hint: 'Wie oft Du laut Garmin in der Nacht aufgewacht bist' },
  deepPct: { label: 'Tiefschlaf-Anteil', group: 'Schlaf', unit: '%', dir: 1, hint: 'Anteil am Schlaf ohne Wachzeit' },
  remPct: { label: 'REM-Anteil', group: 'Schlaf', unit: '%', dir: 1, hint: 'Anteil am Schlaf ohne Wachzeit' },
  bed: { label: 'Einschlafzeit', group: 'Schlaf', fmt: 'clock', dir: 0 },
  wake: { label: 'Aufwachzeit', group: 'Schlaf', fmt: 'clock', dir: 0 },
  mid: { label: 'Schlafmitte', group: 'Schlaf', fmt: 'clock', dir: 0, hint: 'Mitte zwischen Einschlafen und Aufwachen. Wandert sie, wandert Dein Rhythmus' },
  debt: { label: 'Schlafsaldo 7 Nächte', group: 'Schlaf', fmt: 'min', dir: 1, noBand: true, hint: 'Geschlafen minus Garmins Schlafbedarf, zusammengezählt über die letzten sieben Nächte. Unter null heißt: Dir fehlt Schlaf' },
  slpHr: { label: 'Puls im Schlaf', group: 'Schlaf', unit: 'bpm', dir: -1 },
  slpStress: { label: 'Stress im Schlaf', group: 'Schlaf', dir: -1, hint: 'Mittel über die Nacht, 0–100' },
  // Die drei folgenden gibt es nur für Nächte, deren Messreihen die App geladen hat (sleep.js)
  rm: { label: 'Pulsspitzen', group: 'Schlaf', unit: '×', count: true, dir: -1, minN: 7, hint: 'Kurze Pulsanstiege im Schlaf, meist eine Weckreaktion, an die Du Dich nicht erinnerst. Nur für Nächte, deren Kurven die App geladen hat' },
  rmG: { label: 'Unruhige Momente', group: 'Schlaf', unit: '×', count: true, dir: -1, minN: 7, hint: 'Garmins Zählung aus der Bewegung' },
  hrLow: { label: 'Pulstiefpunkt', group: 'Schlaf', unit: '%', dir: -1, minN: 7, hint: 'Wann in der Nacht Dein Puls am tiefsten war, in Prozent der Schlafzeit. Früh heißt meist: Der Körper kam schnell zur Ruhe' },
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
  // Schlafsaldo kann negativ sein: „−1:20 h", nicht „-80 min"
  if (Math.round(s / 60) < 0) return '−' + fmtDur(-s);
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
  // Zählwerte: „3×" für eine Nacht, „2,4×" für ein Mittel
  if (m.count) { const c = fmtCount(v); return bare ? c : c + m.unit; }
  const s = nfx(m.dec).format(v);
  return bare || !m.unit ? s : `${s} ${m.unit}`;
}
const fmtCount = (v) => (Math.abs(v - Math.round(v)) < 0.05 ? nf0 : nf1).format(v);
/** Unterschied zweier Werte als „+12 min", „−3 bpm", „+0:40 h". */
function fmtDelta(key, d) {
  if (!fin(d)) return '';
  const m = METRICS[key] || {};
  const a = Math.abs(d);
  // Vorzeichen erst nach dem Runden: +0,3 bpm angezeigt als „+0 bpm" sähe nach Veränderung aus
  const shown = m.fmt === 'dur' ? Math.round(a / 60) : m.dec || m.count ? Math.round(a * 10) : Math.round(a);
  const sign = !shown ? '±' : d > 0 ? '+' : '−';
  let s;
  if (m.count) s = fmtCount(a) + m.unit;
  else if (m.fmt === 'dur') s = fmtDur(a);
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
    // Aufwachen liegt auf dem Tag selbst, Einschlafen auf der Achse ab Mitternacht davor
    case 'mid': return d && fin(d.bed) && fin(d.wake) ? (d.bed + d.wake + 1440) / 2 : undefined;
    case 'debt': { const x = sleepDebt(db, date); return x ? x.sum : undefined; }
    // Anteil am Schlaf ohne Wachzeit, wie Garmin ihn bewertet
    case 'deepPct': case 'remPct': {
      const v = d && d[key.slice(0, -3)];
      return fin(v) && d.slp > 0 ? (v / d.slp) * 100 : undefined;
    }
    default: return d ? d[key] : undefined;
  }
}

/** Schlafsaldo: geschlafen minus Garmins Schlafbedarf, in Minuten, über die
    `n` Nächte bis `date`. Erst ab fünf von sieben bekannten Nächten — sonst
    sähe eine Woche mit Lücken besser aus, als sie war. */
function sleepDebt(db, date, n) {
  n = n || 7;
  let sumv = 0, k = 0;
  const nights = [];
  for (let i = n - 1; i >= 0; i--) {
    const dd = addDays(date, -i), d = (db.days || {})[dd];
    const v = d && fin(d.slp) && fin(d.need) ? d.slp / 60 - d.need : null;
    nights.push({ date: dd, v });
    if (v != null) { sumv += v; k++; }
  }
  return k >= Math.ceil(n * 5 / 7) ? { sum: sumv, n: k, nights } : null;
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

/* ── 8b. Fitness-Score ──────────────────────────────────────── */
/* Wie fit bist Du gerade? Die Erholung oben ist die Tagesform; der Score
   ist der Stand der vier Wochen davor, 0–100, aus fünf Teilen mit festen
   Gewichten. Jeder Teil misst gegen einen festen Maßstab, nicht gegen
   Deinen eigenen Schnitt — sonst läge jeder immer bei der Mitte. Fehlt ein
   Teil, zählen die übrigen anteilig mehr. */

/* Garmins VO2max-Einstufung (nach dem Cooper Institute): Untergrenzen von
   „mittel", „gut", „sehr gut" und „überragend" je Altersgruppe 20–29 bis
   70–79. Laut Garmin entspricht das dem 40., 60., 80. und 95. Perzentil. */
const VO2_NORM = {
  m: [[41.7, 45.4, 51.1, 55.4], [40.5, 44.0, 48.3, 54.0], [38.5, 42.4, 46.4, 52.5],
    [35.6, 39.2, 43.4, 48.9], [32.3, 35.5, 39.5, 45.7], [29.4, 32.3, 36.7, 42.1]],
  f: [[36.1, 39.5, 43.9, 49.6], [34.4, 37.8, 42.4, 47.4], [33.0, 36.3, 39.7, 45.3],
    [30.1, 33.0, 36.7, 41.1], [27.5, 30.0, 33.0, 37.8], [25.9, 28.1, 30.9, 36.7]],
};
const VO2_PCT = [40, 60, 80, 95];

/** Grenzen für Alter und Geschlecht. Zwischen den Altersgruppen gleitend,
    damit der Score am Geburtstag nicht springt. Ohne Geschlecht das Mittel
    beider Tabellen, ohne Alter 35 — beides nur ungefähr. */
function vo2Norm(age, sex) {
  const rows = sex === 'm' || sex === 'f' ? VO2_NORM[sex]
    : VO2_NORM.m.map((r, i) => r.map((v, j) => (v + VO2_NORM.f[i][j]) / 2));
  const p = Math.max(0, Math.min(5, ((fin(age) ? age : 35) - 25) / 10));
  const i = Math.min(4, Math.floor(p)), k = p - i;
  return rows[i].map((v, j) => v + (rows[i + 1][j] - v) * k);
}

/** Perzentil der VO2max in der eigenen Gruppe: zwischen Garmins Grenzen
    linear, darunter mit 2,5 Breiten von „mittel" bis 0, darüber bis 100. */
function vo2Percentile(v, norm) {
  const lo = norm[0] - 2.5 * (norm[1] - norm[0]);
  const hi = norm[3] + (norm[3] - norm[2]) / 3;
  return pieces(v, [[lo, 0]].concat(norm.map((t, i) => [t, VO2_PCT[i]]), [[hi, 100]]));
}

/** Stückweise lineare Kurve durch [x, y]-Punkte (x aufsteigend), außen gekappt. */
function pieces(v, pts) {
  if (v <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    if (v <= x1) return y0 + ((v - x0) / ((x1 - x0) || 1)) * (y1 - y0);
  }
  return pts[pts.length - 1][1];
}

/* Maßstäbe der übrigen Teile. Intensitätsminuten (intensive doppelt, wie
   Garmin zählt): die WHO empfiehlt 150–300 pro Woche. Schritte: der Nutzen
   für die Gesundheit flacht laut großen Auswertungen ab etwa 8000–10 000
   ab. Ruhepuls: im Mittel 60–70, gut Trainierte unter 50. Aktive Tage:
   Tage mit mindestens 20 Minuten Training oder 30 Intensitätsminuten. */
const FIT_PARTS = [
  { key: 'vo2', label: 'VO2max', w: 35 },
  { key: 'im', label: 'Intensität', w: 25 },
  { key: 'rhr', label: 'Ruhepuls', w: 15 },
  { key: 'steps', label: 'Schritte', w: 15 },
  { key: 'days', label: 'Aktive Tage', w: 10 },
];
const FIT_SCALE = {
  im: [[0, 0], [75, 30], [150, 60], [300, 85], [450, 100]],
  rhr: [[44, 100], [52, 85], [62, 60], [72, 30], [85, 0]],
  steps: [[2000, 0], [5000, 35], [7500, 65], [10000, 85], [12500, 100]],
  days: [[0, 0], [1, 25], [3, 65], [5, 100]],
};
const FIT_LEVELS = [[85, 'Ausgezeichnet', 'good'], [70, 'Sehr gut', 'good'], [55, 'Gut', 'ok'], [40, 'Mittel', 'ok'], [0, 'Ausbaufähig', 'warn']];

/** Fitness-Score an einem Tag aus den 28 Tagen davor (der Tag selbst zählt
    nicht, er ist morgens erst angefangen). VO2max: der letzte Wert der
    letzten 120 Tage, der Tag selbst eingeschlossen. `me`: { age, sex }.
    Ab drei Teilen gibt es einen Score, sonst score: null. */
function fitness(db, idx, date, me) {
  me = me || {};
  const from = addDays(date, -28), to = addDays(date, -1);
  const days = dateRange(from, to);
  const known = days.filter((d) => hasDay(db, d)).length;
  const parts = [];

  let vo2Date = null;
  for (let i = 0; i <= 120 && !vo2Date; i++) { const d = addDays(date, -i); if (fin(idx.vo2[d])) vo2Date = d; }
  if (vo2Date) {
    const v = idx.vo2[vo2Date], norm = vo2Norm(me.age, me.sex);
    parts.push({ key: 'vo2', value: v, date: vo2Date, norm, score: vo2Percentile(v, norm), approx: !(fin(me.age) && me.sex) });
  }
  const im = days.map((d) => value(db, idx, 'im', d)).filter(fin);
  if (im.length >= 21) {
    const wk = sum(im) / im.length * 7;
    parts.push({ key: 'im', value: wk, score: pieces(wk, FIT_SCALE.im) });
  }
  const rhr = days.map((d) => value(db, idx, 'rhr', d)).filter(fin);
  if (rhr.length >= 10) {
    const v = median(rhr);
    // Frauen haben im Mittel einen etwa drei Schläge höheren Ruhepuls
    parts.push({ key: 'rhr', value: v, score: pieces(me.sex === 'f' ? v - 3 : v, FIT_SCALE.rhr) });
  }
  const steps = days.map((d) => value(db, idx, 'steps', d)).filter(fin);
  if (steps.length >= 14) {
    const v = median(steps);
    parts.push({ key: 'steps', value: v, score: pieces(v, FIT_SCALE.steps) });
  }
  if (known >= 21) {
    const act = days.filter((d) => (idx.trainMin[d] || 0) >= 20 || (value(db, idx, 'im', d) || 0) >= 30).length;
    const wk = act / known * 7;
    parts.push({ key: 'days', value: wk, score: pieces(wk, FIT_SCALE.days) });
  }

  for (const p of parts) {
    const def = FIT_PARTS.find((x) => x.key === p.key);
    p.label = def.label; p.w = def.w; p.score = Math.round(p.score);
  }
  parts.sort((a, b) => b.w - a.w);
  const missing = FIT_PARTS.filter((x) => !parts.some((p) => p.key === x.key)).map((x) => x.key);
  if (parts.length < 3) return { score: null, parts, missing };
  const wsum = sum(parts.map((p) => p.w));
  for (const p of parts) p.share = p.w / wsum;
  const score = Math.round(sum(parts.map((p) => p.score * p.share)));
  const lv = FIT_LEVELS.find((l) => score >= l[0]);
  // Wo am meisten zu holen ist: größter gewichteter Abstand zu 100
  const next = parts.slice().sort((a, b) => (100 - b.score) * b.share - (100 - a.score) * a.share)[0];
  return { score, label: lv[1], status: lv[2], parts, missing, next: next.score < 85 ? next.key : null };
}

/** Score für jeden Tag des Zeitraums (null, wo er fehlt), für die Kurve. */
function fitnessSeries(db, idx, from, to, me) {
  return dateRange(from, to).map((d) => fitness(db, idx, d, me).score);
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
  SLEEP_PARTS, sleepPart, NEED_FACTORS, tsMs, mapNight, fillGaps, nightGrid, sleepDebt,
  METRICS, GROUPS, fmt, fmtDelta, fmtDur, fmtClock,
  actLoad, buildIndex, value, hasDay, series, rollingBand,
  baseline, judge, readiness, loadStatus, loadSeries,
  FIT_PARTS, FIT_SCALE, vo2Norm, vo2Percentile, fitness, fitnessSeries,
  PAIRS, relate, insights, strengthOf,
  aggregate, weekdayProfile, periodStats, SPORTS, sportOf, typeLabel, trainingWeeks, bestEfforts,
};
})();

if (typeof module === 'object' && module.exports) module.exports = Core;
