/* Service worker для PWA "Облік ЗІП: Механік".
   Потрібен, щоб застосунок можна було встановити на телефон
   і щоб він відкривався без інтернету (дані беруться з localStorage). */

const CACHE = 'zip-mechanic-v1';

// Файли самого застосунку — кешуються під час встановлення.
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon-180.png',
  './icons/favicon-32.png'
];

// Запити до Google Apps Script ніколи не кешуємо — це живі дані.
const isApiRequest = (url) => url.hostname.endsWith('script.google.com');

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Кожен файл окремо: якщо один недоступний, встановлення не зривається.
    await Promise.all(APP_SHELL.map((path) => cache.add(path).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (isApiRequest(url)) return;

  // Відкриття застосунку: спершу мережа, офлайн — збережена сторінка.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        const cache = await caches.open(CACHE);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch (e) {
        const cache = await caches.open(CACHE);
        return (await cache.match(request)) ||
               (await cache.match('./index.html')) ||
               Response.error();
      }
    })());
    return;
  }

  // Статика (іконки, Tailwind з CDN, логотип): спершу кеш, оновлення у фоні.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request);

    const network = fetch(request).then((response) => {
      // response.ok — для своїх файлів, type 'opaque' — для CDN (no-cors).
      if (response && (response.ok || response.type === 'opaque')) {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    }).catch(() => null);

    return cached || (await network) || Response.error();
  })());
});
