/* My Life App — Service Worker
 *
 * Qué hace:
 *  1) Guarda la app (index.html, íconos, fuentes y la librería de Excel) en el
 *     teléfono la primera vez que se abre con internet.
 *  2) Desde ahí, la app abre aunque no haya señal, sin depender de ningún servidor.
 *  3) Cuando SÍ hay internet, siempre intenta traer la versión más nueva del
 *     index.html (así las actualizaciones llegan solas); si no hay red o tarda
 *     demasiado, usa la copia guardada.
 *
 * Qué NO hace: no toca las llamadas a Google (login y Drive). Esas siempre van
 * directo a internet — nunca se guardan ni se sirven desde caché.
 *
 * ACTUALIZAR LA APP: normalmente basta con reemplazar index.html en el hosting;
 * los teléfonos lo descargan solos la próxima vez que abran la app con internet.
 * Cambia CACHE_VERSION solo si cambias íconos, manifest o recursos externos,
 * para que los teléfonos descarten la copia guardada anterior.
 */
const CACHE_VERSION = 'mylifeapp-pwa-v185';

const INDEX_URL = new URL('./index.html', self.registration.scope).href;

// Archivos propios: index.html es obligatorio; el resto es opcional.
const REQUIRED = ['./', './index.html'];
const OPTIONAL = [
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

// Recursos de terceros que usa el HTML (URLs exactas, tal como están en el <head>)
const EXTERNAL = [
  'https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'
];
const EXTERNAL_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com'];

const NETWORK_TIMEOUT_MS = 4000;

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(v => { clearTimeout(t); resolve(v); },
                 e => { clearTimeout(t); reject(e); });
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    await cache.addAll(REQUIRED);
    for (const url of OPTIONAL) {
      try { await cache.add(url); } catch (e) { /* opcional: seguimos */ }
    }
    for (const url of EXTERNAL) {
      try {
        const res = await fetch(new Request(url, { mode: 'cors', credentials: 'omit' }));
        if (res && res.ok) await cache.put(url, res);
      } catch (e) { /* sin internet o bloqueado: se guardará al usarse */ }
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// HTML: red primero (para recibir actualizaciones); si falla o tarda, copia guardada.
async function networkFirstHtml(request) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const res = await withTimeout(fetch(request), NETWORK_TIMEOUT_MS);
    if (res && res.ok) {
      cache.put(INDEX_URL, res.clone());
    }
    return res;
  } catch (e) {
    const cached = (await cache.match(INDEX_URL)) || (await cache.match(request, { ignoreSearch: true }));
    if (cached) return cached;
    return new Response(
      'Sin conexión, y la app todavía no se guardó en este dispositivo. Ábrela una vez con internet.',
      { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
    );
  }
}

// Archivos propios (íconos, manifest): caché primero, y se refrescan en segundo plano.
async function cacheFirst(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);
  const refresh = fetch(request).then(res => {
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  }).catch(() => null);
  return cached || (await refresh) || Response.error();
}

// Terceros (fuentes, librería de Excel): caché primero; se actualizan en segundo plano.
async function staleWhileRevalidateExternal(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);
  const refresh = fetch(new Request(request.url, { mode: 'cors', credentials: 'omit' }))
    .then(res => {
      if (res && res.ok) cache.put(request.url, res.clone());
      return res;
    })
    .catch(() => null);
  if (cached) return cached;
  const fresh = await refresh;
  if (fresh) return fresh;
  try { return await fetch(request); } catch (e) { return Response.error(); }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    const isHtml = request.mode === 'navigate' ||
                   url.pathname.endsWith('/') ||
                   url.pathname.endsWith('/index.html');
    event.respondWith(isHtml ? networkFirstHtml(request) : cacheFirst(request));
    return;
  }

  if (EXTERNAL_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidateExternal(request));
    return;
  }

  // Todo lo demás (login de Google, API de Drive, etc.): directo a internet, sin tocar.
});
