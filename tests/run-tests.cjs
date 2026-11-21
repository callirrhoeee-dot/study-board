/* 모의 서버로 인수 테스트 1~6 + 통계 규칙을 검사한다.  실행: node tests/run-tests.cjs
 * 모의 서버는 실제 서버 규칙(같은 id 무시, 자기 기록만 읽기/쓰기, user_id·created_at은 서버가 정함)을 흉내 낸다.
 * 실제 Supabase·실제 휴대폰을 검증하지 않는다. */
'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const K = require('../core.js');

// ---------- 테스트용 문제은행 (실제 교재 내용 없이 같은 구조만) ----------
function fakeBank() {
  const items = [];
  for (let n = 1; n <= 100; n++) {
    items.push({ id: `P-2026-1-${String(n).padStart(3, '0')}`, no: n, subject: K.SUBJECTS[Math.floor((n - 1) / 20)], answer: (n % 4) + 1, status: n === 56 ? '검토대기' : '대조완료', choices: ['a', 'b', 'c', 'd'], stem: 'q' + n });
  }
  return { bankId: 'pilgi-2026-1', title: '2026년 1회 건축기사 필기', subjects: K.SUBJECTS, items };
}
const BANK = K.effectiveBank(fakeBank(), {});
const ID = n => `P-2026-1-${String(n).padStart(3, '0')}`;

// ---------- 모의 서버 ----------
class FakeServer {
  constructor() { this.rows = []; this.clock = Date.parse('2026-11-21T03:00:00Z'); this.tokens = {}; this.insertCalls = 0; }
  tick() { this.clock += 1000; return new Date(this.clock).toISOString(); }
  token(user) { const t = 'tok-' + user; this.tokens[t] = user; return t; }
  insert(token, rows) {
    const uid = this.tokens[token]; if (!uid) throw Object.assign(new Error('401 로그인 필요'), { status: 401 });
    this.insertCalls++;
    for (const r of rows) {
      if (this.rows.some(x => x.id === r.id)) continue; // ON CONFLICT (id) DO NOTHING
      this.rows.push(Object.assign({}, JSON.parse(JSON.stringify(r)), { user_id: uid, created_at: this.tick() })); // user_id는 서버가 로그인 정보로 정함
    }
  }
  select(token, since, from, to) {
    const uid = this.tokens[token]; if (!uid) return []; // 비로그인 = RLS로 0행
    return this.rows.filter(r => r.user_id === uid && (!since || r.created_at >= since))
      .sort((a, b) => a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1)
      .slice(from, to + 1).map(r => JSON.parse(JSON.stringify(r)));
  }
  update(token, id, patch) { return 0; } // UPDATE 정책 없음 → 0행
  remove(token, id) { return 0; }        // DELETE 정책 없음 → 0행
}
function memStorage() { const m = new Map(); return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), _m: m }; }

// 기기 = 자기 localStorage + 네트워크 상태 + (선택) 응답 유실
class Device {
  constructor(name, server, storage) { this.name = name; this.server = server; this.storage = storage || memStorage(); this.online = true; this.loseResponse = false; this.clock = Date.parse('2026-11-21T03:00:00Z'); }
  now() { this.clock += 60000; return new Date(this.clock).toISOString(); }
  login(user) {
    this.user = user; this.token = this.server.token(user);
    this.store = new K.LocalStore(this.storage, user);
    const dev = this;
    this.api = {
      insertEvents: async rows => { if (!dev.online) throw Object.assign(new Error('offline'), { offline: true }); dev.server.insert(dev.token, rows); if (dev.loseResponse) { dev.loseResponse = false; throw new Error('응답 유실'); } },
      fetchEvents: async (since, a, b) => { if (!dev.online) throw Object.assign(new Error('offline'), { offline: true }); return dev.server.select(dev.token, since, a, b); },
    };
    this.sync = new K.SyncEngine({ store: this.store, api: this.api, now: () => this.now() });
  }
  logout() { this.sync && this.sync.stop(); this.user = null; this.store = null; this.sync = null; }
  reopen() { const u = this.user; this.logout(); this.login(u); } // 창을 닫았다 다시 열기
  add(kind, data) { const ev = K.makeEvent(kind, data, this.name, this.now()); this.store.add(ev); return ev; }
  startRound() { return this.add('session', { mode: 'round', label: '2026년 1회', roundKey: 'pilgi-2026-1', items: BANK.items.map(i => i.id) }); }
  open(session, n) { return this.add('position', { session, item: ID(n) }); }
  submit(session, n, choice, opts = {}) { return this.add('attempt', Object.assign({ session, item: ID(n), choice, unsure: false, mode: 'round' }, opts)); }
  stats() { return K.computeStats(BANK, this.store.state.events, this.now()); }
  resume() { const s = this.stats(); return s.active ? s.active.items[s.activeResume] : null; }
}
const right = n => (n % 4) + 1, wrong = n => ((n % 4) + 1) % 4 + 1;
function statsKey(s) { return JSON.stringify(s.subjects.map(x => [x.subject, x.seen, x.available, x.vol.all, x.firstCount, x.firstCorrect, x.retried, x.retryCorrect])); }

const results = [];
async function test(name, fn) { try { await fn(); results.push(['통과', name]); } catch (e) { results.push(['실패', name, e.stack]); } }

(async () => {
  // ===== 인수 테스트 1·2 =====
  const server = new FakeServer();
  const pc = new Device('pc', server), phone = new Device('phone', server);
  pc.login('husband'); phone.login('husband');
  let round;
  await test('인수1: PC에서 7문항 풀고 서버 저장 → 휴대폰에서 기록·통계·이어 풀 위치(8번) 일치', async () => {
    round = pc.startRound();
    for (let n = 1; n <= 7; n++) { pc.open(round.id, n); pc.submit(round.id, n, n <= 5 ? right(n) : wrong(n)); }
    pc.open(round.id, 8);
    assert.match(pc.sync.summary(true).text, /전송 대기/);
    await pc.sync.syncNow();
    assert.strictEqual(pc.sync.summary(true).text, '서버 저장 완료');
    await phone.sync.syncNow();
    assert.strictEqual(phone.resume(), ID(8));
    assert.strictEqual(statsKey(phone.stats()), statsKey(pc.stats()));
    assert.strictEqual(phone.stats().subjects[0].seen, 7);
    assert.strictEqual(phone.stats().subjects[0].firstCorrect, 5);
  });
  await test('인수2: 휴대폰에서 8번 제출 → PC 총 8문항, 8번 답 확인, 이어 풀기 9번, 중복 없음', async () => {
    const e8 = phone.submit(round.id, 8, right(8)); phone.open(round.id, 9);
    await phone.sync.syncNow();
    await pc.sync.syncNow();
    const s = pc.stats();
    assert.strictEqual(s.subjects[0].seen, 8);
    assert.strictEqual(s.subjects[0].vol.all.fresh + s.subjects[0].vol.all.review, 8);
    assert.strictEqual(pc.store.state.events[e8.id].data.choice, right(8));
    assert.strictEqual(pc.resume(), ID(9));
    assert.strictEqual(server.rows.filter(r => r.kind === 'attempt').length, 8);
  });
  await test('중복: 제출 버튼 연타·같은 제출 재전송·응답 유실 후 재시도해도 서버 1건', async () => {
    const ev = K.makeEvent('attempt', { session: round.id, item: ID(9), choice: right(9), unsure: false, mode: 'round' }, 'pc', pc.now());
    assert.strictEqual(pc.store.add(ev), true);
    assert.strictEqual(pc.store.add(Object.assign({}, ev)), false); // 연타 → 같은 id → 무시
    pc.loseResponse = true;
    await assert.rejects(pc.sync.syncNow()); // 서버엔 들어갔지만 응답을 못 받음
    assert.match(pc.sync.summary(true).text, /저장 실패 · 재시도/);
    await pc.sync.syncNow(); // 같은 id로 재전송
    assert.strictEqual(server.rows.filter(r => r.id === ev.id).length, 1);
    assert.strictEqual(pc.stats().subjects[0].seen, 9);
  });

  // ===== 인수 테스트 3 =====
  await test('인수3: 오프라인 제출 → 창 닫고 다시 열어도 남음 → 온라인 복귀 후 정확히 1번 저장', async () => {
    phone.online = false;
    const e10 = phone.submit(round.id, 10, wrong(10));
    await assert.rejects(phone.sync.syncNow());
    assert.match(phone.sync.summary(false).text, /오프라인 · 이 기기에 저장됨 1건/);
    phone.reopen();
    assert.ok(phone.store.state.events[e10.id], '다시 열어도 답안이 남아 있어야 함');
    assert.deepStrictEqual(phone.store.state.outbox, [e10.id]);
    assert.strictEqual(server.rows.filter(r => r.id === e10.id).length, 0);
    phone.online = true;
    await phone.sync.syncNow();
    await phone.sync.syncNow(); // 한 번 더 돌려도 그대로
    assert.strictEqual(server.rows.filter(r => r.id === e10.id).length, 1);
    assert.strictEqual(phone.store.state.outbox.length, 0);
  });

  // ===== 인수 테스트 4 =====
  await test('인수4: 두 기기가 오프라인에서 서로 다른 문제를 풀고 동기화 → 두 기록 모두 보존(덮어쓰기 없음)', async () => {
    await pc.sync.syncNow(); await phone.sync.syncNow();
    pc.online = false; phone.online = false;
    const a = pc.submit(round.id, 11, right(11));
    const b = phone.submit(round.id, 21, right(21));
    phone.online = true; await phone.sync.syncNow();
    pc.online = true; await pc.sync.syncNow();
    await phone.sync.syncNow();
    for (const d of [pc, phone]) { assert.ok(d.store.state.events[a.id]); assert.ok(d.store.state.events[b.id]); }
    assert.strictEqual(statsKey(pc.stats()), statsKey(phone.stats()));
    assert.strictEqual(pc.stats().subjects[0].seen, 11);
    assert.strictEqual(pc.stats().subjects[1].seen, 1);
  });
  await test('인수4-보강: 같은 회차의 같은 문항을 두 기기가 따로 제출 → 두 제출 모두 남고 회차 답은 먼저 낸 것', async () => {
    pc.online = false; phone.online = false;
    const a = pc.submit(round.id, 12, wrong(12));
    const b = phone.submit(round.id, 12, right(12));
    pc.online = true; phone.online = true;
    await pc.sync.syncNow(); await phone.sync.syncNow(); await pc.sync.syncNow();
    assert.ok(pc.store.state.events[a.id] && pc.store.state.events[b.id]);
    const ses = K.sessionsOf(K.sortedEvents(pc.store.state.events)).get(round.id);
    const first = [a, b].sort(K.cmpEv)[0];
    assert.strictEqual(ses.answers.get(ID(12)).id, first.id);
    assert.strictEqual(statsKey(pc.stats()), statsKey(phone.stats()));
  });

  // ===== 인수 테스트 5 =====
  await test('인수5: 같은 문제 복습 → 복습 횟수만 늘고 처음 푼 문항 수·첫 풀이 정답률 그대로', async () => {
    const before = pc.stats().subjects[0];
    const rev = pc.add('session', { mode: 'review', label: '오답 복습', items: [ID(6), ID(7), ID(10)] });
    pc.submit(rev.id, 6, right(6), { mode: 'review' });
    pc.submit(rev.id, 7, wrong(7), { mode: 'review' });
    await pc.sync.syncNow(); await phone.sync.syncNow();
    const after = phone.stats().subjects[0];
    assert.strictEqual(after.firstCount, before.firstCount);
    assert.strictEqual(after.firstCorrect, before.firstCorrect);
    assert.strictEqual(after.vol.all.review, before.vol.all.review + 2);
    assert.strictEqual(after.retried, before.retried + 2);
    assert.strictEqual(after.retryCorrect, before.retryCorrect + 1);
  });

  // ===== 인수 테스트 6 =====
  await test('인수6: 다른 계정 로그인 → 화면에 이전 계정 기록 없음, 서버에서도 읽기·쓰기 불가', async () => {
    const shared = new Device('pc2', server, pc.storage); // 같은 PC(같은 브라우저 저장소)
    shared.login('other');
    assert.strictEqual(Object.keys(shared.store.state.events).length, 0);
    await shared.sync.syncNow();
    assert.strictEqual(Object.keys(shared.store.state.events).length, 0);
    assert.strictEqual(shared.stats().overall.pooledN, 0);
    // 남의 기록 id로 써 넣기 시도 → 같은 id는 무시, 원래 행 그대로
    const victim = server.rows.find(r => r.user_id === 'husband');
    server.insert(shared.token, [{ id: victim.id, kind: 'attempt', item_id: victim.item_id, data: { choice: 4 }, client_at: victim.client_at }]);
    assert.strictEqual(server.rows.find(r => r.id === victim.id).user_id, 'husband');
    assert.strictEqual(server.update(shared.token, victim.id, {}), 0);
    assert.strictEqual(server.remove(shared.token, victim.id), 0);
    // user_id를 남의 것으로 보내도 서버가 로그인 정보로 바꿈
    server.insert(shared.token, [{ id: K.uuid(), kind: 'stage', data: { stage: '필기' }, client_at: shared.now(), user_id: 'husband' }]);
    assert.strictEqual(server.select(pc.token, null, 0, 9999).filter(r => r.kind === 'stage').length, 0);
    assert.deepStrictEqual(server.select('anon', null, 0, 9999), []);
    // 원래 계정으로 돌아오면 기록 그대로
    const back = new Device('pc3', server, pc.storage); back.login('husband');
    assert.ok(Object.keys(back.store.state.events).length > 10);
  });

  // ===== 통계 규칙 =====
  await test('통계: 요청서 예시(60문항 + 재풀이 20, 첫 정답 42) → 진도 60, 총 80회, 재풀이 20, 70%', async () => {
    const big = { bankId: 'b', title: 't', subjects: ['과목'], items: [] };
    for (let i = 0; i < 200; i++) big.items.push({ id: 'X' + i, subject: '과목', answer: 1, status: '대조완료' });
    const bank = K.effectiveBank(big, {});
    const evs = {}; let t = Date.parse('2026-11-01T00:00:00Z');
    const add = (item, choice) => { const e = K.makeEvent('attempt', { item, choice, session: 's' }, 'd', new Date(t += 60000).toISOString()); evs[e.id] = e; };
    for (let i = 0; i < 60; i++) add('X' + i, i < 42 ? 1 : 2);
    for (let i = 0; i < 20; i++) add('X' + i, 1);
    const S = K.computeStats(bank, evs, '2026-11-21T00:00:00Z').subjects[0];
    assert.strictEqual(S.seen, 60); assert.strictEqual(S.available, 200);
    assert.strictEqual(S.vol.all.fresh + S.vol.all.review, 80); assert.strictEqual(S.vol.all.review, 20);
    assert.strictEqual(S.firstCorrect, 42); assert.strictEqual(Math.round(S.accuracy * 100), 70);
  });
  await test('통계: 검토대기 문항(56번)은 분모·채점에서 제외, 미학습 과목 표시, 평균에 집계 과목 수', async () => {
    const s = pc.stats();
    assert.strictEqual(s.subjects[2].available, 19); assert.strictEqual(s.subjects[2].pending, 1);
    assert.strictEqual(s.subjects[4].status, '미학습');
    assert.strictEqual(s.overall.subjectsCounted, 2); assert.strictEqual(s.overall.subjectsTotal, 5);
  });
  await test('통계: 회차를 모두 풀면 완료 회차로 과목 점수·평균·과락 판정, 진행 중은 따로', async () => {
    const d = new Device('solo', new FakeServer()); d.login('solo');
    const r = d.startRound();
    for (const it of BANK.items) { const n = it.no; const ok = it.subject === '건축설비' ? n % 3 === 0 : n % 5 !== 0; d.submit(r.id, n, ok ? right(n) : wrong(n)); }
    const s = d.stats();
    assert.strictEqual(s.doneRounds.length, 1); assert.strictEqual(s.progressRounds.length, 0);
    assert.strictEqual(s.subjects[3].roundCount, 1);
    assert.ok(s.subjects[3].roundAvg < 40); assert.match(s.subjects[3].status, /과락 위험/);
    assert.deepStrictEqual(s.doneRounds[0].failSubjects, ['건축설비']);
    assert.strictEqual(s.doneRounds[0].pass, false);
    const next = K.computeStats(BANK, d.store.state.events, '2026-11-22T12:00:00Z'); // 다음 날 열었을 때
    const recs = K.recommend(BANK, next);
    assert.ok(recs.some(x => x.kind === 'weak' && x.subject === '건축설비'), '점수 부족 과목 복습 추천');
  });
  await test('추천: 기록 없음 → 회차 진단 / 덜 푼 과목 → 새 문제 이유가 다름', async () => {
    const d = new Device('n', new FakeServer()); d.login('n');
    assert.strictEqual(K.recommend(BANK, d.stats())[0].kind, 'round');
    const s = pc.stats(); const recs = K.recommend(BANK, s);
    const fresh = recs.find(r => r.kind === 'fresh');
    assert.ok(fresh && /가장 적게 푼 과목/.test(fresh.reason));
  });
  await test('복습 일정: 틀림 → 다음 날, 맞았지만 헷갈림 → 3일 뒤, 확실한 정답 2번 → 졸업', async () => {
    const mk = (choice, unsure, at) => ({ id: at, kind: 'attempt', at, data: { item: ID(1), choice, unsure } });
    assert.strictEqual(K.reviewState([mk(wrong(1), false, '2026-11-20T01:00:00Z')], BANK).due, '2026-11-21');
    assert.strictEqual(K.reviewState([mk(right(1), true, '2026-11-20T01:00:00Z')], BANK).due, '2026-11-23');
    assert.strictEqual(K.reviewState([mk(wrong(1), false, '2026-11-18T01:00:00Z'), mk(right(1), false, '2026-11-19T01:00:00Z'), mk(right(1), false, '2026-11-22T01:00:00Z')], BANK), null);
  });
  await test('기기 저장: 두 탭이 번갈아 저장해도 기록이 사라지지 않음', async () => {
    const st = memStorage();
    const a = new K.LocalStore(st, 'u'), b = new K.LocalStore(st, 'u');
    a.add(K.makeEvent('stage', { stage: '필기' }, 'a')); b.add(K.makeEvent('stage', { stage: '필기' }, 'b'));
    const c = new K.LocalStore(st, 'u');
    assert.strictEqual(Object.keys(c.state.events).length, 2); assert.strictEqual(c.state.outbox.length, 2);
  });
  await test('기기 저장: 저장 공간 오류면 제출을 저장된 것처럼 보이지 않음', async () => {
    const st = memStorage(); const s = new K.LocalStore(st, 'u'); st.setItem = () => { throw new Error('QuotaExceeded'); };
    assert.throws(() => s.add(K.makeEvent('stage', { stage: '필기' }, 'a')));
    assert.strictEqual(Object.keys(s.state.events).length, 0);
  });

  // ===== 실제 문제은행 파일이 있으면 구조 검사 =====
  const real = path.join(__dirname, '..', 'private', 'pilgi-2026-1.json');
  if (fs.existsSync(real)) await test('문제은행(2026-1): 100문항, ID 고유, 대조완료는 정답 1~4, 원문 쪽 기록', async () => {
    const b = JSON.parse(fs.readFileSync(real, 'utf8'));
    assert.strictEqual(b.items.length, 100);
    assert.strictEqual(new Set(b.items.map(i => i.id)).size, 100);
    for (const it of b.items) {
      assert.ok(it.src.pdfPages.length && it.src.printedPages.length, it.id);
      assert.strictEqual(it.choices.length, 4);
      if (it.status === '대조완료') { assert.ok([1, 2, 3, 4].includes(it.answer)); assert.ok(it.keySrc.printedPages.length); }
    }
    assert.ok(b.items.find(i => i.no === 60).answer === 3);
  });

  let fail = 0;
  for (const [r, n, err] of results) { console.log(`${r === '통과' ? '✔' : '✘'} ${n}`); if (err) { fail++; console.log(err); } }
  console.log(`\n${results.length - fail}/${results.length} 통과 (모의 서버·가상 기기 — 실제 Supabase/휴대폰 검증 아님)`);
  process.exit(fail ? 1 : 0);
})();
