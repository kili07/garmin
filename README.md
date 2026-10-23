# Garmin-Übersicht

Deine Garmin-Daten auf einen Blick, besser sortiert als in Garmin Connect: **Wie erholt bin ich heute?**,
**lange Trends über Monate und Jahre** und **welche Gewohnheiten bei Dir was bewirken**.

Reines HTML, CSS und JavaScript nach der Bauanleitung (`PWA-ANLEITUNG.md`): kein Build, keine Abhängigkeiten,
installierbar als Web-App, offline lesbar. Die Daten holt die App über Garmins offizielle **Personal API** mit Deinem
eigenen API-Schlüssel. Weil Garmin Aufrufe aus dem Browser ablehnt, läuft das über einen kleinen eigenen Proxy
(Cloudflare Worker, kostenlos). Warum, steht in `DECISIONS.md`.

## Was sie kann

**Heute**
- **Erholung:** HRV, Ruhepuls, Schlaf, Belastung und Body Battery, jedes Signal gegen *Deinen eigenen*
  Normalbereich der letzten Wochen, dazu eine Einschätzung in einem Satz. Garmins „Training Readiness“ gibt die
  API nicht her; die App zeigt stattdessen offen, woraus sich so ein Wert zusammensetzt.
- **Schlaf der letzten Nacht:** Score, Dauer gegen Schlafbedarf, Einschlaf- und Aufwachzeit, Phasen, Puls, Atmung.
  Antippen öffnet **die Nacht im Detail:**
  - jede Phase (Tief, Leicht, REM, Wach) mit Dauer, Anteil, Garmins Bewertung, Garmins Idealbereich und Deinem
    Schnitt der 30 Nächte davor,
  - Garmins Begründung zum Score („Lang, aber zu wenig REM“) und was vom Vortag hineinspielte, dazu Garmins
    Teilbewertungen für Dauer, Stress und Unruhe,
  - Puls, HRV, Atmung (mit Spanne), SpO2 (mit tiefstem Wert), Stress und Atemaussetzer, jeweils gegen Deinen Schnitt,
  - die Kurven der Nacht: Puls, HRV, Body Battery und SpO2 auf einer Zeitachse; antippen zeigt die Uhrzeit,
  - Schlafbedarf: Grundbedarf, Bedarf dieser Nacht und wodurch Garmin ihn angepasst hat, Saldo der letzten sieben
    Nächte, am Morgen auch der Bedarf für die kommende Nacht mit empfohlener Bettzeit,
  - Rhythmus: Einschlafen, Aufwachen und Schlafmitte gegen Deinen Schnitt, wie gleichmäßig Du die letzten zwei
    Wochen eingeschlafen bist, Garmins optimales Schlaffenster, Nickerchen.

  Mit ‹ › geht es Nacht für Nacht zurück. Den Verlauf der Phasen über die Nacht (das Balkendiagramm aus Garmin
  Connect) gibt die Personal API laut Beschreibung nicht her. Schickt Garmin ihn doch mit, zeigt die App ihn.
- **Kacheln** für HRV, Ruhepuls, Body Battery, Stress, Schritte, Intensitätsminuten (Woche), Belastung (7 Tage),
  Gewicht, Atmung und SpO2. Jede mit Abstand zu Deinem Mittel und dem Verlauf der letzten zwei Wochen; antippen
  öffnet den Trend.
- **Woche auf einen Blick:** sieben Tage × sechs Werte als Tabelle, jede Zelle in der Farbe ihrer Abweichung.
- Mit ‹ › durch frühere Tage blättern.

**Trends** für 28 Kennzahlen, darunter Leichtschlaf, Wachzeit, Schlafmitte, Schlafsaldo (7 Nächte), Puls und Stress
im Schlaf, über 4 Wochen, 3 Monate, 1 Jahr oder alles: Tageswerte, 7-Tage-Mittel und Dein
Normalbereich als Band; Vergleich mit dem Zeitraum davor und mit dem Vorjahr; Trend pro Monat; Wochen- oder
Monatsbalken; Mittel je Wochentag. Bei Schlaf-Kennzahlen zusätzlich die Phasen als gestapelte Balken: je Nacht
(4 Wochen), je Woche oder je Monat. Diagramme antippen zeigt den Wert an der Stelle.

**Training**
- Einheiten, Zeit und Distanz der Woche, des Monats oder des Jahres gegen den gleichen Abschnitt davor.
- Umfang je Woche nach Sportart, Belastung akut gegen chronisch (mit dem gut verträglichen Bereich), VO2max-Verlauf,
  Bestzeiten im Laufen (1 km bis Marathon, allzeit und dieses Jahr).
- Alle Aktivitäten nach Wochen, filterbar nach Sportart. Eine Aktivität zeigt alle Kennwerte und Pulszonen, dazu aus
  der Originaldatei (FIT) die **Strecke** (eingefärbt nach Puls oder Tempo), Puls-, Tempo-, Höhen-, Kadenz- und
  Leistungskurve und die Runden.

**Muster:** Was hängt bei Dir womit zusammen? Training → HRV, Ruhepuls und Schlaf am nächsten Morgen; Abendtraining
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
aber den langen Neu-Abruf nach „Browserdaten löschen“.

## Entwickeln und testen

```
python3 tests/serve.py 8127          # App ohne HTTP-Cache
python3 tests/mock-garmin.py 8128    # Nachbildung von Proxy + Garmin mit erfundenen Daten
node tests/core-test.js              # Kernlogik
node tests/fit-test.js               # FIT/ZIP gegen Garmins Testdateien
node tests/worker-test.mjs           # Proxy
```

In der App als Proxy `http://localhost:8128` eintragen, als Schlüssel den Inhalt von `tests/mock-key.txt`.
Vor jedem Neuladen Service Worker und Caches leeren (siehe Bauanleitung, Abschnitt 6).

## Dateien

| Datei | Inhalt |
|---|---|
| `index.html`, `style.css` | Gerüst und Aussehen |
| `app.js` | Oberfläche, Speicher, Abgleich mit Garmin |
| `core.js` | Umrechnung der Garmin-Antworten, Normalbereiche, Belastung, Zusammenhänge (in Node testbar) |
| `charts.js` | Diagramme als SVG |
| `fit.js` | ZIP und FIT lesen (Aktivitätsdateien) |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline und Installieren |
| `proxy/` | Cloudflare Worker und Anleitung |
| `tests/` | Tests, Nachbildung, Garmins API-Beschreibung (nur lokal) |
