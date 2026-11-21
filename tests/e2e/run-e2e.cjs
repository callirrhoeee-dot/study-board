/* 실제 Chrome(헤드리스)에서 앱 화면을 눌러 보는 시나리오 테스트. 서버는 모의 서버.
 * PC = http://localhost:PORT (데스크톱 화면), 휴대폰 = http://127.0.0.1:PORT (390×844 모바일 화면)
 * 출처가 달라 두 기기의 기기 저장소(localStorage·IndexedDB)가 서로 분리된다.
 * 실행: node tests/e2e/run-e2e.cjs */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const mock = require('./mock-server.cjs');
const PORT = 8765, DBG = 9333;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shots = path.join(__dirname, 'shots'); fs.mkdirSync(shots, { recursive: true });

async function post(p, body) { const r = await fetch(`http://127.0.0.1:${PORT}/mock/${p}`, { method: 'POST', body: JSON.stringify(body || {}) }); return r.json(); }

class Tab {
  constructor(ws, name) { this.ws = ws; this.name = name; this.id = 0; this.pending = new Map(); ws.onmessage = m => { const d = JSON.parse(m.data); if (d.method === 'Runtime.exceptionThrown') console.log(`[${name} 예외]`, d.params.exceptionDetails.exception && d.params.exceptionDetails.exception.description); if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') console.log(`[${name} console.error]`, d.params.args.map(a => a.value || a.description).join(' ')); if (d.id && this.pending.has(d.id)) { const { res, rej } = this.pending.get(d.id); this.pending.delete(d.id); d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result); } }; }
  send(method, params) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params: params || {} })); return new Promise((res, rej) => this.pending.set(id, { res, rej })); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(this.name + ': ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text)); return r.result.value; }
  async waitFor(expr, ms = 8000, what) { const t0 = Date.now(); for (;;) { try { if (await this.eval(expr)) return; } catch (e) { } if (Date.now() - t0 > ms) { let t = ''; try { t = (await this.eval('document.querySelector("#toast").textContent + " | mode=" + (window.KGS_APP && KGS_APP.mode)')) + ' | ' + (await this.text()).slice(0, 120).replace(/\n/g, ' / '); } catch (e) { } throw new Error(`${this.name}: 기다림 초과 — ${what || expr} [화면: ${t}]`); } await sleep(120); } }
  async click(sel) { const ok = await this.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return false; e.click(); return true;})()`); if (!ok) throw new Error(`${this.name}: 찾을 수 없음 ${sel}`); await sleep(80); }
  async clickText(sel, text) { const ok = await this.eval(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(sel)})].find(x=>x.textContent.includes(${JSON.stringify(text)})); if(!e) return false; e.click(); return true;})()`); if (!ok) throw new Error(`${this.name}: '${text}' 버튼 없음`); await sleep(80); }
  text() { return this.eval('document.body.innerText'); }
  async go(url) { await this.send('Page.navigate', { url }); await sleep(400); await this.waitFor('document.readyState==="complete"'); }
  async shot(file) { const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(shots, file), Buffer.from(r.data, 'base64')); }
  async offline(on) { await this.send('Network.emulateNetworkConditions', { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); }
  async login(email) {
    await this.waitFor('document.querySelector("#loginForm")', 8000, '로그인 화면');
    await this.eval(`(()=>{const f=document.querySelector('#loginForm'); f.email.value=${JSON.stringify(email)}; f.password.value='pass1234'; f.requestSubmit(); })()`);
    await this.waitFor('window.KGS_APP && KGS_APP.bank && KGS_APP.store', 10000, '문제은행 로드');
    await this.waitFor('document.querySelector("#status .badge.ok")', 10000, '서버 저장 완료 표시');
  }
  stats() { return this.eval(`(()=>{const s=KGS.computeStats(KGS_APP.bank,KGS_APP.store.state.events,new Date().toISOString()); return {subjects:s.subjects.map(x=>({s:x.subject,seen:x.seen,avail:x.available,fresh:x.vol.all.fresh,review:x.vol.all.review,fc:x.firstCount,fcor:x.firstCorrect,retried:x.retried,rc:x.retryCorrect})), pooled:s.overall.pooledN, resume: s.active? KGS_APP.bank.byId[s.active.items[s.activeResume]].no : null, dash: document.querySelector('table.dash') ? document.querySelector('table.dash').innerText : ''};})()`); }
  curNo() { return this.eval(`(()=>{const s=KGS.sessionsOf(KGS.sortedEvents(KGS_APP.store.state.events)).get(KGS_APP.study.sessionId); return KGS_APP.bank.byId[s.items[KGS_APP.study.idx]].no;})()`); }
  answerOf(no) { return this.eval(`KGS_APP.bank.items.find(i=>i.no===${no}).answer`); }
  async answer(correct, unsure) {
    const no = await this.curNo(); const a = await this.answerOf(no); const k = correct ? a : (a % 4) + 1;
    await this.click(`.choice[data-k="${k}"]`);
    if (unsure) await this.click('[data-act="unsure"]');
    await this.eval(`(()=>{const b=document.querySelector('[data-act="submit"]'); b.click(); b.click(); b.click();})()`); // 연타
    await this.waitFor('document.querySelector(".result")', 4000, '채점 결과');
    return no;
  }
}

const results = [];
async function step(name, fn) { try { await fn(); results.push(['✔', name]); } catch (e) { results.push(['✘', name, e.message]); } }

(async () => {
  const srv = await mock.start(PORT);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'kgs-chrome-'));
  const chrome = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${DBG}`, `--user-data-dir=${prof}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  let tabs = [];
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${DBG}/json/version`); break; } catch (e) { await sleep(150); } }
    const mk = async (name, mobile) => {
      const t = await (await fetch(`http://127.0.0.1:${DBG}/json/new?about:blank`, { method: 'PUT' })).json();
      const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
      const tab = new Tab(ws, name); await tab.send('Page.enable'); await tab.send('Runtime.enable'); await tab.send('Network.enable');
      await tab.send('Emulation.setDeviceMetricsOverride', mobile ? { width: 390, height: 844, deviceScaleFactor: 2, mobile: true } : { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
      if (mobile) await tab.send('Emulation.setTouchEmulationEnabled', { enabled: true });
      return tab;
    };
    const pc = await mk('PC', false), phone = await mk('휴대폰', true); tabs = [pc, phone];
    const PCURL = `http://localhost:${PORT}/`, PHURL = `http://127.0.0.1:${PORT}/`;

    await step('인수1: PC 로그인 → 회차 시작 → 7문항 제출(연타 포함) → 8번 열어 둠 → 서버 저장 완료', async () => {
      await pc.go(PCURL); await pc.login('husband@test.kr');
      await pc.shot('01-pc-home-empty.png');
      await pc.clickText('button', '회차 시작');
      for (let i = 1; i <= 7; i++) { await pc.answer(i <= 5, i === 3); if (i === 1) await pc.shot('02-pc-after-submit.png'); await pc.click('[data-act="next"]'); }
      assert.strictEqual(await pc.curNo(), 8);
      await pc.waitFor('document.querySelector("#status .badge.ok")', 8000, '서버 저장 완료');
      const d = await post('dump'); assert.strictEqual(d.db.kgs_events.filter(r => r.kind === 'attempt').length, 7, '서버 제출 7건(연타 중복 없음)');
    });
    await step('인수1: 휴대폰 같은 계정 → 7문항 기록·과목 통계 일치, 이어서 풀기 = 8번', async () => {
      await phone.go(PHURL); await phone.login('husband@test.kr');
      await phone.waitFor('document.body.innerText.includes("8번부터")', 6000, "'8번부터 이어서 풀기'");
      await phone.shot('03-phone-home.png');
      const a = await pc.stats(), b = await phone.stats();
      assert.deepStrictEqual(b.subjects, a.subjects); assert.strictEqual(b.subjects[0].seen, 7); assert.strictEqual(b.resume, 8);
    });
    await step('인수2: 휴대폰에서 8번 제출 → PC 총 8문항, 8번 답 보임, 이어서 풀기 9번, 중복 없음', async () => {
      await phone.clickText('button', '이어서 풀기');
      assert.strictEqual(await phone.curNo(), 8);
      await phone.answer(true); await phone.shot('04-phone-result.png');
      await phone.click('[data-act="next"]');
      await phone.waitFor('document.querySelector("#status .badge.ok")', 8000);
      await pc.click('[data-act="go"][data-v="home"]'); await pc.click('#status .badge'); await sleep(600);
      await pc.waitFor('document.body.innerText.includes("9번부터")', 8000, "PC '9번부터'");
      const s = await pc.stats(); assert.strictEqual(s.subjects[0].seen, 8); assert.strictEqual(s.subjects[0].fresh + s.subjects[0].review, 8);
      await pc.click('[data-act="go"][data-v="records"]');
      assert.ok((await pc.text()).includes('8번 건축계획'), '기록 화면에 8번');
      const d = await post('dump'); assert.strictEqual(d.db.kgs_events.filter(r => r.kind === 'attempt').length, 8);
    });
    await step('인수3: 휴대폰 오프라인 제출 → 창 닫음 → 서버 장애 중 다시 열어도 답 남음(전송 대기) → 복구 후 정확히 1번 저장', async () => {
      await phone.click('[data-act="go"][data-v="home"]');
      await phone.clickText('button', '이어서 풀기');
      await phone.offline(true);
      const no = await phone.answer(false);
      await phone.waitFor('document.querySelector("#status").innerText.includes("오프라인")', 6000, '오프라인 표시');
      await phone.waitFor('document.querySelector(".save.wait")', 4000, "'이 기기에 저장됨 · 전송 대기'");
      await phone.shot('05-phone-offline.png');
      await post('fail', { on: true }); await phone.offline(false);
      await phone.go('about:blank'); await phone.go(PHURL); // 창 닫았다 다시 열기
      await phone.waitFor('window.KGS_APP && KGS_APP.store && KGS_APP.bank', 8000);
      const kept = await phone.eval(`Object.values(KGS_APP.store.state.events).some(e=>e.kind==='attempt' && e.data.item.endsWith('${String(no).padStart(3, '0')}'))`);
      assert.ok(kept, '다시 열어도 답안이 기기에 남음');
      await phone.waitFor('/저장 실패|전송 대기/.test(document.querySelector("#status").innerText)', 8000, '실패·대기 표시');
      await phone.shot('06-phone-reopen-failed.png');
      let d = await post('dump'); assert.strictEqual(d.db.kgs_events.filter(r => r.kind === 'attempt').length, 8);
      await post('fail', { on: false }); await phone.click('#status .badge');
      await phone.waitFor('document.querySelector("#status .badge.ok")', 8000, '복구 후 서버 저장 완료');
      await phone.click('#status .badge'); await sleep(500);
      d = await post('dump'); const at = d.db.kgs_events.filter(r => r.kind === 'attempt');
      assert.strictEqual(at.length, 9); assert.strictEqual(new Set(at.map(r => r.id)).size, 9);
    });
    await step('인수4: 두 기기 오프라인에서 서로 다른 문제 → 동기화 후 양쪽에 두 기록 모두', async () => {
      await pc.click('#status .badge'); await sleep(500);
      await pc.click('[data-act="go"][data-v="home"]'); await pc.clickText('button', '이어서 풀기');
      await phone.click('[data-act="go"][data-v="practice"]');
      await pc.offline(true); await phone.offline(true);
      const a = await pc.answer(true);
      await phone.eval(`[...document.querySelectorAll('[data-act="subj"][data-new="1"]')].find(b=>b.dataset.s==='건축시공').click()`); await sleep(200);
      const b = await phone.answer(true);
      await pc.offline(false); await phone.offline(false);
      await pc.click('#status .badge'); await sleep(700); await phone.click('#status .badge'); await sleep(700); await pc.click('#status .badge'); await sleep(700);
      const has = (t, no) => t.eval(`Object.values(KGS_APP.store.state.events).some(e=>e.kind==='attempt' && e.data.item==='P-2026-1-${String(no).padStart(3, '0')}')`);
      assert.ok(await has(pc, a) && await has(pc, b) && await has(phone, a) && await has(phone, b));
      const x = await pc.stats(), y = await phone.stats(); assert.deepStrictEqual(x.subjects, y.subjects);
      assert.strictEqual(x.subjects[1].seen, 1);
    });
    await step('인수5: 같은 문제 복습 → 복습 횟수만 늘고 처음 푼 문항 수·첫 풀이 정답률 그대로', async () => {
      const before = (await phone.stats()).subjects[0];
      await phone.click('[data-act="go"][data-v="practice"]');
      await phone.click('[data-act="review"][data-all="1"]');
      await phone.answer(true); await phone.click('[data-act="next"]');
      await phone.answer(true);
      await phone.waitFor('document.querySelector("#status .badge.ok")', 8000);
      await pc.click('#status .badge'); await sleep(700);
      const after = (await pc.stats()).subjects[0];
      assert.strictEqual(after.fc, before.fc); assert.strictEqual(after.fcor, before.fcor); assert.strictEqual(after.seen, before.seen);
      assert.strictEqual(after.review, before.review + 2);
      await pc.click('[data-act="go"][data-v="home"]'); await sleep(300); await pc.shot('06b-pc-home-data.png');
      await pc.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1500, deviceScaleFactor: 1, mobile: false }); await pc.shot('06c-pc-home-full.png');
      await pc.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
    });
    await step('정답 대조: 설계자(편집자)가 56번 검토대기 → 대조완료 저장 → 남편 기기에서 채점 가능 문항 100', async () => {
      await pc.click('[data-act="go"][data-v="settings"]'); await pc.click('[data-act="logout"]');
      await pc.login('wife@test.kr');
      await pc.click('[data-act="go"][data-v="settings"]'); await pc.click('[data-act="go"][data-v="keys"]');
      await pc.waitFor('document.querySelector(".keyform")');
      await pc.shot('07-pc-keys.png');
      await pc.eval(`(()=>{const f=document.querySelector('.keyform[data-id="P-2026-1-056"]'); f.querySelector('input[value="1"]').checked=true; f.status.value='대조완료'; f.requestSubmit();})()`);
      await sleep(600);
      await phone.click('#status .badge'); await sleep(800);
      assert.strictEqual(await phone.eval('KGS.computeStats(KGS_APP.bank,KGS_APP.store.state.events,new Date().toISOString()).overall.available'), 100);
    });
    await step('인수6: 같은 PC에서 다른 계정 로그인 → 이전 계정 기록·문제은행 안 보임 / 서버 접근 점검 통과', async () => {
      await pc.click('[data-act="go"][data-v="settings"]'); await pc.click('[data-act="logout"]');
      await pc.waitFor('document.querySelector("#loginForm")');
      await pc.eval(`(()=>{const f=document.querySelector('#loginForm'); f.email.value='other@test.kr'; f.password.value='pass1234'; f.requestSubmit(); })()`);
      await pc.waitFor('window.KGS_APP && KGS_APP.store && KGS_APP.user && KGS_APP.user.email==="other@test.kr"', 8000);
      await sleep(800);
      const t = await pc.text();
      assert.ok(t.includes('문제은행이 아직 없어요'), '미등록 계정은 문제은행 못 받음');
      assert.strictEqual(await pc.eval('Object.keys(KGS_APP.store.state.events).length'), 0);
      assert.ok(!t.includes('husband'), '이전 계정 정보 노출 없음');
      await pc.shot('08-pc-other-account.png');
      // 설계자로 다시 로그인해 서버 접근 점검(B=other)
      await pc.click('[data-act="go"][data-v="settings"]'); await pc.click('[data-act="logout"]');
      await pc.login('wife@test.kr');
      await pc.click('[data-act="go"][data-v="settings"]'); await pc.click('[data-act="go"][data-v="check"]');
      await pc.eval(`(()=>{const f=document.querySelector('#checkForm'); f.email.value='other@test.kr'; f.password.value='pass1234'; f.requestSubmit();})()`);
      await pc.waitFor('document.querySelector("#checkOut").innerText.includes("점검용 기록")', 10000, '점검 완료');
      const out = await pc.eval('document.querySelector("#checkOut").innerText');
      await pc.shot('09-pc-server-check.png');
      assert.ok(!out.includes('✘'), out);
    });
    await step('휴대폰 화면: 가로 넘침 없음, 선택지·제출 버튼 높이 ≥ 48px(한 손 조작)', async () => {
      await phone.click('[data-act="go"][data-v="home"]'); await sleep(200);
      await phone.shot('10-phone-dashboard.png');
      const over = await phone.eval('document.documentElement.scrollWidth > window.innerWidth + 1'); assert.ok(!over, '가로 스크롤 생김');
      await phone.click('[data-act="go"][data-v="practice"]'); await phone.clickText('button', '처음부터 회차 풀기');
      const h = await phone.eval(`[...document.querySelectorAll('.choice')].map(b=>b.getBoundingClientRect().height)`);
      assert.ok(h.every(x => x >= 48), JSON.stringify(h));
      const sb = await phone.eval(`(()=>{const r=document.querySelector('[data-act="submit"]').getBoundingClientRect(); return {h:r.height, bottom:r.bottom, vh:innerHeight};})()`);
      assert.ok(sb.h >= 48 && sb.bottom <= sb.vh, JSON.stringify(sb));
      await phone.shot('11-phone-question.png');
    });
    await step('이 기기 전용 모드: 서버 없이 시작 → 문제은행 파일 열기 → 풀이 저장', async () => {
      await phone.click('[data-act="go"][data-v="settings"]'); await phone.click('[data-act="logout"]');
      await phone.waitFor('document.querySelector("[data-act=local]")'); await phone.click('[data-act="local"]');
      await phone.waitFor('document.querySelector("input[data-act=bankfile]")', 6000, '문제은행 파일 열기');
      await phone.send('DOM.enable'); const doc = await phone.send('DOM.getDocument');
      const node = await phone.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[data-act=bankfile]' });
      await phone.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [process.env.KGS_BANK || path.join(__dirname, '..', '..', 'private', 'pilgi-2026-1.json')] });
      await phone.waitFor('window.KGS_APP && KGS_APP.bank', 8000, '파일에서 문제은행');
      await phone.clickText('button', '회차 시작'); await phone.answer(true);
      assert.ok((await phone.text()).includes('이 기기에만 저장'));
      assert.strictEqual(await phone.eval('Object.values(KGS_APP.store.state.events).filter(e=>e.kind==="attempt").length'), 1);
      const d = await post('dump'); assert.ok(!d.db.kgs_events.some(r => r.device_id && r.data && r.data.mode === 'round' && r.user_id === 'local'));
    });
  } finally {
    for (const [r, n, e] of results) console.log(`${r} ${n}${e ? '\n   → ' + e : ''}`);
    const fail = results.filter(r => r[0] === '✘').length;
    console.log(`\n${results.length - fail}/${results.length} 통과 (헤드리스 Chrome + 모의 서버 — 실제 Supabase·실제 휴대폰 아님)`);
    chrome.kill(); srv.close(); process.exitCode = fail ? 1 : 0;
    setTimeout(() => process.exit(process.exitCode), 300);
  }
})();
