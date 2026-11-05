/* Bandezar – service worker: aplikacja działa bez internetu po pierwszym otwarciu (tylko wersja z hostingu, https). */
var CACHE = 'bandezar-1.0.0-5d5fdb57';
var FILES = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'];
self.addEventListener('install', function(e){ e.waitUntil(caches.open(CACHE).then(function(c){ return c.addAll(FILES); }).then(function(){ return self.skipWaiting(); })); });
self.addEventListener('activate', function(e){ e.waitUntil(caches.keys().then(function(k){ return Promise.all(k.filter(function(x){ return x !== CACHE; }).map(function(x){ return caches.delete(x); })); }).then(function(){ return self.clients.claim(); })); });
self.addEventListener('fetch', function(e){
  var u = new URL(e.request.url);
  if(e.request.method !== 'GET' || u.origin !== location.origin || /\/api\//.test(u.pathname)) return;   /* dane z serwera nigdy z pamięci podręcznej */
  /* najpierw sieć (świeża wersja), bez sieci kopia z pamięci */
  e.respondWith(fetch(e.request).then(function(r){ var cp = r.clone(); if(r.ok) caches.open(CACHE).then(function(c){ c.put(e.request, cp); }); return r; })
    .catch(function(){ return caches.match(e.request).then(function(r){ return r || caches.match('./index.html'); }); }));
});
