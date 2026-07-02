// Service worker — met en cache la coquille de l'application (app shell)
// pour un fonctionnement hors-ligne du menu.
// Le contenu dynamique (parties, tirs) passe toujours par Firebase, jamais par ce cache.
//
// Stratégie "réseau d'abord" : on essaie toujours de récupérer la dernière version
// en ligne ; le cache ne sert que de secours si le réseau est indisponible.
// (Une stratégie "cache d'abord" empêcherait les mises à jour de code de s'appliquer
// tant que le cache n'est pas explicitement vidé — ce qu'on veut éviter ici.)

const CACHE_NAME = 'bataille-navale-v2';
const APP_SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/firebase-config.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Ne jamais intercepter les appels réseau vers Firebase / Google APIs :
  // ils doivent toujours atteindre le réseau pour le temps réel.
  if (req.method !== 'GET' || !req.url.startsWith(self.location.origin)) {
    return;
  }

  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req))
  );
});