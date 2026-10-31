# Garmin-Übersicht

Vorrang hat `PWA-ANLEITUNG.md` (Stack, harte Regeln, Upload). Entscheidungen stehen in `DECISIONS.md`, offene
Punkte in `OFFEN.md`. Diese Datei beschreibt das **Designsystem** (seit 2.0.0). Es gilt für jede Änderung am
Aussehen.

## Richtung

Dunkles, datenfokussiertes Health-Dashboard, zuerst fürs Handy. Ruhig, technisch, hochwertig. Wenig Deko, die
Daten sind der Star. Keine Logos, Markennamen oder Designs anderer Apps; Garmin erscheint nur im Text als
Datenquelle.

## Tokens

Alle Werte stehen in **`tokens.css`**, der einzigen Quelle. `style.css` und die Diagramme (über ihre Klassen)
benutzen nur diese Variablen. Feste Farben in Komponenten sind verboten. Wer eine neue Farbe braucht, legt ein
Token an und bedient beide Themes (dunkel ist Standard, hell zieht mit). Änderst Du `tokens.css`, ziehst Du diese
Tabelle mit.

| Rolle | Token | Dunkel | Hell |
|---|---|---|---|
| Grund | `--bg` | `#0E1116` | `#F4F6F8` |
| Karte | `--surface` | `#171B22` | `#FFFFFF` |
| Mulde, gedrückt | `--surface-2` / `--surface-3` | `#1D2129` / `#252A34` | `#EDF0F4` / `#E4E8EE` |
| Rand (1px, statt Schatten) | `--line` | `#232833` | `#DFE3E9` |
| Spur, Trenner | `--line-2` | `#2F3642` | `#CFD5DC` |
| Text | `--text` / `--text-2` | `#EEF1F5` / `#B6BDC9` | `#13161C` / `#474D58` |
| Labels | `--muted` | `#8A93A3` | `#646C79` |
| Akzent | `--accent` (Text darauf `--on-accent`) | `#5EEAD4` (`#0E1116`) | `#007A6D` (`#FFFFFF`) |
| Zustand niedrig | `--st-low` | Koralle `#F8907F` | `#B94739` |
| Zustand mittel | `--st-mid` | Sand `#E8C586` | `#9C681A` |
| Zustand hoch | `--st-high` | Mint `#5EEAD4` | `#007A6D` |

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
| Radien | `--r-card` / `--r-pill` / `--r-sm` / `--r-sheet` | 16 / 999 / 8 / 24 px |
| Kennzahlen | `--font-num` | Space Grotesk 600, `tabular-nums` |
| Alles andere | `--font-ui` | Inter |
| Zahlengrößen | `--fs-hero` / `--fs-big` / `--fs-card` / `--fs-stat` | 72 / 48 / 30 / 20 px |
| Text | `--fs-body` / `--fs-small` / `--fs-label` | 15 / 13 / 11 px |
| Bewegung | `--ease-out`, `--t-fill` | `cubic-bezier(.33,1,.68,1)`, 600 ms |

Die alten Namen aus 1.x (`--sp-1` … `--sp-6`, `--up`, `--down`, `--warn`, `--r`, `--r-lg` …) sind in `tokens.css`
nur noch Aliasse. Neue Bausteine nehmen die neuen Namen.

## Regeln

- **Labels** klein, Großbuchstaben, Laufweite 0,08 em, `--muted`: Klasse `.lbl`.
- **Kennzahlen** immer in `--font-num` mit `tabular-nums` (Klasse `.num`), Einheit klein in Inter daneben.
- **Karten**: `--surface`, 1px `--line`, Radius 16 px, kein Schatten. Abstände nur aus dem 8er-Raster.
- **Akzent** (ein Mint) nur für primäre Aktionen, den aktiven Zustand (Tab, Segment, Chip) und die Hauptlinie
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
| Hero: Schlafscore groß im Halbkreis-Gauge | `renderToday`, `Charts.gauge`, `.hero` |
| Metrik-Karte: Label, Wert, Pill (Veränderung zum Vortag), Sparkline der letzten 7 Tage | `tile()`, `.mcard`, `.pill` |
| Eingabe-Karte: Icon im Kreis, Label, Wert, Schnellknopf daneben (zwei Knöpfe, nie verschachtelt) | `coffeeCard`, `.cof` |
| Detailansicht je Kennzahl: Segmented Control für den Zeitraum, Linie mit Verlaufsfläche, Einordnung als Text | `renderTrends`, `Charts.trend`, `.seg` |
| Untere Leiste mit vier Lucide-Icons, aktiver Tab in Mint | `index.html`, `.tabbar` |
| Sheet für jedes Formular und jeden Dialog | `openSheet`, `.sheet` |
