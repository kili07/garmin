# Garmin-Übersicht

Vorrang hat `PWA-ANLEITUNG.md` (Stack, harte Regeln, Upload). Entscheidungen stehen in `DECISIONS.md`, offene
Punkte in `OFFEN.md`. Diese Datei beschreibt das **Designsystem** (seit 2.0.0). Es gilt für jede Änderung am
Aussehen.

## Richtung (4.0.0 „Radcomputer")

Die Anzeige eines Radcomputers, zuerst fürs Handy. Graugrünes LCD-Feld, schwarze Ziffern, schmale fette
Anzeigeziffern (Saira, `font-stretch` 62 %), harte 2-px-Rahmen in `--ink`, keine Rundung. Merkmal: der Hauptwert
(Hero) ist invertiert. Hell ist der Standard (LCD bei Tag), dunkel ist das beleuchtete Display bei Nacht. Farbe
gehört nur den Daten. Keine Logos, Markennamen oder Designs anderer Apps; Garmin erscheint nur im Text als
Datenquelle.

## Tokens

Alle Werte stehen in **`tokens.css`**, der einzigen Quelle. `style.css` und die Diagramme (über ihre Klassen)
benutzen nur diese Variablen. Feste Farben in Komponenten sind verboten. Neue Farbe → neues Token in beiden Themes.
Die Radcomputer-Regeln stehen gesammelt am Ende von `style.css` (Abschnitt 12).

| Rolle | Token | Hell (Standard) | Dunkel |
|---|---|---|---|
| Grund, Feld | `--bg` / `--surface` | `#D3DACD` | `#0E130E` |
| Gedrückt, Mulde | `--surface-2` / `--surface-3` | `#C5CEBF` / `#B8C2B1` | `#182018` / `#212B21` |
| Rahmen der Felder | `--ink` | `#131A13` | `#CFDCC8` |
| Feine Trenner | `--line` / `--line-2` | `#A9B4A3` / `#9AA694` | `#2C382C` / `#3A483A` |
| Text | `--text` / `--text-2` / `--muted` | `#131A13` / `#2F3A2F` / `#3C473C` | `#E2EADD` / `#B5C2AE` / `#93A18C` |
| Invertiertes Feld | `--inv-bg` / `--inv-text` | `#131A13` / `#D3DACD` | `#CFDCC8` / `#0E130E` |
| Akzent = Tinte | `--accent` | `#131A13` | `#CFDCC8` |
| Zustände | `--st-low` / `--st-mid` / `--st-high` | `#9A2E22` / `#7A4F00` / `#0B5E48` | `#F29A86` / `#E5C680` / `#7FD8B4` |

Dazu je Zustand eine blasse Fläche (`--st-low-soft` …), Diagramm-Tokens (`--grid`, `--ax`, `--pt`, `--avg`,
`--area-op` für die Deckkraft der Verlaufsfläche, `--band`, `--bar`, `--bar-dim`), Schlafphasen (`--ph-*`),
Pulszonen (`--z1`–`--z5`), Sportarten (`--sp-*`) und Nachtkurven (`--c-*`). Phasen, Zonen und Sportarten sind mit
dem Farbenblindheits-Prüfer der dataviz-Skill gerechnet (Nachbarn trennbar). Nicht nach Gefühl ändern, sondern
neu prüfen.

Maße und Schrift, themenunabhängig:

| Was | Token | Wert |
|---|---|---|
| Raster | `--s1` … `--s6` | 8, 16, 24, 32, 40, 48 px; `--s-half` 4 px nur innerhalb kleiner Bausteine |
| Seitenrand, Karten-Innenabstand | `--pad` | 16 px |
| Radien | `--r-card` / `--r-sm` / `--r-sheet` | 0 px; `--r-pill` 999 px nur für Punkte; Rahmen `--bw` 2 px |
| Kennzahlen | `--font-num` | Saira 800, `font-stretch:var(--stretch-num)`, `tabular-nums` |
| Alles andere | `--font-ui` | Saira |
| Zahlengrößen | `--fs-hero` / `--fs-big` / `--fs-card` / `--fs-stat` | 96 / 64 / 44 / 26 px |
| Text | `--fs-body` / `--fs-small` / `--fs-label` | 15 / 14 / 13 px |
| Bewegung | `--ease-out`, `--t-fill` | `cubic-bezier(.33,1,.68,1)`, 600 ms |

Die alten Namen aus 1.x (`--sp-1` … `--sp-6`, `--up`, `--down`, `--warn`, `--r`, `--r-lg` …) sind in `tokens.css`
nur noch Aliasse. Neue Bausteine nehmen die neuen Namen.

## Regeln

- **Labels** klein, normale Schreibweise, `--text-2`: Klasse `.lbl`.
- **Kennzahlen** immer in `--font-num` mit `tabular-nums` (Klasse `.num`), Einheit klein daneben.
- **Karten**: Anzeigefelder, `--surface`, Rahmen `--bw` in `--ink`, keine Rundung, kein Schatten. Abstände nur aus dem 8er-Raster.
- **Akzent** (die Tinte, aktive Wahl invertiert) nur für primäre Aktionen, den aktiven Zustand (Tab, Segment, Chip) und die Hauptlinie
  eines Diagramms. Nicht als Dekoration.
- **Zustände** über die Skala Koralle → Sand → Mint. Die Klassen `st-bad`, `st-warn`, `st-good` (`st-ok` und
  `st-off` neutral) setzen sie um. Nie Farbe allein: immer mit Zahl, Wort oder Pfeil. Keine reinen Ampelfarben.
- **Icons**: Lucide (ISC, `licenses/lucide-ISC.txt`), als inline-SVG mit `stroke="currentColor"`,
  `stroke-width` 2. Pfade aus dem Lucide-Paket übernehmen, nicht selbst zeichnen.
- **Diagramme** von Hand als SVG in `charts.js`: Linien 2 px, darunter eine Verlaufsfläche in der Farbe der
  Reihe (oben `--area-op`, unten 0), Gitter 1 px durchgezogen, Balken höchstens 24 px breit mit 4 px gerundetem
  Ende, Endpunkte mit 2 px Ring in Kartenfarbe. Die Farbe einer Reihe kommt als Klasse ans SVG (`c-hr` …) und
  steht dort als `--cc`. Keine zweite y-Achse.
- **Bewegung**: Zahlen mit `data-count` zählen beim ersten Zeichnen einer Ansicht in 600 ms hoch, Gauges füllen
  sich in 600 ms (ease-out). Neuzeichnen durch den Abgleich animiert nicht erneut. Bei
  `prefers-reduced-motion` gibt es keine Animation, die Werte stehen sofort da.
- **Layout**: mobile first ab 375 px Breite, die Seite scrollt nie seitlich (Chip-Leisten scrollen in sich).
  Touch-Ziele mindestens 44 × 44 px.

## Bausteine

| Baustein | Wo |
|---|---|
| Hero: Schlafscore groß, invertiertes Feld | `renderToday`, `Charts.gauge`, `.hero` |
| Metrik-Karte: Label, Wert, Pill (Veränderung zum Vortag), Sparkline der letzten 7 Tage | `tile()`, `.mcard`, `.pill` |
| Eingabe-Karte: Icon im Kreis, Label, Wert, Schnellknopf daneben (zwei Knöpfe, nie verschachtelt) | `coffeeCard`, `.cof` |
| Detailansicht je Kennzahl: Segmented Control für den Zeitraum, Linie mit Verlaufsfläche, Einordnung als Text | `renderTrends`, `Charts.trend`, `.seg` |
| Untere Leiste: vier Felder mit Rahmen, aktives Feld invertiert | `index.html`, `.tabbar` |
| Sheet für jedes Formular und jeden Dialog | `openSheet`, `.sheet` |
