# Garmin-Proxy einrichten (Cloudflare Worker)

Garmins Personal API lehnt jeden Aufruf aus einem Browser ab (CORS, getestet am 23.10.2026). Dieser kleine Worker
reicht die Anfragen der App nur weiter. Er speichert nichts, protokolliert nichts und kennt Deinen Schlüssel nicht:
Den schickt die App bei jeder Anfrage selbst mit.

Kosten: keine. Der kostenlose Cloudflare-Tarif erlaubt 100 000 Anfragen am Tag. Ein normaler Abgleich braucht etwa
6 Anfragen, der erste Abruf eines Jahres Verlauf etwa 50.

## Einmal einrichten (etwa 10 Minuten, am PC am bequemsten)

1. **Konto anlegen** auf [dash.cloudflare.com](https://dash.cloudflare.com/), kostenlos, ohne Kreditkarte.
2. **Worker erstellen:** links *Workers & Pages* → *Create application* → Vorlage **Hello World**.
   Namen wählen, z. B. `garmin-proxy`, dann **Deploy**.
3. **Code einsetzen:** *Edit code*, alles im Editor löschen, den Inhalt von `worker.js` einfügen, wieder **Deploy**.
   Am einfachsten kopierst Du den Code aus der App: *Einstellungen → Wie richte ich ihn ein? → Proxy-Code kopieren*.
   Dann steht die Adresse Deiner App schon richtig in `ALLOWED_ORIGINS`.
4. **Adresse übernehmen:** Cloudflare zeigt die Adresse des Workers, etwa
   `https://garmin-proxy.<dein-name>.workers.dev`. Die kommt in der App unter *Einstellungen → Proxy-Adresse*.
5. In der App **Speichern und Verbindung testen** tippen. Der Test prüft der Reihe nach: Proxy erreichbar? App
   freigegeben? Schlüssel gültig?

## Was der Worker durchlässt

| Anfrage | Wird weitergeleitet? |
|---|---|
| von `https://kili07.github.io` (Deine App) | ja |
| von jeder anderen Adresse, auch ohne Adresse (curl) | nein, 403 mit Begründung |
| `GET` auf einen Pfad der Personal API | ja, an `personal.connectapi.garmin.com` |
| `POST` auf den Token-Pfad | ja |
| alles andere (PUT, DELETE, andere Server) | nein |

Weitergereicht werden nur die Kopfzeilen `Authorization` und `Accept`; Cookies und Ähnliches bleiben draußen.
Wer die Worker-Adresse kennt, kann damit nichts anfangen: Ohne Deinen Schlüssel kommt niemand an Daten, und
Anfragen von fremden Seiten lehnt der Worker ab.

## Wenn etwas nicht geht

- **„Proxy nicht erreichbar“** → Adresse vertippt, oder der Worker wurde nach dem Einfügen nicht mit *Deploy*
  gespeichert. Die Adresse im Browser öffnen: Antwortet sie mit `{"proxy":true, …}` (oder „nicht freigegeben“),
  läuft der Worker.
- **„Proxy lehnt diese App ab: Adresse nicht freigegeben: https://…“** → Die genannte Adresse in `worker.js` bei
  `ALLOWED_ORIGINS` eintragen und neu bereitstellen.
- **„Garmin lehnt den API-Schlüssel ab“** → Schlüssel abgelaufen oder unvollständig kopiert. Auf
  [connect.garmin.com → Personal API Key](https://connect.garmin.com/app/settings/personalApiToken) einen neuen
  erzeugen (Garmin zeigt ihn nur einmal) und in der App eintragen.
