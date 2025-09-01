const CACHE_NAME = "bible-app-v1";
const urlsToCache = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./books.js",
  "./firebaseConfig.js",
  "./bible.json"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(urlsToCache)));
});

self.addEventListener("fetch", (e) => {
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
