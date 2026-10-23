/* Garmin-Proxy — Cloudflare Worker für die Garmin-Übersicht.

   Wozu: Garmins Personal API lehnt jeden Aufruf aus einem Browser ab
   (CORS). Dieser Worker nimmt die Anfrage der App entgegen, reicht sie
   unverändert an Garmin weiter und gibt die Antwort mit den Kopfzeilen
   zurück, die der Browser braucht.

   Was er NICHT tut: nichts speichern, nichts protokollieren, keinen
   Schlüssel kennen. Den API-Schlüssel schickt die App bei jeder Anfrage mit;
   er liegt nur auf Deinem Handy.

   Schutz gegen Fremdnutzung:
   - nur Anfragen von den Adressen in ALLOWED_ORIGINS (Deine App),
   - nur an personal.connectapi.garmin.com,
   - nur GET, dazu der eine POST für den Token.

   Einrichten: siehe proxy/ANLEITUNG.md. Die App kopiert Dir diese Datei mit
   der richtigen Adresse in ALLOWED_ORIGINS (Einstellungen → Proxy). */

const ALLOWED_ORIGINS = ['https://kili07.github.io'];

const UPSTREAM = 'https://personal.connectapi.garmin.com';
const TOKEN_PATH = '/personalapitoken-service/personal-api/personal-api-key/token';

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Accept',
      'Access-Control-Expose-Headers': 'Retry-After, Content-Disposition',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };
    const reply = (status, message) => new Response(JSON.stringify({ proxy: true, message }), {
      status, headers: { ...cors, 'Content-Type': 'application/json' },
    });

    /* Fremde Adresse: mit CORS-Kopf ablehnen, damit die App den Grund lesen
       und anzeigen kann, statt nur „Netzwerkfehler" zu sehen. */
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return reply(403, `Adresse nicht freigegeben: ${origin || '(keine)'}. Im Worker in ALLOWED_ORIGINS eintragen.`);
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/ping') return reply(200, 'Garmin-Proxy läuft');
    const isToken = url.pathname === TOKEN_PATH;
    if (isToken ? request.method !== 'POST' : request.method !== 'GET') return reply(405, 'Methode nicht erlaubt');

    let upstream;
    try {
      upstream = await fetch(UPSTREAM + url.pathname + url.search, {
        method: request.method,
        headers: {
          'Authorization': request.headers.get('Authorization') || '',
          'Accept': request.headers.get('Accept') || 'application/json',
        },
        redirect: 'manual',
      });
    } catch (e) {
      return reply(502, 'Garmin nicht erreichbar: ' + (e && e.message));
    }

    const headers = new Headers(cors);
    for (const h of ['Content-Type', 'Content-Disposition', 'Retry-After']) {
      const v = upstream.headers.get(h);
      if (v) headers.set(h, v);
    }
    headers.set('Cache-Control', 'no-store');
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
