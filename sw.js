/* Routine & Performance — service worker
   - /_blob/<id> : photo déchiffrée à la volée depuis les paquets chiffrés de /vault/
   - page d'accueil gardée en cache pour ouvrir l'app sans réseau */
const SHELL = 'rp-shell-v1', PACKS = 'rp-packs-v1';
const BASE = new URL(self.registration.scope).pathname;
let KEY = null, INDEX = null, INDEX_AT = 0;

self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'key') { KEY = null; INDEX = null; }
  if (e.data && e.data.type === 'forget') { KEY = null; INDEX = null; }
});

function idb() {
  return new Promise((ok, ko) => {
    const r = indexedDB.open('rp-vault', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('k');
    r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error);
  });
}
async function getKey() {
  if (KEY) return KEY;
  const db = await idb();
  const raw = await new Promise((ok, ko) => { const t = db.transaction('k', 'readonly').objectStore('k').get('key'); t.onsuccess = () => ok(t.result); t.onerror = () => ko(t.error); });
  if (!raw) return null;
  KEY = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  return KEY;
}
async function decrypt(buf) {
  const k = await getKey(); if (!k) throw new Error('nokey');
  const u = new Uint8Array(buf);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.slice(0, 12) }, k, u.slice(12));
}
async function getIndex() {
  if (INDEX && Date.now() - INDEX_AT < 10 * 60e3) return INDEX;
  let r;
  try { r = await fetch(BASE + 'vault/index.bin', { cache: 'no-cache' }); if (!r.ok) throw 0; const c = await caches.open(SHELL); c.put(BASE + 'vault/index.bin', r.clone()); }
  catch (e) { r = await (await caches.open(SHELL)).match(BASE + 'vault/index.bin'); }
  if (!r) return null;
  INDEX = JSON.parse(new TextDecoder().decode(await decrypt(await r.arrayBuffer()))); INDEX_AT = Date.now();
  return INDEX;
}
async function pack(name) {
  const c = await caches.open(PACKS), url = BASE + 'vault/' + name;
  let r = await c.match(url);
  if (!r) { r = await fetch(url); if (!r.ok) throw new Error('pack'); await c.put(url, r.clone()); }
  return r.arrayBuffer();
}
async function blob(id) {
  const ix = await getIndex(); const e = ix && ix[id];
  if (!e) return new Response('', { status: 404 });
  const buf = await pack(e[0]);
  const plain = await decrypt(buf.slice(e[1], e[1] + e[2]));
  return new Response(plain, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' } });
}
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin) return;
  if (u.pathname.startsWith(BASE + '_blob/')) { e.respondWith(blob(u.pathname.slice(BASE.length + 6)).catch(() => new Response('', { status: 404 }))); return; }
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then(r => { if (r.ok) { const c = r.clone(); caches.open(SHELL).then(s => s.put(BASE, c)); } return r; })
      .catch(async () => (await (await caches.open(SHELL)).match(BASE)) || new Response('Hors ligne', { status: 503 })));
  }
});
