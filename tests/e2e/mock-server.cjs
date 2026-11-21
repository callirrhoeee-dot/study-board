/* 브라우저 테스트용 모의 서버: 앱 파일 제공 + Supabase 흉내(인증·RLS 규칙·비공개 보관함).
 * 실제 Supabase가 아니다. 규칙은 server/001_kgs_schema.sql과 같게 맞췄다. */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const APP = path.join(__dirname, '..', '..');
const BANK = process.env.KGS_BANK || path.join(__dirname, '..', '..', 'private', 'pilgi-2026-1.json');
const users = { 'husband@test.kr': { id: '11111111-1111-4111-8111-111111111111', pw: 'pass1234' }, 'other@test.kr': { id: '22222222-2222-4222-8222-222222222222', pw: 'pass1234' }, 'wife@test.kr': { id: '33333333-3333-4333-8333-333333333333', pw: 'pass1234' } };
const members = { [users['husband@test.kr'].id]: 'learner', [users['wife@test.kr'].id]: 'admin' };
const labels = { [users['husband@test.kr'].id]: '남편', [users['wife@test.kr'].id]: '진영' };
const db = { kgs_events: [], kgs_bank_keys: [] };
const tokens = {};
let clock = Date.now();
let failMode = false; // true면 기록 쓰기/읽기가 서버 오류로 실패
const now = () => new Date(++clock).toISOString();

function rowsFor(table, uid) {
  if (table === 'kgs_events') return db.kgs_events.filter(r => r.user_id === uid || (members[uid] === 'admin' && members[r.user_id] === 'learner'));
  if (table === 'kgs_members') return Object.keys(members).filter(id => id === uid || members[uid] === 'admin').map(id => ({ user_id: id, role: members[id], label: labels[id] }));
  if (table === 'kgs_bank_keys') return members[uid] ? db.kgs_bank_keys : [];
  return [];
}
function query(token, q) {
  const uid = token ? tokens[token] : null;
  const t = q.table;
  if (q.op === 'select') {
    if (!uid) return { data: [] };
    let rows = rowsFor(t, uid).slice();
    for (const [op, c, v] of q.filters) rows = rows.filter(r => op === 'eq' ? r[c] === v : r[c] >= v);
    rows.sort((a, b) => { for (const [c, asc] of q.order) { if (a[c] < b[c]) return asc ? -1 : 1; if (a[c] > b[c]) return asc ? 1 : -1; } return 0; });
    if (q.range) rows = rows.slice(q.range[0], q.range[1] + 1);
    if (q.limit != null) rows = rows.slice(0, q.limit);
    return { data: JSON.parse(JSON.stringify(rows)) };
  }
  if (!uid) return { error: { message: 'new row violates row-level security policy (anon)' } };
  if (t === 'kgs_events' && (q.op === 'upsert' || q.op === 'insert')) {
    for (const r of q.rows) {
      if (db.kgs_events.some(x => x.id === r.id)) { if (q.op === 'insert') return { error: { message: 'duplicate key' } }; continue; }
      db.kgs_events.push({ id: r.id, kind: r.kind, item_id: r.item_id || null, data: r.data, client_at: r.client_at, device_id: r.device_id || null, user_id: uid, created_at: now() });
    }
    return { data: q.returning ? [] : null };
  }
  if (t === 'kgs_events' && (q.op === 'update' || q.op === 'delete')) return { data: [] }; // 정책 없음 → 0행
  if (t === 'kgs_bank_keys' && q.op === 'upsert') {
    if (!['editor', 'admin'].includes(members[uid])) return { error: { message: 'row-level security (not editor)' } };
    for (const r of q.rows) { db.kgs_bank_keys = db.kgs_bank_keys.filter(x => x.item_id !== r.item_id); db.kgs_bank_keys.push(Object.assign({}, r, { updated_at: now(), updated_by: uid })); }
    return { data: null };
  }
  return { error: { message: 'not allowed' } };
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'POST' && u.pathname.startsWith('/mock/')) {
    let body = ''; req.on('data', d => body += d); req.on('end', () => {
      const b = JSON.parse(body || '{}'); let out;
      const p = u.pathname.slice(6);
      if (p === 'login') { const usr = users[b.email]; if (!usr || usr.pw !== b.password) out = { error: { message: 'Invalid login credentials' } }; else { const tk = crypto.randomUUID(); tokens[tk] = usr.id; out = { token: tk, user: { id: usr.id, email: b.email } }; } }
      else if (p === 'signup') out = { error: { message: 'signup disabled in test' } };
      else if (p === 'query') out = failMode && b.q.table === 'kgs_events' ? { error: { message: '503 모의 서버 장애' } } : query(b.token, b.q);
      else if (p === 'fail') { failMode = !!b.on; out = { failMode }; }
      else if (p === 'download') { const uid = b.token && tokens[b.token]; out = uid && members[uid] && b.bucket === 'kgs-bank' ? { text: fs.readFileSync(BANK, 'utf8') } : { error: { message: 'Object not found' } }; }
      else if (p === 'dump') out = { db };
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
    }); return;
  }
  let f = u.pathname === '/' ? '/index.html' : u.pathname;
  if (f === '/mock-supabase.js') return res.end(fs.readFileSync(path.join(__dirname, 'mock-supabase.js')));
  if (f === '/config.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end("window.KGS_CONFIG={supabaseUrl:'http://mock',supabaseKey:'mock-publishable',bankFiles:['pilgi-2026-1.json']};"); }
  const fp = path.join(APP, path.normalize(f).replace(/^(\.\.[/\\])+/, ''));
  if (!fp.startsWith(APP) || !fs.existsSync(fp)) { res.writeHead(404); return res.end('nf'); }
  let data = fs.readFileSync(fp);
  if (f === '/index.html') data = String(data).replace(/<script src="https:\/\/cdn[^"]+"[^>]*><\/script>/, '<script src="/mock-supabase.js"></script>');
  res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' }); res.end(data);
});
module.exports = { start: port => new Promise(r => server.listen(port, '0.0.0.0', () => r(server))), db };
if (require.main === module) module.exports.start(Number(process.env.PORT || 8765)).then(() => console.log('mock on', process.env.PORT || 8765));
