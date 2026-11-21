// Claudix: офлайн-режим. Главная и Лига Улиц хранятся на устройстве и открываются без интернета.
// Страницы и скрипты берём из сети, а если сети нет — из кэша. Запросы к /api никогда не кэшируются.
"use strict";
const CACHE = "claudix-v1";
const FONTS = "claudix-fonts-v1";
const PRECACHE = ["/", "/liga", "/lang.js", "/claudix.js", "/vendor/three.min.js", "/app-icons/icon-light.png"];

// Cloudflare отдаёт /liga.html по адресу /liga, поэтому храним без «.html»
function keyOf(url) {
  let p = url.pathname.replace(/\.html$/, "");
  if (p === "/index") p = "/";
  return p;
}
// кэш не принимает ответы после переадресации: делаем «чистую» копию
async function clean(res) {
  if (!res.redirected) return res;
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
}

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(PRECACHE.map(async (p) => {
      try { const r = await fetch(p, { cache: "reload" }); if (r.ok) await c.put(p, await clean(r)); } catch (err) { /* докачаем при следующем заходе */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE && k !== FONTS) await caches.delete(k);
    await self.clients.claim();
  })());
});

function offlinePage() {
  return new Response(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Нет интернета · Claudix</title>
<style>:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#07181d;color:#eef6f7;font:16px/1.5 system-ui,sans-serif;padding:24px max(16px,env(safe-area-inset-left))}
.c{max-width:420px;text-align:center;display:grid;gap:14px}h1{margin:0;font-size:1.5rem}p{margin:0;color:#94b0b6}a{display:block;padding:14px;border-radius:12px;background:#ff5a8c;color:#1d0610;font-weight:800;text-decoration:none}a.s{background:transparent;border:1px solid rgba(255,255,255,.2);color:#eef6f7}</style></head>
<body><div class="c"><h1>Нет интернета</h1><p>Эта игра пока работает только онлайн. Лига Улиц доступна и без интернета, прогресс сохранится в облако, когда сеть вернётся.</p><a href="/liga">Играть в Лигу Улиц</a><a class="s" href="/">На главную</a></div></body></html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

async function networkFirst(req, key) {
  const c = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok && res.type === "basic") c.put(key, await clean(res.clone()));
    return res;
  } catch (err) {
    const hit = await c.match(key);
    if (hit) return hit;
    if (req.mode === "navigate") return offlinePage();
    throw err;
  }
}

async function cacheFirst(req) {
  const c = await caches.open(FONTS);
  const hit = await c.match(req);
  const net = fetch(req).then((res) => { if (res.ok || res.type === "opaque") c.put(req, res.clone()); return res; }).catch(() => null);
  return hit || (await net) || Response.error();
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith("/api/")) return; // аккаунты, сохранения и онлайн — только сеть
    e.respondWith(networkFirst(req, keyOf(url)));
  } else if (/^(fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.cloudflare\.com)$/.test(url.hostname)) {
    e.respondWith(cacheFirst(req));
  }
});
