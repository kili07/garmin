'use strict';
/* ═══════════════════════════════════════════════════════════════
   Garmin-Übersicht — Aktivitätsdateien lesen (ZIP und FIT)

   Garmin liefert die Originaldatei einer Aktivität als ZIP mit einer
   .fit darin. Beides wird hier ohne Bibliothek entpackt und gelesen — die
   offizielle FIT-Bibliothek wäre ein npm-Paket mit 1 MB Profil, gebraucht
   werden aber nur vier Nachrichtentypen: Datei, Sitzung, Runde, Messpunkt.

   Eigenständig und ohne DOM, damit tests/fit-test.js die Datei in Node gegen
   echte FIT-Dateien und gegen Garmins eigenen Decoder prüfen kann.

   Format: FIT Protocol (developer.garmin.com/fit/protocol)
   ═══════════════════════════════════════════════════════════════ */

const Fit = (() => {

/* ── ZIP ────────────────────────────────────────────────────── */

/** Entpacken mit dem Browser-eigenen Decoder. Node 18 kennt 'deflate-raw'
    noch nicht; die Tests reichen dort zlib herein. */
async function inflateRaw(u8) {
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Alle Dateien eines ZIP. Gelesen wird über das Inhaltsverzeichnis am Ende,
    nicht über die lokalen Köpfe: Bei gestreamt erzeugten ZIPs steht die
    Größe dort als 0, die richtige nur im Verzeichnis. */
async function unzip(buf, inflate) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Keine ZIP-Datei');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = [];
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    const start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
    const raw = u8.subarray(start, start + csize);
    if (name.endsWith('/')) continue;                      // Ordner
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = await (inflate || inflateRaw)(raw);
    else throw new Error('ZIP-Verfahren ' + method + ' wird nicht unterstützt');
    out.push({ name, data });
  }
  return out;
}

/* ── FIT ────────────────────────────────────────────────────── */

const FIT_EPOCH = 631065600;                 // 31.12.1989 00:00 UTC in Unix-Sekunden
const SEMI = 180 / 2147483648;               // Semicircles → Grad

/* Grundtypen nach den unteren fünf Bits: [Größe, Lesefunktion, ungültiger Wert] */
const BASE = {
  0: [1, 'u8', 0xFF], 1: [1, 's8', 0x7F], 2: [1, 'u8', 0xFF], 3: [2, 's16', 0x7FFF], 4: [2, 'u16', 0xFFFF],
  5: [4, 's32', 0x7FFFFFFF], 6: [4, 'u32', 0xFFFFFFFF], 7: [1, 'str', null], 8: [4, 'f32', null], 9: [8, 'f64', null],
  10: [1, 'u8', 0], 11: [2, 'u16', 0], 12: [4, 'u32', 0], 13: [1, 'u8', 0xFF],
  14: [8, 'skip', null], 15: [8, 'skip', null], 16: [8, 'skip', null],
};

/* Gebrauchte Felder je Nachricht: Feldnummer → [Name, Teiler, Versatz].
   Wert = roh / Teiler − Versatz. */
const MSG = {
  0: { name: 'file', f: { 0: ['type'], 1: ['manufacturer'], 2: ['product'], 4: ['created'] } },
  18: { name: 'session', f: {
    253: ['ts'], 2: ['start'], 5: ['sport'], 6: ['subSport'], 7: ['elapsed', 1000], 8: ['timer', 1000],
    9: ['dist', 100], 11: ['kcal'], 14: ['spd', 1000], 15: ['spdMax', 1000], 16: ['hr'], 17: ['hrMax'],
    18: ['cad'], 20: ['pwr'], 22: ['gain'], 23: ['loss'], 124: ['espd', 1000], 125: ['espdMax', 1000],
  } },
  19: { name: 'lap', f: {
    253: ['ts'], 2: ['start'], 7: ['elapsed', 1000], 8: ['timer', 1000], 9: ['dist', 100], 11: ['kcal'],
    13: ['spd', 1000], 14: ['spdMax', 1000], 15: ['hr'], 16: ['hrMax'], 17: ['cad'], 19: ['pwr'],
    21: ['gain'], 22: ['loss'], 110: ['espd', 1000], 111: ['espdMax', 1000],
  } },
  20: { name: 'record', f: {
    253: ['ts'], 0: ['lat', 0, 0, SEMI], 1: ['lon', 0, 0, SEMI], 2: ['alt', 5, 500], 3: ['hr'], 4: ['cad'],
    5: ['dist', 100], 6: ['spd', 1000], 7: ['pwr'], 13: ['temp'], 73: ['espd', 1000], 78: ['ealt', 5, 500],
  } },
};

function readVal(dv, p, kind, little) {
  switch (kind) {
    case 'u8': return dv.getUint8(p);
    case 's8': return dv.getInt8(p);
    case 'u16': return dv.getUint16(p, little);
    case 's16': return dv.getInt16(p, little);
    case 'u32': return dv.getUint32(p, little);
    case 's32': return dv.getInt32(p, little);
    case 'f32': return dv.getFloat32(p, little);
    case 'f64': return dv.getFloat64(p, little);
    default: return null;
  }
}

/** FIT-Datei lesen. Liefert Datei-Kopf, Sitzungen, Runden und Messpunkte;
    Zeitstempel als Unix-Sekunden. Mehrere aneinandergehängte FIT-Dateien
    (kommt bei manchen Geräten vor) werden nacheinander gelesen. */
function parse(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const res = { file: null, sessions: [], laps: [], records: [] };
  let off = 0;
  while (off + 12 <= u8.length) {
    const hsize = u8[off];
    if (hsize < 12 || String.fromCharCode(u8[off + 8], u8[off + 9], u8[off + 10], u8[off + 11]) !== '.FIT') {
      if (off === 0) throw new Error('Keine FIT-Datei');
      break;
    }
    const dataSize = dv.getUint32(off + 4, true);
    const end = Math.min(off + hsize + dataSize, u8.length);
    parseRecords(u8, dv, off + hsize, end, res);
    off = end + 2;                                      // 2 Byte Prüfsumme
  }
  return res;
}

function parseRecords(u8, dv, p, end, res) {
  const defs = [];
  let lastTs = 0;
  while (p < end) {
    const h = u8[p++];
    let local, tsOffset = null;
    if (h & 0x80) {
      // Kompakter Kopf: Zeitstempel als 5-Bit-Versatz zum letzten vollen
      local = (h >> 5) & 0x03;
      tsOffset = h & 0x1F;
    } else if (h & 0x40) {
      // Definition: legt fest, wie die folgenden Datensätze dieses Typs aussehen
      const little = u8[p + 1] === 0;
      const global = dv.getUint16(p + 2, little);
      const nf = u8[p + 4];
      p += 5;
      const fields = [];
      for (let i = 0; i < nf; i++, p += 3) fields.push([u8[p], u8[p + 1], u8[p + 2] & 0x1F]);
      let devSize = 0;
      if (h & 0x20) {
        const nd = u8[p++];
        for (let i = 0; i < nd; i++, p += 3) devSize += u8[p + 1];
      }
      defs[h & 0x0F] = { global, little, fields, devSize };
      continue;
    } else {
      local = h & 0x0F;
    }

    const def = defs[local];
    if (!def) throw new Error('FIT: Datensatz ohne Definition');
    const spec = MSG[def.global];
    const msg = spec ? {} : null;
    for (const [num, size, bt] of def.fields) {
      if (msg) {
        const f = spec.f[num];
        const b = BASE[bt] || [size, 'skip', null];
        if (f && b[1] !== 'skip' && b[1] !== 'str' && size === b[0]) {
          const raw = readVal(dv, p, b[1], def.little);
          const invalid = b[2] !== null ? raw === b[2] : !isFinite(raw);
          if (!invalid) {
            let v = raw;
            if (f[3]) v = raw * f[3];
            else if (f[1]) v = raw / f[1] - (f[2] || 0);
            else if (f[2]) v = raw - f[2];
            msg[f[0]] = v;
          }
        }
      }
      p += size;
    }
    p += def.devSize;

    if (msg && msg.ts != null) lastTs = msg.ts;
    if (tsOffset != null) {
      let ts = (lastTs & ~0x1F) + tsOffset;
      if (tsOffset < (lastTs & 0x1F)) ts += 0x20;
      lastTs = ts;
      if (msg) msg.ts = ts;
    }
    if (!msg) continue;
    for (const k of ['ts', 'start', 'created']) if (msg[k] != null) msg[k] += FIT_EPOCH;
    // Die „enhanced"-Felder nur, wo das normale fehlt. So hält es auch Garmins
    // Decoder; in Testdateien widersprechen sich beide schon mal (0 gegen 4,6 m/s).
    for (const [e, k] of [['ealt', 'alt'], ['espd', 'spd'], ['espdMax', 'spdMax']]) {
      if (msg[e] != null && msg[k] == null) msg[k] = msg[e];
      delete msg[e];
    }
    if (spec.name === 'record') res.records.push(msg);
    else if (spec.name === 'lap') res.laps.push(msg);
    else if (spec.name === 'session') res.sessions.push(msg);
    else if (spec.name === 'file' && !res.file) res.file = msg;
  }
}

/* ── Aufbereitung für die Anzeige ───────────────────────────── */

/** Messpunkte auf höchstens `max` Stützstellen verdichten (Mittel je
    Abschnitt) — eine Stunde Laufen hat 3600 Punkte, ein Handy-Diagramm
    braucht 400. Strecke: jeweils der letzte gültige Punkt des Abschnitts. */
function streams(fit, max) {
  const rec = fit.records.filter((r) => r.ts != null);
  if (!rec.length) return null;
  const t0 = (fit.sessions[0] && fit.sessions[0].start) || rec[0].ts;
  const n = Math.min(max || 400, rec.length);
  const keys = ['hr', 'spd', 'alt', 'cad', 'pwr', 'dist'];
  const out = { t: [], track: [] };
  keys.forEach((k) => { out[k] = []; });
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * rec.length) / n), b = Math.floor(((i + 1) * rec.length) / n);
    const part = rec.slice(a, Math.max(b, a + 1));
    out.t.push(Math.round(part[part.length - 1].ts - t0));
    for (const k of keys) {
      const vals = part.map((r) => r[k]).filter((v) => v != null && isFinite(v));
      out[k].push(vals.length ? (k === 'dist' ? vals[vals.length - 1] : vals.reduce((s, v) => s + v, 0) / vals.length) : null);
    }
    for (let j = part.length - 1; j >= 0; j--) {
      const r = part[j];
      // (0,0) liegt im Golf von Guinea und heißt bei manchen Geräten „kein GPS"
      if (r.lat != null && r.lon != null && (r.lat || r.lon)) {
        out.track.push([+r.lat.toFixed(6), +r.lon.toFixed(6)]);
        break;
      }
    }
  }
  for (const k of keys) if (!out[k].some((v) => v != null)) delete out[k];
  if (!out.track.length) delete out.track;
  out.laps = fit.laps.map((l) => ({
    dur: l.timer != null ? l.timer : l.elapsed, dist: l.dist, spd: l.spd, hr: l.hr, hrMax: l.hrMax,
    cad: l.cad, pwr: l.pwr, gain: l.gain,
  }));
  return out;
}

/** Originaldatei (ZIP oder nackte FIT) → Messreihen. */
async function fromDownload(buf, inflate) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const isFit = u8.length > 12 && String.fromCharCode(u8[8], u8[9], u8[10], u8[11]) === '.FIT';
  let fitBytes = isFit ? u8 : null;
  if (!fitBytes) {
    const files = await unzip(u8, inflate);
    const f = files.find((x) => /\.fit$/i.test(x.name));
    if (!f) {
      const ext = files.length ? (files[0].name.split('.').pop() || '').toUpperCase() : '';
      throw new Error(ext ? `Die Originaldatei ist ${ext}, nicht FIT — die Kurven gibt es nur für FIT-Dateien.` : 'Die Datei ist leer.');
    }
    fitBytes = f.data;
  }
  return streams(parse(fitBytes), 400);
}

return { unzip, parse, streams, fromDownload, FIT_EPOCH };
})();

if (typeof module === 'object' && module.exports) module.exports = Fit;
