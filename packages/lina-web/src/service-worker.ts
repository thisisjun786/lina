/** Build-time template; the worker has no runtime cache writes or mutation queue. */
export function serviceWorkerSource(
	version: string,
	paths: string[],
	shell: string,
): string {
	return `"use strict";
const VERSION = ${JSON.stringify(version)};
const CACHE = "lina-shell-" + VERSION;
const PATHS = ${JSON.stringify(paths)};
const SHELL = ${JSON.stringify(shell)};
self.addEventListener("install", event => event.waitUntil((async () => {
 const cache = await caches.open(CACHE);
 try {
  for (const path of PATHS) {
   const response = await fetch(path, {cache:"no-store", credentials:"omit", redirect:"error"});
   if (!response.ok || response.type === "opaque") throw new Error("Incomplete Lina shell");
   await cache.put(path, response);
  }
 } catch (error) { await caches.delete(CACHE); throw error; }
})()));
self.addEventListener("activate", event => event.waitUntil((async () => {
 for (const key of await caches.keys()) if(key.startsWith("lina-shell-") && key !== CACHE) await caches.delete(key);
 await self.clients.claim();
})()));
self.addEventListener("message", event => {
 if(event.data === "apply-update" && event.source && new URL(event.source.url).origin === self.location.origin) event.waitUntil(self.skipWaiting());
});
self.addEventListener("fetch", event => {
 const request = event.request;
 const url = new URL(request.url);
 if(request.method !== "GET" || url.origin !== self.location.origin || url.search || request.headers.has("range")) return;
 const key = request.mode === "navigate" && url.pathname === "/" ? SHELL : url.pathname;
 if(!PATHS.includes(key)) return;
 event.respondWith((async () => {
  const response = await (await caches.open(CACHE)).match(key);
  if(response) return response;
  // Cache eviction must not strand an online user. A fresh HTML document carries
  // its own hashed references; responses fetched here are never cached.
  try {const online=await fetch(key===SHELL?"/":request,{cache:"no-store",credentials:"omit",redirect:"error"});if(online.ok)return online;}catch{}
  return new Response("오프라인 화면 없음 · 인터넷 연결 후 다시 열기",{status:503,headers:{"Content-Type":"text/plain; charset=utf-8","Cache-Control":"no-store"}});
 })());
});
`;
}
