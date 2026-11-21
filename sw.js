/* 앱 화면 파일만 보관해서 인터넷이 끊겨도 다시 열 수 있게 한다.
 * 학습 기록은 여기서 다루지 않는다(기기 저장소 + 서버). 네트워크 우선, 실패하면 보관본. */
const CACHE = 'kgs-shell-v1';
const SHELL = ['./', './index.html', './core.js', './app.js', './config.js', 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const isShell = (u.origin === location.origin) || u.href.startsWith('https://cdn.jsdelivr.net/npm/@supabase/');
  if (!isShell) return; // Supabase API·문제은행 다운로드는 가로채지 않음
  e.respondWith(fetch(e.request).then(r => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); } return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html'))));
});
