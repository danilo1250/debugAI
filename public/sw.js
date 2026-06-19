const CACHE_NAME = "debugai-v1";
const ASSETS = [
  "/",
  "/app.html",
  "/conta.html",
  "/faq.html",
  "/style.css",
  "/script.js",
  "/manifest.json",
];

// Instala o service worker e cacheia os arquivos estáticos
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Limpa caches antigos
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Estratégia: Network First (tenta rede, se falhar usa cache)
self.addEventListener("fetch", (event) => {
  // Não cacheia chamadas de API
  if (event.request.url.includes("/api/")) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Salva no cache pra próxima vez
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
