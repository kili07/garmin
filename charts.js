'use strict';
/* ═══════════════════════════════════════════════════════════════
   Garmin-Übersicht — Diagramme als inline-SVG

   Jede Funktion bekommt fertige Zahlen und liefert einen SVG-Text. Keine
   Farben im Code: alles läuft über Klassen, die style.css mit Tokens
   einfärbt — so ziehen die Diagramme beim Theme-Wechsel mit. Die Farbe
   einer Reihe kommt als Klasse an das SVG (z. B. c-hr) und steht dort als
   --cc bereit; Linie, Punkte und Verlaufsfläche lesen sie von da.

   Linien 2 px, Flächen als Verlauf nach unten, Gitter als 1-px-Haarlinie,
   Balken höchstens 24 px breit mit gerundetem Ende oben und eckig an der
   Grundlinie, Endpunkte mit einem Ring in Kartenfarbe (CLAUDE.md).

   Gezeichnet wird in einem festen Koordinatensystem (Breite 340); das SVG
   skaliert per viewBox auf die Kartenbreite. Schriftgrößen sind damit auf
   dem Handy etwa so groß wie angegeben.

   Antippen: Diagramme mit Datenreihe tragen data-n, data-x0 und data-x1.
   app.js rechnet daraus den angetippten Punkt aus und zeigt ihn über dem
   Diagramm an — die Funktionen hier bleiben ohne DOM.
   ═══════════════════════════════════════════════════════════════ */

const Charts = (() => {

const W = 340;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fin = (v) => typeof v === 'number' && isFinite(v);
const r1 = (v) => Math.round(v * 10) / 10;

/* Verläufe brauchen eine id, die im ganzen Dokument eindeutig ist —
   auf einer Seite stehen oft mehrere Diagramme. */
let gid = 0;
function areaDef() {
  const id = 'ag' + (++gid);
  return { id, def: `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="ag0"/><stop offset="1" class="ag1"/></linearGradient></defs>` };
}

function scale(d0, d1, p0, p1) {
  const k = (p1 - p0) / ((d1 - d0) || 1);
  return (v) => p0 + (v - d0) * k;
}

/** „Schöne" Achsenwerte: 1, 2 oder 5 mal einer Zehnerpotenz, höchstens
    n + 1 Stück — aber nie nur einer, sonst fehlt bei schmalen Bereichen
    (Puls 156–164) jeder Maßstab. `unit` rechnet vorher um: Schlaf in
    Sekunden bekommt so Striche bei vollen Stunden statt bei 25 000 s. */
function ticks(lo, hi, n, unit) {
  if (!fin(lo) || !fin(hi)) return [];
  const u = unit || 1;
  lo /= u; hi /= u; n = n || 4;
  if (hi === lo) { hi = lo + 1; lo = lo - 1; }
  const p = Math.pow(10, Math.floor(Math.log10((hi - lo) / n)));
  const cands = [];
  for (const q of [p / 10, p, p * 10, p * 100]) for (const m of [1, 2, 5]) cands.push(q * m);
  const count = (s) => Math.floor(hi / s + 1e-9) - Math.ceil(lo / s - 1e-9) + 1;
  let i = cands.findIndex((s) => count(s) <= n + 1);
  if (i < 0) i = cands.length - 1;
  if (count(cands[i]) < 2 && i > 0) i--;
  const step = cands[i], out = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-6; v += step) out.push(+(v * u).toFixed(10));
  return out;
}

/** Jede wievielte Beschriftung, damit sich Texte auf der Achse nicht überlappen. */
function labelEvery(labels, step) {
  const w = Math.max(...labels.map((l) => String(l || '').length)) * 5.4 + 6;
  return Math.max(1, Math.ceil(w / step));
}

/** Wertebereich einer oder mehrerer Reihen, mit etwas Luft oben und unten. */
function extent(arrs, zero) {
  let lo = Infinity, hi = -Infinity;
  for (const a of arrs) for (const v of a || []) if (fin(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (lo === Infinity) return null;
  if (zero) lo = Math.min(0, lo);
  const padv = (hi - lo) * 0.08 || Math.abs(hi) * 0.05 || 1;
  return [zero && lo === 0 ? 0 : lo - padv, hi + padv];
}

const MON = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

/** Beschriftung der Zeitachse je nach Spanne: Wochentage, Tage, Monate oder Jahre. */
function dateTicks(dates) {
  const n = dates.length, out = [];
  if (!n) return out;
  if (n <= 10) {
    // Eine Woche: jeder Tag mit Wochentag
    dates.forEach((d, i) => { const [y, m, dd] = d.split('-').map(Number); out.push({ i, t: WD[new Date(y, m - 1, dd, 12).getDay()] }); });
  } else if (n <= 45) {
    const step = n <= 15 ? 2 : 7;
    for (let i = n - 1; i >= 0; i -= step) {
      const [, m, d] = dates[i].split('-');
      out.push({ i, t: `${+d}.${+m}.` });
    }
  } else if (n <= 500) {
    const every = n > 200 ? 2 : 1;
    let k = 0;
    dates.forEach((d, i) => {
      if (d.endsWith('-01') && (k++ % every === 0)) out.push({ i, t: MON[+d.slice(5, 7) - 1] });
    });
  } else {
    dates.forEach((d, i) => { if (d.endsWith('-01-01')) out.push({ i, t: d.slice(0, 4) }); });
  }
  return out;
}

/** Linienzug aus Punkten; null unterbricht die Linie. */
function path(xs, ys) {
  let d = '', open = false;
  for (let i = 0; i < ys.length; i++) {
    if (!fin(ys[i]) || !fin(xs[i])) { open = false; continue; }
    d += (open ? 'L' : 'M') + r1(xs[i]) + ' ' + r1(ys[i]);
    open = true;
  }
  return d;
}

/** Fläche unter einem Linienzug bis zur Grundlinie `base`, je Abschnitt
    ohne Lücke eine eigene Fläche. */
function areaPath(xs, ys, base) {
  let out = '', seg = [];
  const flush = () => {
    if (seg.length > 1) {
      out += 'M' + seg.map((i) => `${r1(xs[i])} ${r1(ys[i])}`).join('L')
        + `L${r1(xs[seg[seg.length - 1]])} ${r1(base)}L${r1(xs[seg[0]])} ${r1(base)}Z`;
    }
    seg = [];
  };
  for (let i = 0; i < ys.length; i++) { if (fin(ys[i]) && fin(xs[i])) seg.push(i); else flush(); }
  flush();
  return out;
}

/** Fläche zwischen zwei Reihen (Normalband). */
function bandPath(xs, lo, hi) {
  let out = '', seg = [];
  const flush = () => {
    if (seg.length > 1) {
      out += 'M' + seg.map((i) => `${r1(xs[i])} ${r1(hi[i])}`).join('L')
        + 'L' + seg.slice().reverse().map((i) => `${r1(xs[i])} ${r1(lo[i])}`).join('L') + 'Z';
    }
    seg = [];
  };
  for (let i = 0; i < xs.length; i++) { if (fin(lo[i]) && fin(hi[i])) seg.push(i); else flush(); }
  flush();
  return out;
}

/** Balken mit gerundetem Ende oben (Radius r) und eckig an der Grundlinie. */
function barPath(x, y, w, h, r) {
  if (!(w > 0) || !(h > 0)) return '';
  r = Math.min(r == null ? 4 : r, w / 2, h);
  return `M${r1(x)} ${r1(y + h)}V${r1(y + r)}A${r1(r)} ${r1(r)} 0 0 1 ${r1(x + r)} ${r1(y)}`
    + `H${r1(x + w - r)}A${r1(r)} ${r1(r)} 0 0 1 ${r1(x + w)} ${r1(y + r)}V${r1(y + h)}Z`;
}

/** Endpunkt einer Linie: gefüllter Punkt mit Ring in Kartenfarbe. */
const endDot = (x, y, cls) => `<circle class="end-dot${cls ? ' ' + esc(cls) : ''}" cx="${r1(x)}" cy="${r1(y)}" r="4"/>`;

function yAxis(yt, y, x0, x1, fmtY) {
  // Beschriftungen, die über den Rand ragen würden, weglassen
  yt = yt.filter((v) => y(v) >= 4 && y(v) <= 1000);
  return yt.map((v) => `<line class="grid" x1="${x0}" x2="${x1}" y1="${r1(y(v))}" y2="${r1(y(v))}"/>`
    + `<text class="ax" x="${x0 - 6}" y="${r1(y(v)) + 3}" text-anchor="end">${esc(fmtY(v))}</text>`).join('');
}

/* ── Halbkreis ──────────────────────────────────────────────── */
/** Gauge von 0 bis o.max (100) als oberer Halbkreis. Nur die Bögen; Zahl
    und Wort setzt app.js als HTML darüber, damit sie aus CSS ihre Schrift
    bekommen. o.st: Zustand (good, ok, warn, bad) — er färbt den Bogen.
    Der Verlauf läuft vom blassen Anfang bis zur Spitze des Bogens, auch
    bei kleinen Werten endet er also kräftig. */
function gauge(v, o) {
  o = o || {};
  const max = o.max || 100, w = 248, sw = 14;
  const r = (w - sw) / 2, cx = w / 2, cy = r + sw / 2, h = Math.ceil(cy + sw / 2);
  const p = fin(v) ? Math.max(0, Math.min(1, v / max)) : 0;
  const len = Math.PI * r;
  const d = `M${sw / 2} ${cy}A${r} ${r} 0 0 1 ${w - sw / 2} ${cy}`;
  const tip = cx - r * Math.cos(Math.PI * p);
  const id = 'gg' + (++gid);
  let s = `<svg class="gauge st-${esc(o.st || 'off')}" viewBox="0 0 ${w} ${h}" aria-hidden="true">`
    + `<defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${sw / 2}" y1="0" x2="${r1(Math.max(sw, tip + sw / 2))}" y2="0">`
    + '<stop offset="0" class="gs0"/><stop offset="1" class="gs1"/></linearGradient></defs>'
    + `<path class="gauge-track" d="${d}"/>`;
  if (p > 0) {
    s += `<path class="gauge-fill" d="${d}" stroke="url(#${id})" style="--len:${r1(len)}"`
      + ` stroke-dasharray="${r1(len)}" stroke-dashoffset="${r1(len * (1 - p))}"/>`;
  }
  return s + '</svg>';
}

/* ── Sparkline ──────────────────────────────────────────────── */
/** Kleine Linie für Metrik-Karten, meist die letzten sieben Tage. Linie
    leise, der letzte Punkt in der Farbe seines Zustands (o.st). o.band =
    [lo, hi] als waagrechter Streifen (Dein Normalbereich), o.partial: der
    letzte Wert ist noch nicht fertig (heute) und bekommt einen hohlen Punkt.
    Gezeichnet in der Breite, in der sie erscheint (o.w), damit der Punkt
    rund bleibt und die Höhe stimmt. */
function spark(vals, opt) {
  opt = opt || {};
  const w = opt.w || 136, h = opt.h || 36;
  const ex = extent([vals, opt.band || []]);
  if (!ex || vals.filter(fin).length < 2) return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"></svg>`;
  const x = scale(0, vals.length - 1, 5, w - 5), y = scale(ex[0], ex[1], h - 5, 5);
  let xs = vals.map((_, i) => x(i)), ys = vals.map((v) => (fin(v) ? y(v) : null));
  // Seltene Werte (Gewicht alle paar Tage) verbinden, statt einzelne Punkte zu zeigen
  if (opt.connect) {
    const keep = ys.map((v, i) => (v != null ? i : -1)).filter((i) => i >= 0);
    xs = keep.map((i) => xs[i]); ys = keep.map((i) => ys[i]);
  }
  let last = ys.length - 1;
  while (last >= 0 && ys[last] == null) last--;
  const band = opt.band && fin(opt.band[0]) && fin(opt.band[1])
    ? `<rect class="band" x="0" width="${w}" y="${r1(y(opt.band[1]))}" height="${r1(Math.max(1, y(opt.band[0]) - y(opt.band[1])))}" rx="3"/>` : '';
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true">${band}`
    + `<path class="ln" d="${path(xs, ys)}"/>`
    + (last >= 0 ? `<circle class="end st-${esc(opt.st || 'off')}${opt.partial ? ' partial' : ''}" cx="${r1(xs[last])}" cy="${r1(ys[last])}" r="3.5"/>` : '')
    + '</svg>';
}

/* ── Verlauf ────────────────────────────────────────────────── */
/** Tageswerte mit gleitendem Mittel und Normalband. Das Mittel ist die
    Hauptlinie: 2 px im Akzent, darunter eine Verlaufsfläche. Bei wenigen
    Tagen (eine Woche) gibt es kein Mittel, dann trägt die Tageslinie
    Fläche und Punkte.
    o: { dates, vals, avg, lo, hi, fmtY, h, bars, goal, zero, unit, cls } */
function trend(o) {
  const h = o.h || 200, x0 = 36, x1 = W - 8, top = 10, bot = h - 20;
  const ex = extent([o.vals, o.avg, o.lo, o.hi, o.goal != null ? [o.goal] : []], o.zero || o.bars);
  const n = o.dates.length;
  if (!ex || !n) return '<div class="chart-empty">Keine Werte im Zeitraum</div>';
  const step = (x1 - x0) / n;
  const x = (i) => x0 + step * (i + 0.5);
  const y = scale(ex[0], ex[1], bot, top);
  const xs = o.dates.map((_, i) => x(i));
  const fmtY = o.fmtY || String;
  const yv = (arr) => arr.map((v) => (fin(v) ? y(v) : null));
  const a = areaDef();
  let s = `<svg class="chart-svg${o.cls ? ' ' + esc(o.cls) : ''}" viewBox="0 0 ${W} ${h}" data-n="${n}" data-x0="${x0}" data-x1="${x1}">${a.def}`;
  s += yAxis(ticks(ex[0], ex[1], 4, o.unit), y, x0, x1, fmtY);
  // Das Normalband liegt über der Verlaufsfläche, sonst ginge es in ihr unter
  const band = o.lo && o.hi ? `<path class="band" d="${bandPath(xs, yv(o.lo), yv(o.hi))}"/>` : '';
  if (o.bars) s += band;
  if (o.goal != null) s += `<line class="goal" x1="${x0}" x2="${x1}" y1="${r1(y(o.goal))}" y2="${r1(y(o.goal))}"/>`;
  // Die Hauptlinie: das Mittel, ohne Mittel die Tageswerte selbst
  const main = o.avg && o.avg.some(fin) && !(n <= 10 && !o.bars) ? o.avg : null;
  if (o.bars) {
    const bw = Math.max(1, Math.min(24, step * 0.66));
    o.vals.forEach((v, i) => {
      if (!fin(v) || v <= 0) return;
      s += `<path class="bar" d="${barPath(x(i) - bw / 2, y(v), bw, Math.max(0.5, y(ex[0]) - y(v)), Math.min(4, bw / 2))}"/>`;
    });
  } else {
    const line = main || o.vals;
    s += `<path class="area" fill="url(#${a.id})" d="${areaPath(xs, yv(line), bot)}"/>` + band;
    if (!main) s += `<path class="ln-avg" d="${path(xs, yv(o.vals))}"/>`;
    else if (n <= 45) s += `<path class="ln-day" d="${path(xs, yv(o.vals))}"/>`;
    // Tageswerte als leise Punkte; ohne Mittel sind sie die Linie selbst
    const r = !main ? 3.5 : n <= 45 ? 2.4 : n <= 120 ? 1.7 : 1.2;
    o.vals.forEach((v, i) => { if (fin(v)) s += `<circle class="pt${!main ? ' on' : n > 120 ? ' dim' : ''}" cx="${r1(x(i))}" cy="${r1(y(v))}" r="${r}"/>`; });
  }
  if (main) {
    s += `<path class="ln-avg" d="${path(xs, yv(main))}"/>`;
    let li = main.length - 1;
    while (li >= 0 && !fin(main[li])) li--;
    if (li >= 0) s += endDot(x(li), y(main[li]));
  }
  for (const t of dateTicks(o.dates)) {
    s += `<text class="ax" x="${r1(x(t.i))}" y="${h - 4}" text-anchor="middle">${esc(t.t)}</text>`;
  }
  s += `<line class="cursor hidden" x1="0" x2="0" y1="${top}" y2="${bot}"/>`;
  return s + '</svg>';
}

/* ── Balken ─────────────────────────────────────────────────── */
/** items: [{ label, v, parts:[{v, cls}], cur }] — `parts` stapelt Anteile
    (z. B. Sportarten), getrennt durch eine 2-px-Fuge in Kartenfarbe; `cur`
    hebt den laufenden Zeitraum hervor. */
function bars(items, o) {
  o = o || {};
  const h = o.h || 160, x0 = o.noAxis ? 4 : 36, x1 = W - 4, top = 16, bot = h - 20;
  const vals = items.map((it) => it.v);
  // Mittelwerte (HRV 53 gegen 56 ms) gehen auf einer Achse ab 0 unter — dann ab knapp unter dem kleinsten Wert
  const zero = o.zero !== false;
  const ex = extent([vals, o.goal != null ? [o.goal] : []], zero);
  if (!ex || !items.length) return '<div class="chart-empty">Keine Werte im Zeitraum</div>';
  const lo = zero ? 0 : ex[0] - (ex[1] - ex[0]) * 0.5;
  const y = scale(lo, ex[1], bot, top);
  const step = (x1 - x0) / items.length, bw = Math.min(24, step * 0.66);
  const fmtY = o.fmtY || String;
  let s = `<svg class="chart-svg" viewBox="0 0 ${W} ${h}" data-n="${items.length}" data-x0="${x0}" data-x1="${x1}">`;
  if (!o.noAxis) s += yAxis(ticks(lo, ex[1], o.nTicks || 3, o.unit), y, x0, x1, fmtY);
  if (o.goal != null) s += `<line class="goal" x1="${x0}" x2="${x1}" y1="${r1(y(o.goal))}" y2="${r1(y(o.goal))}"/>`;
  const every = labelEvery(items.map((it) => it.label), step);
  // Werte über den Balken nur, wenn sie nebeneinander Platz haben
  const showVals = o.values && Math.max(...items.map((it) => (fin(it.v) ? String(fmtY(it.v)).length : 0))) * 4.9 <= step;
  const lastI = items.length - 1;
  const GAP = 2;
  items.forEach((it, i) => {
    const cx = x0 + step * (i + 0.5), bx = cx - bw / 2;
    if (it.parts && it.parts.length) {
      const ps = it.parts.filter((p) => p.v > 0);
      let base = 0;
      ps.forEach((p, j) => {
        const yTop = y(base + p.v), yBase = y(base);
        // Fuge zum Teil darunter; der oberste bekommt das gerundete Ende
        const hh = Math.max(0.5, yBase - yTop - (j ? GAP : 0));
        s += `<path class="${esc(p.cls)}" d="${barPath(bx, yTop, bw, hh, j === ps.length - 1 ? Math.min(4, bw / 2) : 0)}"/>`;
        base += p.v;
      });
    } else if (fin(it.v) && (it.v > 0 || !zero)) {
      s += `<path class="bar${it.cur ? ' cur' : ''}${it.cls ? ' ' + esc(it.cls) : ''}" d="${barPath(bx, y(it.v), bw, Math.max(0.5, bot - y(it.v)), Math.min(4, bw / 2))}"/>`;
    }
    if (showVals && fin(it.v) && (it.v > 0 || !zero)) s += `<text class="bar-v${it.cur ? ' cur' : ''}" x="${r1(cx)}" y="${r1(y(it.v)) - 4}" text-anchor="middle">${esc(fmtY(it.v))}</text>`;
    // Von hinten zählen: Die letzte (laufende) Beschriftung steht immer da
    if ((lastI - i) % every === 0) s += `<text class="ax${it.cur ? ' cur' : ''}" x="${r1(cx)}" y="${h - 4}" text-anchor="middle">${esc(it.label)}</text>`;
  });
  s += `<line class="cursor hidden" x1="0" x2="0" y1="${top}" y2="${bot}"/>`;
  return s + '</svg>';
}

/* ── Streudiagramm ──────────────────────────────────────────── */
function scatter(pts, o) {
  o = o || {};
  const h = o.h || 180, x0 = 36, x1 = W - 8, top = 10, bot = h - 22;
  const ex = extent([pts.map((p) => p.x)]), ey = extent([pts.map((p) => p.y)]);
  if (!ex || !ey) return '';
  const x = scale(ex[0], ex[1], x0, x1), y = scale(ey[0], ey[1], bot, top);
  const fx = o.fmtX || String, fy = o.fmtY || String;
  let s = `<svg class="chart-svg" viewBox="0 0 ${W} ${h}">`;
  s += yAxis(ticks(ey[0], ey[1], 3), y, x0, x1, fy);
  for (const v of ticks(ex[0], ex[1], 4)) s += `<text class="ax" x="${r1(x(v))}" y="${h - 6}" text-anchor="middle">${esc(fx(v))}</text>`;
  // Drittelgrenzen: dort trennt die Auswertung „wenig" von „viel"
  for (const v of [o.xLo, o.xHi]) if (fin(v)) s += `<line class="split" x1="${r1(x(v))}" x2="${r1(x(v))}" y1="${top}" y2="${bot}"/>`;
  for (const p of pts) s += `<circle class="pt sc" cx="${r1(x(p.x))}" cy="${r1(y(p.y))}" r="3"/>`;
  if (o.fit && pts.length > 2) {
    const mx = pts.reduce((a, p) => a + p.x, 0) / pts.length, my = pts.reduce((a, p) => a + p.y, 0) / pts.length;
    let sxy = 0, sxx = 0;
    for (const p of pts) { sxy += (p.x - mx) * (p.y - my); sxx += (p.x - mx) ** 2; }
    if (sxx) {
      const k = sxy / sxx, f = (v) => my + k * (v - mx);
      s += `<line class="fit" x1="${r1(x(ex[0]))}" y1="${r1(y(f(ex[0])))}" x2="${r1(x(ex[1]))}" y2="${r1(y(f(ex[1])))}"/>`;
    }
  }
  if (o.xLabel) s += `<text class="ax" x="${x1}" y="${bot - 6}" text-anchor="end">${esc(o.xLabel)} →</text>`;
  return s + '</svg>';
}

/* ── Belastung ──────────────────────────────────────────────── */
/** Akute Belastung (7 Tage) als Linie mit Fläche, chronische (Wochenmittel
    über 28 Tage) als ruhige Linie, dazu der gut verträgliche Bereich
    0,8–1,3 × chronisch. */
function load(rows, o) {
  o = o || {};
  const h = o.h || 180, x0 = 36, x1 = W - 8, top = 10, bot = h - 20;
  const n = rows.length;
  if (!n) return '<div class="chart-empty">Noch keine Belastungsdaten</div>';
  const ac = rows.map((r) => r.acute), ch = rows.map((r) => r.chronic);
  const ex = extent([ac, ch.map((v) => v * 1.3)], true);
  if (!ex) return '<div class="chart-empty">Noch keine Belastungsdaten</div>';
  const step = (x1 - x0) / n, x = (i) => x0 + step * (i + 0.5), y = scale(0, ex[1], bot, top);
  const xs = rows.map((_, i) => x(i));
  const a = areaDef();
  let s = `<svg class="chart-svg" viewBox="0 0 ${W} ${h}" data-n="${n}" data-x0="${x0}" data-x1="${x1}">${a.def}`;
  s += yAxis(ticks(0, ex[1], 3), y, x0, x1, (v) => Math.round(v));
  s += `<path class="band-ok" d="${bandPath(xs, ch.map((v) => y(v * 0.8)), ch.map((v) => y(v * 1.3)))}"/>`;
  s += `<path class="area" fill="url(#${a.id})" d="${areaPath(xs, ac.map(y), bot)}"/>`;
  s += `<path class="ln-chronic" d="${path(xs, ch.map(y))}"/>`;
  s += `<path class="ln-avg" d="${path(xs, ac.map(y))}"/>`;
  s += endDot(xs[n - 1], y(ac[n - 1]));
  for (const t of dateTicks(rows.map((r) => r.date))) s += `<text class="ax" x="${r1(x(t.i))}" y="${h - 4}" text-anchor="middle">${esc(t.t)}</text>`;
  s += `<line class="cursor hidden" x1="0" x2="0" y1="${top}" y2="${bot}"/>`;
  return s + '</svg>';
}

/* ── Aktivität: Strecke und Kurven ──────────────────────────── */

/** Strecke als Linie, in fünf Stufen nach `vals` eingefärbt (Puls oder
    Tempo). Ohne Kartenhintergrund: der käme von einem Kachelserver, und die
    App lädt nichts von fremden Servern nach. */
function track(pts, vals, o) {
  o = o || {};
  const h = o.h || 230, padd = 12;
  if (!pts || pts.length < 2) return '';
  let la0 = Infinity, la1 = -Infinity, lo0 = Infinity, lo1 = -Infinity;
  for (const [la, lo] of pts) { la0 = Math.min(la0, la); la1 = Math.max(la1, la); lo0 = Math.min(lo0, lo); lo1 = Math.max(lo1, lo); }
  // Längengrade werden zum Pol hin schmaler — sonst wäre die Strecke in Deutschland zu breit
  const k = Math.cos(((la0 + la1) / 2) * Math.PI / 180);
  const dw = (lo1 - lo0) * k || 1e-6, dh = (la1 - la0) || 1e-6;
  const sc = Math.min((W - 2 * padd) / dw, (h - 2 * padd) / dh);
  const ox = (W - dw * sc) / 2, oy = (h - dh * sc) / 2;
  const px = (lo) => ox + (lo - lo0) * k * sc, py = (la) => h - oy - (la - la0) * sc;
  const good = (vals || []).filter(fin);
  const q = good.length > 10 ? [0.2, 0.4, 0.6, 0.8].map((p) => good.slice().sort((a, b) => a - b)[Math.floor(p * (good.length - 1))]) : null;
  const lvl = (v) => (!q || !fin(v) ? 0 : 1 + q.filter((t) => v > t).length);
  let s = `<svg class="track" viewBox="0 0 ${W} ${h}" aria-label="Strecke">`;
  s += `<path class="tr-under" d="${'M' + pts.map(([la, lo]) => `${r1(px(lo))} ${r1(py(la))}`).join('L')}"/>`;
  // Gleiche Stufe hintereinander zu einem Pfad zusammenfassen: 400 Einzellinien wären zäh
  let cur = -1, d = '';
  for (let i = 1; i < pts.length; i++) {
    const l = lvl(vals ? vals[Math.round((i * (vals.length - 1)) / (pts.length - 1))] : null);
    const seg = `M${r1(px(pts[i - 1][1]))} ${r1(py(pts[i - 1][0]))}L${r1(px(pts[i][1]))} ${r1(py(pts[i][0]))}`;
    if (l !== cur && d) { s += `<path class="tr tr${cur}" d="${d}"/>`; d = ''; }
    cur = l; d += seg;
  }
  if (d) s += `<path class="tr tr${cur}" d="${d}"/>`;
  const [sa, so] = pts[0], [ea, eo] = pts[pts.length - 1];
  s += `<circle class="tr-start" cx="${r1(px(so))}" cy="${r1(py(sa))}" r="5"/><circle class="tr-end" cx="${r1(px(eo))}" cy="${r1(py(ea))}" r="5"/>`;
  return s + '</svg>';
}

/** Kurve über Zeit oder Strecke (Puls, Tempo, Höhe). o.cls färbt sie
    (c-hr, c-hrv, c-bb, c-spo2, c-alt), o.fill legt eine Verlaufsfläche
    darunter. o.marks: Zeitpunkte (in der Einheit von xs), die als
    senkrechter Strich markiert werden. */
function curve(xs, ys, o) {
  o = o || {};
  const h = o.h || 130, x0 = 36, x1 = W - 8, top = 10, bot = h - 20;
  const ey = extent([ys], o.zero);
  const good = xs.filter(fin);
  if (!ey || good.length < 2) return '';
  const x = scale(good[0], good[good.length - 1], x0, x1), y = scale(ey[0], ey[1], bot, top);
  const X = xs.map((v) => (fin(v) ? x(v) : null)), Y = ys.map((v) => (fin(v) ? (o.invert ? y(ey[1] - v + ey[0]) : y(v)) : null));
  const fy = o.fmtY || String, fx = o.fmtX || String;
  const a = areaDef();
  let s = `<svg class="chart-svg${o.cls ? ' ' + esc(o.cls) : ''}" viewBox="0 0 ${W} ${h}" data-n="${xs.length}" data-x0="${x0}" data-x1="${x1}">${a.def}`;
  const yt = ticks(ey[0], ey[1], 3, o.unit).filter((v) => v >= ey[0] && v <= ey[1]);
  s += yt.map((v) => {
    const yy = o.invert ? y(ey[1] - v + ey[0]) : y(v);
    return `<line class="grid" x1="${x0}" x2="${x1}" y1="${r1(yy)}" y2="${r1(yy)}"/><text class="ax" x="${x0 - 6}" y="${r1(yy) + 3}" text-anchor="end">${esc(fy(v))}</text>`;
  }).join('');
  if (o.fill) s += `<path class="area" fill="url(#${a.id})" d="${areaPath(X, Y, bot)}"/>`;
  s += `<path class="ln-c" d="${path(X, Y)}"/>`;
  // Markierte Zeitpunkte (Pulsspitzen der Nacht): Strich über die ganze Höhe, Punkt oben
  for (const v of o.marks || []) {
    if (!fin(v) || v < good[0] || v > good[good.length - 1]) continue;
    const mx = r1(x(v));
    s += `<line class="mk" x1="${mx}" x2="${mx}" y1="${top + 6}" y2="${bot}"/><circle class="mk-d" cx="${mx}" cy="${top + 3}" r="2.6"/>`;
  }
  // Zeitachse in Minuten-Schritten (60 s), nicht bei 1000 s
  for (const v of ticks(good[0], good[good.length - 1], 4, o.xUnit || 60)) s += `<text class="ax" x="${r1(x(v))}" y="${h - 4}" text-anchor="middle">${esc(fx(v))}</text>`;
  s += `<line class="cursor hidden" x1="0" x2="0" y1="${top}" y2="${bot}"/>`;
  return s + '</svg>';
}

/* ── Schlafphasen über die Nacht ────────────────────────────── */
/** Blöcke in Bahnen über die Nacht. rows: [[Beschriftung, Klasse]] von
    oben nach unten, segs: [[von, bis, Bahn]] in Uhrzeit-Minuten (Achse wie
    xs). xs ist das Raster der übrigen Nachtkurven: gleiche Achse, gleiches
    Antippen. */
function lanes(xs, segs, rows, o) {
  o = o || {};
  const lane = 22, x0 = 44, x1 = W - 8, top = 4, bot = top + lane * rows.length, h = bot + 20;
  const n = xs.length;
  if (n < 2 || !segs.length) return '';
  const x = scale(xs[0], xs[n - 1], x0, x1);
  let s = `<svg class="chart-svg" viewBox="0 0 ${W} ${h}" data-n="${n}" data-x0="${x0}" data-x1="${x1}">`;
  rows.forEach(([l], i) => {
    s += `<line class="grid" x1="${x0}" x2="${x1}" y1="${r1(top + lane * (i + 1))}" y2="${r1(top + lane * (i + 1))}"/>`
      + `<text class="ax" x="${x0 - 6}" y="${r1(top + lane * (i + 0.5) + 3)}" text-anchor="end">${esc(l)}</text>`;
  });
  for (const [a, b, k] of segs) {
    const xa = Math.max(x0, x(a)), xb = Math.min(x1, x(b));
    if (xb <= xa) continue;
    s += `<rect class="${rows[k][1]}" x="${r1(xa)}" y="${r1(top + lane * k + 2)}" width="${r1(Math.max(0.6, xb - xa))}" height="${lane - 4}" rx="2"/>`;
  }
  for (const v of ticks(xs[0], xs[n - 1], 4, 60)) s += `<text class="ax" x="${r1(x(v))}" y="${h - 4}" text-anchor="middle">${esc((o.fmtX || String)(v))}</text>`;
  s += `<line class="cursor hidden" x1="0" x2="0" y1="${top}" y2="${bot}"/>`;
  return s + '</svg>';
}

/** Phasen in vier Bahnen, Wach oben, Tief unten. segs: [[von, bis, Stufe]],
    Stufe 0 Tief, 1 Leicht, 2 REM, 3 Wach. */
function hypno(xs, segs, o) {
  const rows = [['Wach', 'ph-awake'], ['REM', 'ph-rem'], ['Leicht', 'ph-light'], ['Tief', 'ph-deep']];
  return lanes(xs, segs.map(([a, b, k]) => [a, b, 3 - k]), rows, o);
}

/* ── Mini-Balken für Wochentage ─────────────────────────────── */
function weekdays(vals, o) {
  o = o || {};
  const lbl = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  const good = vals.filter(fin);
  if (!good.length) return '';
  let lo = Math.min(...good), hi = Math.max(...good);
  // Nicht bei 0 anfangen: Unterschiede von 20 Minuten Schlaf sähen sonst gleich aus
  const span = hi - lo || Math.abs(hi) * 0.1 || 1;
  lo -= span * 0.6; hi += span * 0.15;
  const h = 104, bot = h - 20, top = 16, step = W / 7, bw = Math.min(24, step * 0.6);
  const y = scale(lo, hi, bot, top);
  let s = `<svg class="chart-svg" viewBox="0 0 ${W} ${h}">`;
  vals.forEach((v, i) => {
    const cx = step * (i + 0.5);
    if (fin(v)) {
      s += `<path class="bar${o.mark === i ? ' cur' : ''}" d="${barPath(cx - bw / 2, y(v), bw, bot - y(v), 4)}"/>`;
      s += `<text class="bar-v${o.mark === i ? ' cur' : ''}" x="${r1(cx)}" y="${r1(y(v)) - 4}" text-anchor="middle">${esc((o.fmtY || String)(v))}</text>`;
    }
    s += `<text class="ax${o.mark === i ? ' cur' : ''}" x="${r1(cx)}" y="${h - 4}" text-anchor="middle">${lbl[i]}</text>`;
  });
  return s + '</svg>';
}

return { gauge, spark, trend, bars, scatter, load, track, curve, lanes, hypno, weekdays, ticks, dateTicks, esc };
})();

if (typeof module === 'object' && module.exports) module.exports = Charts;
