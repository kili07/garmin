/* Service Worker — Garmin-Übersicht offline verfügbar halten.
   Bei JEDER Änderung an den Dateien CACHE hochzählen, sonst liefert der
   Worker die alte Fassung weiter.

   Anfragen an den Proxy (andere Adresse) fasst er nie an: Garmin-Daten
   kommen immer frisch, und offline zeigt die App, was in localStorage liegt. */
const CACHE = 'garmin-v1';

const ASSETS = [
  './', './index.html', './style.css', './core.js', './charts.js', './fit.js', './app.js',
  './manifest.webmanifest', './proxy/worker.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  // cache:'reload' erzwingt frische Dateien vom Server. Ohne das würden sie aus
  // dem HTTP-Cache des Browsers geholt (GitHub Pages sendet max-age=600) — der
  // neue Cache enthielte dann die alte Version.
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  // Nur eigene alte Caches löschen: Alle Apps unter <name>.github.io teilen sich
  // einen Cache-Speicher — ohne den Präfix-Filter flöge deren Offline-Fassung mit raus.
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((k) => k.startsWith('garmin-') && k !== CACHE)
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  /* Nur die eigenen Dateien anfassen. Andere Apps auf derselben Domain
     (…/reader/, …/dashboard/) liegen außerhalb des Scopes. */
  const own = new URL(self.registration.scope);
  if (!url.pathname.startsWith(own.pathname)) return;
  const key = url.pathname === own.pathname ? './' : e.request;

  /* Stale-while-revalidate: sofort aus dem Cache liefern, im Hintergrund
     aktualisieren. */
  e.respondWith(
    caches.open(CACHE).then((c) => c.match(key, { ignoreSearch: true }).then((hit) => {
      const net = fetch(e.request).then((res) => {
        // Umgeleitete Antworten nicht cachen: Chrome lehnt sie für Seitenaufrufe ab
        if (res && res.ok && !res.redirected && !url.search) c.put(key, res.clone());
        return res;
      });
      if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
      return net;
    }))
  );
});
