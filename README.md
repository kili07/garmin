# Garmin-Übersicht

Deine Garmin-Daten auf einen Blick, besser sortiert als in Garmin Connect: **Wie erholt bin ich heute?**,
**lange Trends über Monate und Jahre** und **welche Gewohnheiten bei Dir was bewirken**.

Reines HTML, CSS und JavaScript nach der Bauanleitung (`PWA-ANLEITUNG.md`): kein Build, keine Abhängigkeiten,
installierbar als Web-App, offline lesbar. Seit 2.0.0 ein dunkles, ruhiges Dashboard fürs Handy: die Zahlen groß in
Space Grotesk, alles andere in Inter, ein Akzent in Mint, Zustände von Koralle über Sand bis Mint. Schriften und
Icons (Lucide) liegen in der App, nachgeladen wird nichts. Das Designsystem steht in `CLAUDE.md`, die Werte in
`tokens.css`. Die Daten holt die App über Garmins offizielle **Personal API** mit Deinem
eigenen API-Schlüssel. Weil Garmin Aufrufe aus dem Browser ablehnt, läuft das über einen kleinen eigenen Proxy
(Cloudflare Worker, kostenlos). Warum, steht in `DECISIONS.md`.

## Was sie kann

**Heute**
- **Schlafscore** der letzten Nacht groß in einem Halbkreis, in der Farbe von Garmins Einordnung (gut, mittel,
  schwach), darunter Dauer gegen Bedarf, Puls und Aufwachen gegen Deinen Schnitt und die Phasen als Streifen.
- **Erholung:** HRV, Ruhepuls, Schlaf, Belastung und Body Battery, jedes Signal gegen *Deinen eigenen*
  Normalbereich der letzten Wochen, dazu eine Einschätzung in einem Satz. Garmins „Training Readiness“ gibt die
  API nicht her; die App zeigt stattdessen offen, woraus sich so ein Wert zusammensetzt.
- **Fitness-Score (0–100):** Wie fit bist Du gerade, aus den vier Wochen vor dem Tag, eine eigene Rechnung der
  App: VO2max gegen Garmins Tabelle für Dein Alter und Geschlecht (35 %), Intensitätsminuten pro Woche (25 %),
  Ruhepuls (15 %), Schritte (15 %) und aktive Tage pro Woche (10 %), jeder Teil gegen einen festen Maßstab.
  Dazu die Veränderung in vier Wochen. Antippen zeigt den Verlauf über sechs Monate, jeden Teil mit seinem Wert,
  wo am meisten zu holen ist und wie gerechnet wird. Jahrgang und Geschlecht lassen sich dort eintragen.
- Antippen des Schlafscores öffnet **die Nacht im Detail:**
  - jede Phase (Tief, Leicht, REM, Wach) mit Dauer, Anteil, Garmins Bewertung, Garmins Idealbereich und Deinem
    Schnitt der 30 Nächte davor,
  - Garmins Begründung zum Score („Lang, aber zu wenig REM“) und was vom Vortag hineinspielte, dazu Garmins
    Teilbewertungen für Dauer, Stress und Unruhe,
  - Puls, HRV, Atmung (mit Spanne), SpO2 (mit tiefstem Wert), Stress und Atemaussetzer, jeweils gegen Deinen Schnitt,
  - **Wann wach?** (seit 2.2.0): Garmin nennt nur, wie lange und wie oft Du wach warst, nicht wann. Die App zeigt
    auf der Zeitachse der Nacht, wo der Puls deutlich über Deinem Schlafniveau lag und wo die Uhr gar keinen Puls
    gemessen hat, mit Uhrzeit und Dauer, gegen Garmins Summe. Sieht man davon im Puls wenig, kommt Garmins
    Wachzeit vermutlich aus der Bewegung. Weißt Du, dass Du in einer Strecke geschlafen hast, tippst Du „Schlaf“
    (seit 2.3.0): Die App zieht sie von Garmins Wachzeit ab, zählt sie zum Schlaf und schätzt den Score neu, aus
    dem, wie Dein Score in Deinen Nächten von Dauer, Wachzeit und Aufwachen abhängt. Die korrigierte Nacht gilt
    überall, mit dem Vermerk „korrigiert“ und Garmins Wert daneben,
  - die Kurven der Nacht: Puls, HRV, Body Battery und SpO2 auf einer Zeitachse; antippen zeigt die Uhrzeit,
  - **Unruhe und Aufbau:** Pulsspitzen (der Puls springt kurz an, meist eine Weckreaktion) mit Uhrzeit, in der
    Pulskurve markiert, gegen Deinen Schnitt; wie sie sich über die Nacht verteilen, die längste ruhige Strecke und
    wann der Puls am tiefsten lag (früh heißt meist: schnell zur Ruhe gekommen). Mit Phasenverlauf auch Zyklen,
    Tiefschlaf in der ersten und REM in der zweiten Nachthälfte, erster Tief- und REM-Schlaf, Wachphasen,
  - Schlafbedarf: Grundbedarf, Bedarf dieser Nacht und wodurch Garmin ihn angepasst hat, Saldo der letzten sieben
    Nächte, am Morgen auch der Bedarf für die kommende Nacht mit empfohlener Bettzeit,
  - Rhythmus: Einschlafen, Aufwachen und Schlafmitte gegen Deinen Schnitt, wie gleichmäßig Du die letzten zwei
    Wochen eingeschlafen bist, Garmins optimales Schlaffenster, Nickerchen.

  Mit ‹ › geht es Nacht für Nacht zurück. Den Verlauf der Phasen über die Nacht (das Balkendiagramm aus Garmin
  Connect) gibt die Personal API laut Beschreibung nicht her, Garmins eigene „unruhige Momente“ (aus der Bewegung)
  ebenso wenig. Schickt Garmin sie doch mit, zeigt die App sie.
- **Kennzahlen** als Karten für HRV, Ruhepuls, Body Battery, Stress, Schritte, Intensitätsminuten (Woche), Belastung
  (7 Tage), VO2max, Gewicht, Atmung und SpO2. Jede mit Wert, der Veränderung zum Vortag als Pill (Mint besser,
  Koralle schlechter, grau ohne Richtung oder im Rauschen) und den letzten sieben Tagen als kleine Linie mit Deinem
  Normalbereich als Band; der letzte Punkt zeigt die Lage zum Normalbereich. Antippen öffnet den Trend.
- **Letzter Kaffee:** Unter dem Schlafscore trägst Du ein, wann Du zuletzt Kaffee getrunken hast. Heute reicht
  ein Tipp auf „Jetzt“ bei jeder Tasse, es zählt die letzte. Antippen der Karte öffnet die Eingabe mit Uhrzeit,
  „Kein Kaffee“ und den letzten sieben Tagen zum Nachtragen. Für vergangene Tage steht dabei, wie lange die Tasse
  vor dem Einschlafen lag. Garmin weiß davon nichts, der Eintrag bleibt auf dem Gerät und kommt ins Backup.
- **Woche auf einen Blick:** sieben Tage × sechs Werte als Tabelle, jede Zelle in der Farbe ihrer Abweichung.
- Mit ‹ › durch frühere Tage blättern.

**Trends** für 35 Kennzahlen (seit 2.1.0 auch Dein letzter Kaffee), darunter Leichtschlaf, Wachzeit, Aufwachen, Tiefschlaf- und REM-Anteil, Pulsspitzen,
Pulstiefpunkt, Schlafmitte, Schlafsaldo (7 Nächte), Puls und Stress im Schlaf. Zeitraum über einen Umschalter:
Woche, Monat, 3 Monate, Jahr oder alles. Oben das Mittel (bei Summen die Summe) mit der Veränderung zum Zeitraum
davor, darunter Tageswerte, 7-Tage-Mittel als Linie mit Verlaufsfläche und Dein Normalbereich als Band, dann eine
Einordnung in ganzen Sätzen (besser oder schlechter als davor, Tendenz pro Monat, wie viele Tage im Normalbereich
lagen). Dazu Wochen- oder Monatsbalken, Mittel je Wochentag und der Vergleich mit dem Vorjahr. Bei Schlaf-Kennzahlen zusätzlich die Phasen als gestapelte Balken: je Nacht
(4 Wochen), je Woche oder je Monat. Diagramme antippen zeigt den Wert an der Stelle.

**Training**
- Einheiten, Zeit und Distanz der Woche, des Monats oder des Jahres gegen den gleichen Abschnitt davor.
- Umfang je Woche nach Sportart, Belastung akut gegen chronisch (mit dem gut verträglichen Bereich), VO2max-Verlauf,
  Bestzeiten im Laufen (1 km bis Marathon, allzeit und dieses Jahr).
- Alle Aktivitäten nach Wochen, filterbar nach Sportart. Eine Aktivität zeigt alle Kennwerte und Pulszonen, dazu aus
  der Originaldatei (FIT) die **Strecke** (eingefärbt nach Puls oder Tempo), Puls-, Tempo-, Höhen-, Kadenz- und
  Leistungskurve und die Runden.

**Muster** hat zwei Reiter.

*Schlaf* erkennt Muster in Deinen Nächten:
- **Was Deine Nächte unterscheidet:** Die App drittelt die Nächte nach Aufwachen, Pulsspitzen, Garmins
  Unruhe-Bewertung, Wachzeit, Tiefschlaf- oder REM-Anteil oder Pulstiefpunkt und sucht selbst, worin sich das obere
  vom unteren Drittel unterscheidet: am Tag davor (Training, Abendtraining, Stress, Schritte, Nickerchen,
  Schlafmangel), in der Nacht (Einschlafzeit, Dauer, Wochenende, Puls, HRV, Atmung, die anderen Phasen) und am Tag
  danach (Ruhepuls, Body Battery, Stress). Oben die deutlichsten Unterschiede („Mehr Stress am Vortag: 35 statt 29“),
  darunter alle, die sich nicht durch Zufall erklären lassen.
- **Phasen:** was eine Stunde mehr Schlaf an Tief-, Leicht- und REM-Schlaf bringt (kurze Nächte kosten meist vor allem
  REM) und wie oft jede Phase in Garmins Idealbereich lag.
- **Unruhe:** wie oft Du pro Nacht aufwachst, Garmins Unruhe-Bewertung, ob unruhige Nächte gehäuft kommen und in
  welcher Stunde der Nacht die Pulsspitzen liegen.
- **Kaffee:** Die Tage werden nach der Uhrzeit des letzten Kaffees gedrittelt, verglichen werden die Nächte nach
  spätem und nach frühem Kaffee: Schlafscore, Einschlafzeit, Dauer, Tief- und REM-Anteil, Aufwachen, Wachzeit,
  Pulsspitzen, Puls, HRV und Pulstiefpunkt. Oben die deutlichsten Unterschiede („Niedrigerer Schlafscore: 71 statt
  83“), dazu wie lange die letzte Tasse meist vor dem Einschlafen lag und auf Wunsch alle Tage als Punkte. Tage
  ohne Kaffee haben einen eigenen Vergleich. Ab 20 eingetragenen Tagen mit einer Nacht danach; bis dahin zeigt die
  App, wie viele noch fehlen. Auch in „Was Deine Nächte unterscheidet“ zählt der Kaffee am Vortag mit.
- **Nach Wochentag:** Score, Dauer, Tief, REM und Aufwachen je Wochentag, auffällige Tage farbig.

Pulsspitzen und Pulstiefpunkt brauchen die Messreihen einer Nacht. Die App wertet bei jedem Abgleich bis zu drei
Nächte der letzten 60 Tage aus, neueste zuerst, dazu jede Nacht, die Du öffnest.

*Zusammenhänge:* Was hängt bei Dir womit zusammen? Training → HRV, Ruhepuls und Schlaf am nächsten Morgen; Abendtraining
→ Schlaf; Einschlafzeit → Schlafdauer und Score; Stress → Schlaf; Schlaf → Body Battery und Stress. Die Tage
werden gedrittelt, verglichen wird oberes gegen unteres Drittel. Was statistisch nicht von Zufall zu
unterscheiden ist, steht als „eher Zufall“ da. Dazu der Wochenrhythmus von Schlaf, Einschlafzeit, Schritten und
Stress.

## Was Garmins Personal API nicht liefert

Training Readiness, Training Status und Erholungszeit gibt es dort nicht. VO2max und Training Effect kommen nur je
Aktivität mit. Die App rechnet die Belastung (akut/chronisch) deshalb selbst aus den Aktivitäten.

## Einrichten

1. **Proxy:** siehe `proxy/ANLEITUNG.md`, einmalig etwa 10 Minuten. Die App führt Dich auch selbst durch
   (*Einstellungen → Wie richte ich ihn ein?*).
2. **Schlüssel:** Auf [connect.garmin.com → Personal API Key](https://connect.garmin.com/app/settings/personalApiToken)
   einen Schlüssel erzeugen (Laufzeit am besten 1 Jahr, Garmin zeigt ihn nur einmal) und in der App unter
   *Einstellungen* einfügen. Er bleibt auf dem Gerät und landet in keinem Backup.
3. **Speichern und Verbindung testen.** Danach lädt der erste Abgleich vier Wochen, dann rückwärts den Verlauf
   (1, 2 oder 5 Jahre, einstellbar). Ein Jahr sind etwa 50 Anfragen und ein, zwei Minuten.

Danach gleicht die App beim Öffnen von selbst ab, wenn der letzte Abgleich über eine Stunde her ist. Der Knopf
oben rechts gleicht sofort ab; während eines Abgleichs hält er ihn an.

Der Schlüssel läuft nach spätestens einem Jahr ab. Garmin schickt etwa eine Woche vorher eine Mail; dann einen neuen
erzeugen und in der App eintragen.

## Hochladen (erstes Mal)

1. Repo `garmin` auf [github.com/new](https://github.com/new) anlegen, **Public**, kein README anhaken.
2. *uploading an existing file* → den **Inhalt** von `upload/` hineinziehen (alles markieren, nicht den Ordner selbst).
   `index.html` muss im Wurzelverzeichnis liegen. **Nicht** hochladen: `tests/` (enthält Garmin-Testdateien unter
   deren Lizenz und den Schlüssel der Nachbildung), `.claude/`, Backups.
3. *Settings → Pages → Deploy from a branch, `main`, `/ (root)`* → Save.
4. Nach ein, zwei Minuten: `https://kili07.github.io/garmin/` am Handy in Chrome öffnen → Einstellungen →
   **App installieren**.

## Daten und Sicherung

Alle Daten liegen nur auf dem Gerät: Tageswerte und Aktivitäten in `localStorage` (`garmin.v1`, etwa 280 KB pro
Jahr), Kurven der Aktivitäten zwischengespeichert in IndexedDB (`garmin-files`). Schlüssel und Token liegen
getrennt (`garmin.key`, `garmin.token`). Garmin behält alles. Ein Backup (Einstellungen → Backup speichern) spart
aber den langen Neu-Abruf nach „Browserdaten löschen“. Ausnahme sind Deine Kaffee-Einträge: Die gibt es nur auf dem
Gerät und im Backup, Garmin kennt sie nicht.

## Entwickeln und testen

```
python3 tests/serve.py 8127          # App ohne HTTP-Cache
python3 tests/mock-garmin.py 8128    # Nachbildung von Proxy + Garmin mit erfundenen Daten
node tests/core-test.js              # Kernlogik
node tests/sleep-test.js             # Schlafmuster
node tests/fit-test.js               # FIT/ZIP gegen Garmins Testdateien
node tests/worker-test.mjs           # Proxy
```

In der App als Proxy `http://localhost:8128` eintragen, als Schlüssel den Inhalt von `tests/mock-key.txt`.
Vor jedem Neuladen Service Worker und Caches leeren (siehe Bauanleitung, Abschnitt 6).

## Dateien

| Datei | Inhalt |
|---|---|
| `index.html` | Gerüst, Kopf- und Tab-Leiste |
| `tokens.css` | Designtokens: Farben beider Themes, Schrift, Raster, Radien, Bewegung (beschrieben in `CLAUDE.md`) |
| `style.css` | Bausteine, nur mit Tokens |
| `fonts/`, `licenses/` | Inter und Space Grotesk (SIL Open Font License), Lizenz der Lucide-Icons (ISC) |
| `app.js` | Oberfläche, Speicher, Abgleich mit Garmin |
| `core.js` | Umrechnung der Garmin-Antworten, Normalbereiche, Belastung, Zusammenhänge (in Node testbar) |
| `sleep.js` | Schlafmuster: Pulsspitzen, Wach-Hinweise, korrigierte Nacht und Aufbau einer Nacht, Vergleich der Nächte, Phasen, Unruhe (in Node testbar) |
| `charts.js` | Diagramme als SVG |
| `fit.js` | ZIP und FIT lesen (Aktivitätsdateien) |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline und Installieren |
| `proxy/` | Cloudflare Worker und Anleitung |
| `tests/` | Tests, Nachbildung, Garmins API-Beschreibung (nur lokal) |
