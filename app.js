/* 건축기사 학습보드 — 화면 */
(function () {
  'use strict';
  const K = window.KGS, CFG = window.KGS_CONFIG || {};
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (a, b) => b ? Math.round(a / b * 1000) / 10 : 0;
  const CIRCLE = ['', '①', '②', '③', '④'];

  // ---------- 기기 ID ----------
  function deviceId() {
    let d = localStorage.getItem('kgs1:device');
    if (!d) { d = (/Mobi|Android|iPhone/i.test(navigator.userAgent) ? 'phone-' : 'pc-') + K.uuid().slice(0, 8); localStorage.setItem('kgs1:device', d); }
    return d;
  }

  // ---------- 문제은행 캐시 (IndexedDB: 용량이 커서 localStorage 대신) ----------
  const idb = {
    db: null,
    open() {
      if (this.db) return Promise.resolve(this.db);
      return new Promise((res, rej) => { const r = indexedDB.open('kgs1', 1); r.onupgradeneeded = () => r.result.createObjectStore('bank'); r.onsuccess = () => { this.db = r.result; res(this.db); }; r.onerror = () => rej(r.error); });
    },
    async get(k) { const db = await this.open(); return new Promise((res, rej) => { const q = db.transaction('bank').objectStore('bank').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); },
    async put(k, v) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction('bank', 'readwrite'); t.objectStore('bank').put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); },
    async del(k) { const db = await this.open(); return new Promise(res => { const t = db.transaction('bank', 'readwrite'); t.objectStore('bank').delete(k); t.oncomplete = () => res(); }); },
  };

  // ---------- 상태 ----------
  const app = {
    mode: null,          // 'server' | 'local'
    sb: null, user: null, role: null,
    store: null, sync: null, gen: 0,
    rawBank: null, bank: null,
    view: 'home', viewArg: null,
    study: null,         // { sessionId, idx, selected, unsure, draftId, showOrig }
    timer: null, toast: null, bankError: null,
  };
  const online = () => navigator.onLine !== false;

  function toast(msg, tone) {
    const t = $('#toast'); t.textContent = msg; t.className = 'toast show ' + (tone || ''); clearTimeout(app.toast);
    app.toast = setTimeout(() => { t.className = 'toast'; }, 3200);
  }

  // ---------- Supabase ----------
  const serverConfigured = () => !!(CFG.supabaseUrl && CFG.supabaseKey && window.supabase && window.supabase.createClient);
  function makeApi(sb, uid) {
    const netErr = e => Object.assign(new Error(e && e.message || String(e)), { offline: !online() });
    return {
      async insertEvents(rows) {
        const { error } = await sb.from('kgs_events').upsert(rows, { onConflict: 'id', ignoreDuplicates: true });
        if (error) throw netErr(error);
      },
      async fetchEvents(since, from, to) {
        // 관리자는 학습자 기록도 읽을 수 있으므로, 내 기기 기록에는 반드시 내 것만 받는다
        let q = sb.from('kgs_events').select('id,kind,item_id,data,client_at,device_id,created_at').eq('user_id', uid).order('created_at', { ascending: true }).order('id', { ascending: true }).range(from, to);
        if (since) q = q.gte('created_at', since);
        const { data, error } = await q; if (error) throw netErr(error); return data || [];
      },
      async fetchKeys() {
        const { data, error } = await sb.from('kgs_bank_keys').select('item_id,answer,status,note,updated_at');
        if (error) throw netErr(error); return data || [];
      },
    };
  }

  const canEdit = () => app.role === 'editor' || app.role === 'admin';
  const isAdmin = () => app.role === 'admin';

  // ---------- 계정 시작/종료 ----------
  async function startAccount(mode, user) {
    teardown();
    const gen = ++app.gen;
    app.mode = mode; app.user = user; app.role = mode === 'local' ? 'editor' : null; app.watch = null;
    try { app.store = new K.LocalStore(localStorage, mode === 'local' ? 'local' : user.id); }
    catch (e) {
      if (e.code === 'CORRUPT') { renderCorrupt(e, mode === 'local' ? 'local' : user.id); return; }
      throw e;
    }
    if (mode === 'server') {
      app.sync = new K.SyncEngine({ store: app.store, api: makeApi(app.sb, user.id), onChange: () => { if (gen === app.gen) renderStatus(); } });
      app.sb.from('kgs_members').select('role').eq('user_id', user.id).maybeSingle().then(({ data }) => { if (gen === app.gen) { app.role = data ? data.role : 'none'; render(); } });
    }
    await loadBank(gen);
    if (gen !== app.gen) return;
    render();
    if (app.sync) { kick(); let tick = 0; app.timer = setInterval(() => { tick++; if (app.store && (app.store.state.outbox.length || tick % 3 === 0)) kick(); }, 20000); }
  }
  function teardown() {
    app.gen++;
    if (app.sync) app.sync.stop();
    clearInterval(app.timer);
    app.store = null; app.sync = null; app.user = null; app.role = null; app.study = null; app.bank = null; app.rawBank = null; app.view = 'home'; app.watch = null;
  }
  function kick() {
    if (!app.sync) return;
    const gen = app.gen;
    app.sync.syncNow().then(() => { if (gen === app.gen) { refreshBank(); softRender(); } }).catch(() => { if (gen === app.gen) renderStatus(); });
  }

  // ---------- 문제은행 ----------
  async function loadBank(gen) {
    app.bankError = null;
    const name = bankKey();
    let bank = null;
    try { bank = await idb.get(name); } catch (e) { /* 캐시 없음 */ }
    if (app.mode === 'server' && online()) {
      try {
        const { data, error } = await app.sb.storage.from('kgs-bank').download((CFG.bankFiles || ['pilgi-2026-1.json'])[0]);
        if (error) throw error;
        const fresh = JSON.parse(await data.text());
        await idb.put(name, fresh); bank = fresh;
      } catch (e) { if (!bank) app.bankError = '서버 보관함에서 문제은행을 받지 못했습니다 (' + (e.message || e) + '). 학습보드 사용자로 등록되었는지 확인하거나, 아래에서 파일을 직접 여세요.'; }
    }
    if (gen !== app.gen) return;
    app.rawBank = bank; refreshBank();
  }
  /** 문제은행 보관본은 계정별로 따로 둔다(다른 계정·미등록 계정이 같은 기기에서 보지 못하게) */
  function bankKey() { return 'bank:' + (app.mode === 'local' ? 'local' : app.user.id) + ':' + (CFG.bankFiles || ['pilgi-2026-1.json'])[0]; }
  function refreshBank() { app.bank = app.rawBank ? K.effectiveBank(app.rawBank, app.store ? app.store.state.keys : {}) : null; }
  async function openBankFile(file) {
    const fresh = JSON.parse(await file.text());
    if (!fresh.items || !fresh.bankId) throw new Error('문제은행 파일 형식이 아닙니다');
    await idb.put(bankKey(), fresh); app.rawBank = fresh; refreshBank(); render(); toast('문제은행을 이 기기에 넣었습니다');
  }

  // ---------- 기록 추가 ----------
  function addEvent(kind, data) {
    const ev = K.makeEvent(kind, data, deviceId());
    try { app.store.add(ev); }
    catch (e) { toast('이 기기에 저장하지 못했습니다 · 저장 공간을 확인하세요', 'bad'); throw e; }
    if (app.sync) kick();
    return ev;
  }
  const events = () => app.store.state.events;
  const stats = () => K.computeStats(app.bank, events(), new Date().toISOString());

  // ---------- 풀이 시작 ----------
  function startSession(mode, label, items, roundKey) {
    items = items.filter(id => app.bank.byId[id]);
    if (!items.length) { toast('풀 문제가 없습니다'); return; }
    const ev = addEvent('session', { mode, label, items, roundKey: roundKey || null, stage: '필기' });
    openSession(ev.id, 0);
  }
  function openSession(sessionId, idx) {
    const s = K.sessionsOf(K.sortedEvents(events())).get(sessionId);
    if (!s) return;
    if (idx == null) { idx = K.resumeIndex(s); if (idx < 0) idx = 0; }
    app.study = { sessionId, idx };
    app.view = 'study';
    openItem(idx);
  }
  function openItem(idx) {
    const s = curSession(); if (!s) return;
    idx = Math.max(0, Math.min(idx, s.items.length - 1));
    app.study.idx = idx; app.study.selected = null; app.study.unsure = false; app.study.draftId = K.uuid(); app.study.showOrig = false; app.study.showText = false;
    const id = s.items[idx];
    if (!s.answers.has(id) && (!s.lastPos || s.lastPos.data.item !== id)) addEvent('position', { session: s.id, item: id });
    render(); window.scrollTo(0, 0);
  }
  function curSession() { return app.study && K.sessionsOf(K.sortedEvents(events())).get(app.study.sessionId); }
  function submit() {
    const st = app.study, s = curSession(); if (!s || !st.selected) return;
    const id = s.items[st.idx];
    if (s.answers.has(id)) return; // 이미 이 풀이에서 제출함
    const ev = { id: st.draftId, kind: 'attempt', item: id, at: new Date().toISOString(), device: deviceId(), data: { session: s.id, item: id, choice: st.selected, unsure: !!st.unsure, mode: s.mode } };
    try { if (!app.store.add(ev)) return; } catch (e) { toast('이 기기에 저장하지 못했습니다 · 제출이 기록되지 않았어요', 'bad'); return; }
    if (app.sync) kick();
    render();
  }

  // =====================================================================
  // 렌더링
  // =====================================================================
  function render() {
    const root = $('#app');
    if (!app.mode) { root.innerHTML = loginHtml(); return; }
    const nav = navHtml();
    let body = '';
    if (!app.bank && app.view !== 'settings') body = noBankHtml();
    else if (app.view === 'study') body = studyHtml();
    else if (app.view === 'practice') body = practiceHtml();
    else if (app.view === 'records') body = recordsHtml();
    else if (app.view === 'settings') body = settingsHtml();
    else if (app.view === 'keys') body = keysHtml();
    else if (app.view === 'check') body = checkHtml();
    else if (app.view === 'learners') body = learnersHtml();
    else body = homeHtml();
    const keepY = window.scrollY;
    root.innerHTML = `<div class="shell ${app.view === 'study' ? 'is-study' : ''}">${nav}<main class="main"><div class="topbar"><div class="who">${esc(app.mode === 'local' ? '이 기기 전용' : (app.user.email || ''))}</div><div id="status"></div></div>${body}</main></div>`;
    window.scrollTo(0, keepY);
    renderStatus();
  }
  /** 입력 중인 화면(정답 대조·점검·설정)은 다시 그리지 않고 상태 표시만 바꾼다 */
  function softRender() { if (['keys', 'check', 'settings', 'learners'].includes(app.view)) renderStatus(); else render(); }
  function renderStatus() {
    const el = $('#status'); if (!el) return;
    if (app.mode === 'local') { el.innerHTML = `<span class="badge muted">이 기기에만 저장 (서버 미연결)</span>`; return; }
    if (!app.sync) return;
    const s = app.sync.summary(online());
    el.innerHTML = `<button class="badge ${s.tone}" data-act="sync" title="지금 서버와 맞추기">${esc(s.text)}</button>`;
    const sr = document.querySelector('[data-save-state]');
    if (sr) { const id = sr.getAttribute('data-save-state'); sr.outerHTML = saveStateHtml(id); }
  }
  function saveStateHtml(id) {
    if (app.mode === 'local') return `<span data-save-state="${id}" class="save muted">이 기기에 저장됨</span>`;
    let st = app.store.status(id);
    if (!online() && (st === 'pending' || st === 'failed')) st = 'pending';
    const map = { pending: ['wait', '이 기기에 저장됨 · 전송 대기'], failed: ['bad', '저장 실패 · 재시도 중'], saved: ['ok', '서버 저장 완료'], none: ['muted', ''] };
    const [tone, text] = map[st];
    return `<span data-save-state="${id}" class="save ${tone}">${text}</span>`;
  }

  function navHtml() {
    const I = {
      home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
      practice: '<path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h8M8 17h5"/>',
      records: '<path d="M4 20V10M10 20V4M16 20v-7M21 20H3"/>',
      learners: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14.8c1.6.8 2.7 2.6 3 5.2"/>',
      settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
    };
    const items = [['home', '오늘 학습'], ['practice', '문제 풀기'], ['records', '기록']].concat(isAdmin() ? [['learners', '학습자 기록']] : []).concat([['settings', '설정']]);
    return `<nav class="nav"><div class="brand">건축기사 <b>학습보드</b></div>${items.map(([v, t]) => `<button data-act="go" data-v="${v}" class="${app.view === v || (v === 'practice' && app.view === 'study') ? 'on' : ''}"><svg viewBox="0 0 24 24" aria-hidden="true">${I[v]}</svg><span>${t}</span></button>`).join('')}</nav>`;
  }

  // ---------- 로그인 ----------
  function loginHtml() {
    const srv = serverConfigured();
    return `<div class="login card">
      <h1>건축기사 학습보드</h1>
      ${app.libError ? '<p class="msg bad">서버 연결 도구를 불러오지 못했어요(인터넷 연결 확인). 연결되면 새로고침하세요. 그동안 기록은 이 기기 전용 모드로만 쓸 수 있어요.</p>' : ''}
      <p class="muted">필기 기출 · ${srv ? 'PC와 휴대폰에서 같은 계정으로 이어서 공부합니다.' : '서버 설정 전이라 이 기기에서만 저장됩니다.'}</p>
      ${srv ? `<form id="loginForm" autocomplete="on">
        <label>이메일<input name="email" type="email" required autocomplete="username"></label>
        <label>비밀번호<input name="password" type="password" required minlength="6" autocomplete="current-password"></label>
        <button class="btn primary big" type="submit">로그인</button>
        <button class="btn" type="button" data-act="signup">처음이면 가입하기</button>
        <p id="loginMsg" class="msg"></p>
      </form><hr>` : ''}
      <button class="btn ${srv ? '' : 'primary big'}" data-act="local">서버 없이 이 기기에서만 쓰기</button>
      <p class="tiny muted">이 기기 전용 기록은 다른 기기와 연동되지 않습니다. 설정 → 백업으로 옮길 수 있어요.</p>
    </div>`;
  }

  function noBankHtml() {
    return `<section class="card"><h2>문제은행이 아직 없어요</h2>
      ${app.bankError ? `<p class="msg bad">${esc(app.bankError)}</p>` : ''}
      <p>${app.mode === 'server' ? '로그인 후 비공개 보관함에서 자동으로 받습니다. 처음 한 번은 인터넷 연결이 필요해요.' : '진영님이 받은 문제은행 파일(pilgi-2026-1.json)을 열어 주세요. 파일은 이 기기 안에만 보관됩니다.'}</p>
      <label class="btn primary big filebtn">문제은행 파일 열기<input type="file" accept=".json,application/json" data-act="bankfile" hidden></label>
      ${app.mode === 'server' ? `<button class="btn" data-act="reloadbank">보관함에서 다시 받기</button>` : ''}
      <button class="btn" data-act="logout">로그아웃</button>
    </section>`;
  }

  // ---------- 홈 ----------
  function homeHtml() {
    const s = stats();
    if (s.stage === '실기') return stageSilgiHtml(s);
    const recs = K.recommend(app.bank, s);
    let resume = '';
    if (s.active) {
      const a = s.active; const done = a.answers.size; const n = a.items.length;
      const it = app.bank.byId[a.items[s.activeResume]];
      resume = `<section class="card resume"><div class="cardhead"><h2>이어서 풀기</h2><span class="sub">${esc(a.label)}</span></div>
        <div class="resume-body"><div class="grow"><div class="big-num">${done}<small> / ${n}문항</small></div><div class="muted tiny">다음 문제 ${it ? it.no + '번 · ' + esc(it.subject) : ''}</div><div class="bar thick"><i style="width:${Math.round(done / n * 100)}%"></i></div></div>
        <button class="btn primary big" data-act="resume" data-id="${a.id}">${it ? it.no + '번부터' : ''} 이어서 풀기</button></div></section>`;
    }
    const quick = K.quickSet(app.bank, s);
    const o = s.overall; const todayN = s.subjects.reduce((a, S) => a + S.vol.today.fresh + S.vol.today.review, 0);
    const weekN = s.subjects.reduce((a, S) => a + S.vol.week.fresh + S.vol.week.review, 0);
    const tiles = `<section class="card"><div class="cardhead"><h2>학습 요약</h2><span class="sub">${esc(app.bank.title)} 기준</span></div><div class="tiles">
        <div class="tile"><span>오늘 풀이</span><b>${todayN}<small>회</small></b></div>
        <div class="tile"><span>최근 7일 풀이</span><b>${weekN}<small>회</small></b></div>
        <div class="tile"><span>첫 풀이 정답률</span><b>${o.pooledN ? pct(o.pooledCorrect, o.pooledN) + '<small>%</small>' : '–'}</b><em>${o.pooledCorrect}/${o.pooledN}문항</em></div>
        <div class="tile"><span>과목 평균 정답률</span><b>${o.subjectMean == null ? '–' : Math.round(o.subjectMean * 1000) / 10 + '<small>%</small>'}</b><em>집계 ${o.subjectsCounted}/${o.subjectsTotal}과목</em></div>
      </div></section>`;
    return `<div class="${resume ? 'grid2' : ''}">${resume}${tiles}</div>
      <section class="card"><div class="cardhead row-between"><div><h2>오늘 공부할 것</h2><span class="sub">풀이 기록을 바탕으로 고른 순서</span></div>${quick.length ? `<button class="btn" data-act="quick">15분 학습 · ${quick.length}문항</button>` : ''}</div>
        ${recs.length ? `<ul class="list-rows">${recs.map((r, i) => `<li class="rec"><div><b>${esc(r.title)}</b><p class="reason">${esc(r.reason)}</p></div><button class="btn primary" data-act="rec" data-i="${i}">${esc(r.cta)}</button></li>`).join('')}</ul>` : '<p class="muted">오늘 기한이 된 복습이 없어요. 문제 풀기에서 원하는 과목을 골라 보세요.</p>'}
      </section>
      ${dashboardHtml(s)}
      ${roundsHtml(s)}`;
  }
  function dashboardHtml(s) {
    const o = s.overall;
    const rows = s.subjects.map(S => {
      const accTxt = S.firstCount ? `${S.firstCorrect}/${S.firstCount} · <b>${pct(S.firstCorrect, S.firstCount)}%</b>` : '—';
      const round = S.roundCount ? `<b>${S.roundAvg}점</b> <span class="muted">(${S.roundCount}회)</span>` : '<span class="muted">완료 회차 없음</span>';
      const rv = S.firstWrong ? `${S.firstWrong} → ${S.retried} → ${S.retryCorrect}` : '—';
      return `<tr>
        <th>${esc(S.subject)}${S.pending ? `<div class="tiny muted">검토 대기 ${S.pending}</div>` : ''}</th>
        <td data-l="학습진도"><div class="bar"><i style="width:${Math.round(S.progress * 100)}%"></i></div>${S.seen}/${S.available} · ${pct(S.seen, S.available)}%</td>
        <td data-l="오늘 신규/복습">${S.vol.today.fresh} / ${S.vol.today.review}</td>
        <td data-l="7일 신규/복습">${S.vol.week.fresh} / ${S.vol.week.review}</td>
        <td data-l="누적 신규/재풀이/총">${S.vol.all.fresh} / ${S.vol.all.review} / ${S.vol.all.fresh + S.vol.all.review}</td>
        <td data-l="첫 풀이 정답률" class="${S.firstCount && S.firstCount < K.PASS.sample ? 'dim' : ''}">${accTxt}</td>
        <td data-l="회차 과목 평균">${round}</td>
        <td data-l="복습 성과 (첫 오답→다시 풂→맞힘)">${rv}</td>
        <td data-l="판정"><span class="state ${S.statusTone}">${esc(S.status)}</span></td></tr>`;
    }).join('');
    return `<section class="card"><div class="cardhead"><h2>과목별 학습 현황</h2><span class="sub">합격 기준 과목 40점 · 평균 60점 · 첫 풀이 20문항 미만은 판단 보류</span></div>
      <div class="tablewrap"><table class="dash"><thead><tr><th>과목</th><th>학습진도</th><th>오늘<br>신규/복습</th><th>최근 7일<br>신규/복습</th><th>누적<br>신규/재풀이/총</th><th>첫 풀이 정답률</th><th>회차 과목 평균</th><th>복습 성과<br><span class="tiny">첫 오답→다시 풂→맞힘</span></th><th>판정</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="foot">과목별 정답률 평균은 과목마다 같은 비중, 전체 첫 풀이 정답률은 많이 푼 과목의 비중이 큽니다. 채점 가능 ${o.available}문항${o.pending ? ` · 검토 대기 ${o.pending}문항은 채점·분모에서 제외` : ''}. 재풀이는 첫 풀이 정답률을 바꾸지 않습니다.</p>
    </section>`;
  }
  function roundsHtml(s) {
    if (!s.doneRounds.length && !s.progressRounds.length) return '';
    const line = r => `<tr><th>${esc(r.label)}${r.done ? (r.counted ? '' : ' <span class="tiny muted">재응시 · 평균 제외</span>') : ' <span class="tiny muted">진행 중</span>'}</th>${app.bank.subjects.map(k => `<td data-l="${esc(k.replace('건축', ''))}">${r.done ? (r.per[k].score == null ? '—' : `<b class="${r.per[k].score < 40 ? 'bad' : ''}">${r.per[k].score}</b>`) : `${r.per[k].answered}/${r.per[k].size}`}</td>`).join('')}<td>${r.done ? `<b>${r.average}</b> <span class="state ${r.pass ? 'good' : 'bad'}">${r.pass ? '합격선' : '불합격선'}</span>` : `${r.answered}/${r.size}`}</td></tr>`;
    return `<section class="card"><div class="cardhead"><h2>회차 점수</h2><span class="sub">완료한 회차의 과목별 점수 · 진행 중은 평균 제외</span></div><div class="tablewrap"><table class="dash rounds"><thead><tr><th>회차</th>${app.bank.subjects.map(k => `<th>${esc(k.replace('건축', ''))}</th>`).join('')}<th>평균</th></tr></thead><tbody>${s.doneRounds.map(line).join('')}${s.progressRounds.map(line).join('')}</tbody></table></div><p class="tiny muted">과목 점수 = 그 회차에서 처음 낸 답 기준, 검토 대기 문항 제외 100점 환산.</p></section>`;
  }
  function stageSilgiHtml(s) {
    return `<section class="card"><div class="eyebrow">실기 준비 단계</div><h2>실기 학습은 자료가 준비되면 여기서 시작합니다</h2>
      <p>필기 기록은 그대로 보관되어 있어요. 실기 성과는 직접 작성한 답안·계산·재작성 기록으로 따로 집계합니다.</p>
      <button class="btn" data-act="stage" data-stage="필기">필기 단계로 돌아가기</button></section>${dashboardHtml(s)}${roundsHtml(s)}`;
  }

  // ---------- 문제 풀기 메뉴 ----------
  function practiceHtml() {
    const s = stats(); const b = app.bank;
    const roundItems = b.items.map(i => i.id);
    const allFlag = [...K.itemHistories(K.sortedEvents(events()), b)].map(([id, list]) => K.reviewState(list, b)).filter(Boolean);
    const due = allFlag.filter(r => r.due <= s.today);
    return `<section class="card"><div class="cardhead"><h2>회차별 풀이</h2><span class="sub">실제 시험처럼 100문항을 순서대로</span></div>
        <div class="rec"><div><b>${esc(b.title)}</b><p class="reason">100문항 · 채점 가능 ${s.overall.available}문항</p></div><button class="btn primary" data-act="round">처음부터 회차 풀기</button></div></section>
      <section class="card"><div class="cardhead"><h2>과목별 풀이</h2><span class="sub">새 문제는 안 푼 문제 5개씩</span></div>${s.subjects.map(S => `<div class="rec"><div><b>${esc(S.subject)}</b><p class="reason">안 푼 문제 ${S.unseen.length}개 · 진도 ${S.seen}/${S.available}</p></div><div class="btns"><button class="btn primary" data-act="subj" data-s="${esc(S.subject)}" data-new="1" ${S.unseen.length ? '' : 'disabled'}>새 문제</button><button class="btn" data-act="subj" data-s="${esc(S.subject)}">전체 20문항</button></div></div>`).join('')}</section>
      <section class="card"><div class="cardhead"><h2>오답·헷갈림 복습</h2><span class="sub">틀린 문제는 다음 날, 헷갈린 문제는 3일 뒤</span></div>
        <div class="rec"><div><b>오늘 복습할 문제 ${due.length}개</b><p class="reason">틀린 문제는 다음 날, 맞혔지만 헷갈린 문제는 3일 뒤에 다시 나옵니다.</p></div><button class="btn primary" data-act="review" data-all="0" ${due.length ? '' : 'disabled'}>복습 시작</button></div>
        <div class="rec"><div><b>복습 대상 전체 ${allFlag.length}개</b><p class="reason">기한과 관계없이 틀렸거나 헷갈린 문제 모두</p></div><button class="btn" data-act="review" data-all="1" ${allFlag.length ? '' : 'disabled'}>모두 풀기</button></div></section>`;
  }

  // ---------- 풀이 화면 ----------
  function studyHtml() {
    const s = curSession(); if (!s) { app.view = 'home'; return homeHtml(); }
    const st = app.study, id = s.items[st.idx], it = app.bank.byId[id];
    const mine = s.answers.get(id);
    const ok = K.scorable(it);
    const n = s.items.length, answered = s.answers.size;
    const done = s.items.every(x => s.answers.has(x) || !K.scorable(app.bank.byId[x]));
    const prevAttempts = (K.itemHistories(K.sortedEvents(events()), app.bank).get(id) || []).filter(e => e.data.session !== s.id);
    const choiceBtns = it.choices.map((c, i) => {
      const k = i + 1; let cls = '';
      if (mine) { if (ok && k === it.answer) cls = 'right'; if (k === Number(mine.data.choice) && (!ok || k !== it.answer)) cls = ok ? 'wrong' : 'picked'; }
      else if (st.selected === k) cls = 'sel';
      return `<button class="choice ${cls}" data-act="pick" data-k="${k}" ${mine ? 'disabled' : ''}><span class="num">${k}</span><span>${esc(c)}</span></button>`;
    }).join('');
    const figs = (it.figures || []).map(f => `<img class="fig" src="${f}" alt="문제 그림">`).join('');
    const needsOrig = (it.extractNotes || []).length > 0;
    const orig = (st.showOrig || (needsOrig && !figs)) ? (it.crops || []).map(c => `<img class="orig" src="${c}" alt="문제 원문">`).join('') : '';
    let result = '';
    if (mine) {
      const correct = ok && Number(mine.data.choice) === it.answer;
      result = `<section class="result ${ok ? (correct ? 'good' : 'bad') : 'muted'}">
        <div class="row-between"><b class="big">${ok ? (correct ? '정답입니다' : '틀렸습니다') : '정답 확인 전 문항'}</b>${saveStateHtml(mine.id)}</div>
        ${ok ? `<p>정답 <b>${CIRCLE[it.answer]} ${esc(it.choices[it.answer - 1])}</b> · 내 답 ${CIRCLE[mine.data.choice]}${mine.data.unsure ? ' · 헷갈림 표시' : ''}</p>` : `<p>답은 저장했어요. 해설집 대조가 끝나면 자동으로 채점됩니다.</p>`}
        ${ok ? `<p class="tiny muted">${correct && !mine.data.unsure ? '확실히 맞힌 문제는 복습에 넣지 않아요.' : correct ? '헷갈린 문제라 3일 뒤 복습에 다시 나옵니다.' : '내일 복습에 다시 나옵니다.'}</p>` : ''}
        ${it.explanationCrops && it.explanationCrops.length ? `<div class="expl"><div class="eyebrow">정답 · 해설 (해설집 ${esc((it.keySrc && it.keySrc.printedPages || []).join(', '))}쪽)</div>${it.explanationCrops.map(c => `<img src="${c}" alt="해설">`).join('')}</div>` : ''}
        ${it.keyNote ? `<p class="tiny">설계자 메모: ${esc(it.keyNote)}</p>` : ''}
      </section>`;
    }
    const meta = `${it.year}년 ${it.round}회 ${it.no}번 · ${esc(it.subject)}${prevAttempts.length ? ` · 이전 풀이 ${prevAttempts.length}회` : ''}`;
    return `<section class="study">
      <div class="studyhead"><button class="btn ghost" data-act="go" data-v="home">나가기</button><div><b>${esc(s.label)}</b><div class="tiny muted">${st.idx + 1}/${n}번째 · 제출 ${answered}/${n}</div></div><button class="btn ghost" data-act="grid">목록</button></div>
      <div class="progress"><i style="width:${Math.round(answered / n * 100)}%"></i></div>
      ${app.study.grid ? `<div class="grid">${s.items.map((x, i) => { const a = s.answers.get(x); const t = app.bank.byId[x]; const c = a ? (K.scorable(t) ? (K.isCorrect(a, app.bank) ? 'g' : 'r') : 'p') : ''; return `<button class="${c} ${i === st.idx ? 'cur' : ''}" data-act="jump" data-i="${i}">${t ? t.no : '?'}</button>`; }).join('')}</div>` : ''}
      ${done ? `<div class="donebar">이 풀이의 문제를 모두 제출했어요. <button class="btn primary" data-act="finish">결과 보기</button></div>` : ''}
      <article class="q card">
        <div class="tiny muted">${meta}${ok ? '' : ' · <span class="state warn">검토 대기 · 채점 제외</span>'}</div>
        <p class="stem">${esc(it.stem).replace(/\n/g, '<br>')}</p>
        ${figs}${orig}
        <button class="link" data-act="orig">${st.showOrig ? '원문 이미지 닫기' : '원문 이미지로 보기'}</button>
      </article>
      <div class="choices">${choiceBtns}</div>
      ${result}
      <div class="actionbar">
        <button class="btn icon" data-act="prev" aria-label="이전 문제" ${st.idx === 0 ? 'disabled' : ''}><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>
        ${mine ? `<button class="btn primary big" data-act="next">${st.idx + 1 < n ? '다음 문제' : '결과 보기'}</button>`
               : `<label class="unsure"><input type="checkbox" data-act="unsure" ${st.unsure ? 'checked' : ''}> 헷갈림</label><button class="btn primary big" data-act="submit" ${st.selected ? '' : 'disabled'}>제출</button>`}
        <button class="btn icon" data-act="skip" aria-label="건너뛰기" ${st.idx + 1 >= n ? 'disabled' : ''}><svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg></button>
      </div>
    </section>`;
  }

  // ---------- 기록 ----------
  function recordsHtml() {
    const s = stats(); const evs = K.sortedEvents(events()).filter(e => e.kind === 'attempt').reverse().slice(0, 60);
    return `${roundsHtml(s) || '<section class="card"><h2>회차 점수</h2><p class="muted">아직 끝낸 회차가 없어요.</p></section>'}
      <section class="card"><h2>최근 제출 ${evs.length}건</h2><div class="tablewrap"><table class="list"><thead><tr><th>시각</th><th>문항</th><th>내 답</th><th>결과</th><th>저장</th></tr></thead><tbody>
      ${evs.map(e => { const it = app.bank.byId[e.data.item]; const ok = K.scorable(it); return `<tr><td>${new Date(e.at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td><td>${it ? `${it.no}번 ${esc(it.subject)}` : esc(e.data.item)}</td><td>${CIRCLE[e.data.choice] || ''}${e.data.unsure ? ' ?' : ''}</td><td>${ok ? (K.isCorrect(e, app.bank) ? '<span class="good">정답</span>' : '<span class="bad">오답</span>') : '<span class="muted">검토 대기</span>'}</td><td>${saveStateHtml(e.id).replace('data-save-state', 'data-x')}</td></tr>`; }).join('')}
      </tbody></table></div></section>`;
  }

  // ---------- 설정 ----------
  function settingsHtml() {
    const st = app.store.state;
    const s = app.bank ? stats() : { stage: K.currentStage(K.sortedEvents(st.events)), overall: { available: 0, pending: 0 } };
    return `<section class="card"><h2>계정</h2>
        <p>${app.mode === 'local' ? '이 기기 전용 모드 (서버 연결 없음)' : `${esc(app.user.email)} · 역할 ${esc(app.role || '확인 중')}`}</p>
        ${app.mode === 'server' ? `<p class="tiny muted">기기 ${esc(deviceId())} · 마지막 서버 확인 ${st.lastPull ? new Date(st.lastPull).toLocaleString('ko-KR') : '없음'}${st.lastError ? ` · 마지막 오류: ${esc(st.lastError.message)}` : ''}</p><button class="btn" data-act="sync">지금 서버와 맞추기</button>` : ''}
        <button class="btn" data-act="logout">로그아웃</button>
        <button class="btn danger" data-act="logoutwipe">로그아웃하고 이 기기 기록 지우기</button>
        <p class="tiny muted">공용 PC라면 '기록 지우기'를 쓰세요. 서버에 저장되지 않은 기록(${st.outbox.length}건)이 있으면 지우기 전에 알려 드립니다.</p></section>
      <section class="card"><h2>백업</h2><p class="tiny muted">풀이 기록을 파일로 내려받거나, 백업 파일의 기록을 이 계정에 더합니다(같은 기록은 한 번만 들어갑니다).</p>
        <button class="btn" data-act="export">백업 내려받기</button><label class="btn filebtn">백업 불러오기<input type="file" accept=".json" data-act="import" hidden></label></section>
      <section class="card"><h2>시험 단계</h2><p>현재: <b>${esc(s.stage)}</b></p>
        ${s.stage === '필기' ? `<button class="btn" data-act="stage" data-stage="실기">필기 합격 · 실기 준비 시작</button><p class="tiny muted">직접 눌러야만 바뀝니다. 필기 기록은 계속 볼 수 있어요.</p>` : `<button class="btn" data-act="stage" data-stage="필기">필기 단계로 돌아가기</button>`}</section>
      <section class="card"><h2>문제은행</h2><p>${app.bank ? `${esc(app.bank.title)} · ${app.bank.items.length}문항` : '없음'} · 대조 완료 ${s.overall.available} · 검토 대기 ${s.overall.pending}</p>
        ${canEdit() ? `<button class="btn" data-act="go" data-v="keys">정답 대조 (설계자)</button>` : ''}
        ${app.mode === 'server' && canEdit() ? `<button class="btn" data-act="go" data-v="check">서버 접근 점검 (설계자)</button>` : ''}
        <label class="btn filebtn">문제은행 파일 교체<input type="file" accept=".json" data-act="bankfile" hidden></label></section>`;
  }

  // ---------- 정답 대조 (설계자) ----------
  function keysHtml() {
    const filter = app.viewArg || 'pending';
    const items = app.bank.items.filter(it => filter === 'all' || it.status !== '대조완료');
    return `<section class="card"><div class="row-between"><h2>정답 대조</h2><div class="btns"><button class="btn ${filter === 'pending' ? 'primary' : ''}" data-act="keyfilter" data-f="pending">검토 대기만</button><button class="btn ${filter === 'all' ? 'primary' : ''}" data-act="keyfilter" data-f="all">전체 100</button></div></div>
      <p class="tiny muted">자동 대조: 문제집과 해설집(분할본 1)의 문항 문장·정답 표시를 맞춰 봤어요. 확인이 필요한 문항만 '검토 대기'로 남겼습니다. ${app.mode === 'server' ? '저장하면 모든 기기에 반영됩니다.' : '이 기기에만 반영됩니다.'}</p></section>
      ${items.map(it => `<section class="card keycard"><div class="row-between"><b>${it.no}번 · ${esc(it.subject)}</b><span class="state ${it.status === '대조완료' ? 'good' : 'warn'}">${esc(it.status)}</span></div>
        ${(it.extractNotes || []).concat(it.linkNotes || []).map(n => `<div class="tiny bad">· ${esc(n)}</div>`).join('')}
        <div class="twocol"><div><div class="eyebrow">문제집 ${esc(it.src.printedPages.join(','))}쪽</div>${(it.crops || []).map(c => `<img src="${c}">`).join('')}</div>
        <div><div class="eyebrow">해설집 ${esc(it.keySrc ? it.keySrc.printedPages.join(',') : '—')}쪽</div>${(it.explanationCrops || []).map(c => `<img src="${c}">`).join('') || '<p class="muted">해설 없음</p>'}</div></div>
        <form class="keyform" data-id="${it.id}"><div class="btns">${[1, 2, 3, 4].map(k => `<label class="kbtn"><input type="radio" name="answer" value="${k}" ${it.answer === k ? 'checked' : ''}>${CIRCLE[k]}</label>`).join('')}</div>
        <select name="status">${['대조완료', '검토대기', '제외'].map(x => `<option ${it.status === x ? 'selected' : ''}>${x}</option>`).join('')}</select>
        <input name="note" placeholder="메모 (예: 법령 개정, 그림 확인)" value="${esc(it.keyNote || '')}"><button class="btn primary">저장</button></form></section>`).join('') || '<section class="card"><p>검토 대기 문항이 없습니다.</p></section>'}`;
  }
  async function saveKey(form) {
    const id = form.dataset.id, fd = new FormData(form);
    const row = { item_id: id, bank_id: app.bank.bankId, answer: fd.get('answer') ? Number(fd.get('answer')) : null, status: fd.get('status'), note: fd.get('note') || null, key_page: null };
    if (row.status === '대조완료' && !row.answer) { toast('대조완료는 정답 번호가 필요해요', 'bad'); return; }
    if (app.mode === 'server') {
      const { error } = await app.sb.from('kgs_bank_keys').upsert(row, { onConflict: 'item_id' });
      if (error) { toast('저장 실패: ' + error.message, 'bad'); return; }
    }
    app.store.state.keys[id] = { answer: row.answer, status: row.status, note: row.note, updated_at: new Date().toISOString() };
    app.store.save(); refreshBank(); render(); toast('정답 대조를 저장했습니다', 'ok');
  }

  // ---------- 서버 접근 점검 (설계자) ----------
  function checkHtml() {
    return `<section class="card"><h2>서버 접근 점검</h2>
      <p class="tiny muted">지금 로그인한 계정(A)으로 점검용 기록 1건을 쓰고, <b>점검용 다른 계정(B)</b>과 비로그인 상태에서 그 기록을 읽거나 고칠 수 없는지 확인합니다. B 계정은 학습보드 사용자로 등록하지 않은 계정을 쓰세요. 비밀번호는 이 화면에서만 쓰고 저장하지 않습니다.</p>
      <form id="checkForm"><label>B 이메일<input name="email" type="email" required></label><label>B 비밀번호<input name="password" type="password" required></label><button class="btn primary">점검 실행</button></form>
      <pre id="checkOut" class="out"></pre></section>`;
  }
  async function runCheck(form) {
    const out = $('#checkOut'); const log = (ok, t) => { out.textContent += `${ok ? '✔' : '✘'} ${t}\n`; };
    out.textContent = '';
    const fd = new FormData(form);
    const mk = key => window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { storageKey: key, persistSession: false, autoRefreshToken: false } });
    try {
      const probe = { id: K.uuid(), kind: 'position', item_id: null, data: { probe: true, session: 'probe' }, client_at: new Date().toISOString(), device_id: 'check' };
      let r = await app.sb.from('kgs_events').upsert([probe], { onConflict: 'id', ignoreDuplicates: true });
      log(!r.error, 'A: 내 기록 쓰기 ' + (r.error ? r.error.message : '성공'));
      r = await app.sb.from('kgs_events').select('id,user_id').eq('id', probe.id);
      log(!r.error && r.data.length === 1 && r.data[0].user_id === app.user.id, 'A: 내 기록 다시 읽기 · user_id가 내 계정');
      r = await app.sb.from('kgs_events').upsert([probe], { onConflict: 'id', ignoreDuplicates: true });
      r = await app.sb.from('kgs_events').select('id').eq('id', probe.id);
      log(r.data && r.data.length === 1, 'A: 같은 기록 재전송해도 1건');
      r = await app.sb.from('kgs_events').update({ data: { changed: true } }).eq('id', probe.id).select();
      log(!r.data || r.data.length === 0, 'A: 기록 수정 불가 (수정된 행 ' + (r.data ? r.data.length : 0) + ')');
      const B = mk('kgs-check-b');
      const li = await B.auth.signInWithPassword({ email: fd.get('email'), password: fd.get('password') });
      if (li.error) { log(false, 'B 로그인 실패: ' + li.error.message); return; }
      log(li.data.user.id !== app.user.id, 'B 로그인 (A와 다른 계정)');
      r = await B.from('kgs_events').select('id').eq('id', probe.id);
      log(!r.error && r.data.length === 0, 'B: A의 기록 읽기 차단 (보인 행 ' + (r.data ? r.data.length : '?') + ')');
      r = await B.from('kgs_events').select('id').limit(5);
      log(!r.error && r.data.every(x => x.id !== probe.id), 'B: 전체 조회에도 A 기록 없음');
      r = await B.from('kgs_events').update({ data: { hacked: true } }).eq('id', probe.id).select();
      log(!r.data || r.data.length === 0, 'B: A의 기록 수정 차단');
      r = await B.from('kgs_events').delete().eq('id', probe.id).select();
      log(!r.data || r.data.length === 0, 'B: A의 기록 삭제 차단');
      await B.from('kgs_events').upsert([Object.assign({}, probe, { data: { overwrite: true } })], { onConflict: 'id', ignoreDuplicates: true });
      r = await app.sb.from('kgs_events').select('data,user_id').eq('id', probe.id);
      log(r.data && r.data.length === 1 && !r.data[0].data.overwrite && r.data[0].user_id === app.user.id, 'B: 같은 id로 덮어쓰기 시도해도 A의 기록 그대로');
      const bm = await B.from('kgs_members').select('role');
      r = await B.storage.from('kgs-bank').download((CFG.bankFiles || [])[0]);
      log(!!r.error || (bm.data && bm.data.length > 0), 'B(미등록): 문제은행 내려받기 ' + (r.error ? '차단' : '허용됨 — B가 등록 사용자인지 확인'));
      r = await B.from('kgs_bank_keys').select('item_id').limit(1);
      log(!r.error && (r.data.length === 0 || (bm.data && bm.data.length > 0)), 'B(미등록): 정답표 읽기 차단');
      await B.auth.signOut();
      const anon = mk('kgs-check-anon');
      r = await anon.from('kgs_events').select('id').limit(1);
      log(!!r.error || r.data.length === 0, '비로그인: 기록 읽기 차단');
      r = await anon.from('kgs_events').insert([{ id: K.uuid(), kind: 'stage', data: {}, client_at: new Date().toISOString() }]);
      log(!!r.error, '비로그인: 기록 쓰기 차단');
      r = await anon.storage.from('kgs-bank').download((CFG.bankFiles || [])[0]);
      log(!!r.error, '비로그인: 문제은행 내려받기 차단');
      out.textContent += '\n점검용 기록(position · probe) 1건이 A 계정에 남습니다. 통계에는 영향이 없습니다.';
    } catch (e) { log(false, '점검 중 오류: ' + (e.message || e)); }
  }

  // ---------- 학습자 기록 (최고관리자, 읽기 전용) ----------
  async function loadLearners() {
    const gen = app.gen;
    app.watch = { list: null, uid: null, events: null, at: null, error: null, loading: true };
    const { data, error } = await app.sb.from('kgs_members').select('user_id,role,label').eq('role', 'learner');
    if (gen !== app.gen) return;
    if (error) { app.watch.error = error.message; render(); return; }
    app.watch.list = data || [];
    if (!app.watch.uid && app.watch.list.length) app.watch.uid = app.watch.list[0].user_id;
    await loadLearnerEvents();
  }
  async function loadLearnerEvents() {
    const gen = app.gen, w = app.watch; if (!w || !w.uid) { render(); return; }
    w.loading = true; render();
    try {
      const rows = []; let from = 0;
      for (;;) {
        const { data, error } = await app.sb.from('kgs_events').select('id,kind,item_id,data,client_at,device_id,created_at').eq('user_id', w.uid).order('created_at', { ascending: true }).order('id', { ascending: true }).range(from, from + 999);
        if (error) throw error;
        rows.push(...data); if (data.length < 1000) break; from += 1000;
      }
      if (gen !== app.gen) return;
      const evs = {}; for (const r of rows) evs[r.id] = { id: r.id, kind: r.kind, item: r.item_id, data: r.data, at: new Date(r.client_at).toISOString(), device: r.device_id };
      w.events = evs; w.at = new Date().toISOString(); w.error = null;
    } catch (e) { if (gen === app.gen) w.error = e.message || String(e); }
    w.loading = false; if (gen === app.gen && app.view === 'learners') render();
  }
  function learnersHtml() {
    if (!app.watch) loadLearners();
    const w = app.watch;
    if (!w.list && !w.error) { return '<section class="card"><p class="muted">학습자 기록을 불러오는 중…</p></section>'; }
    if (w.error) return `<section class="card"><h2>학습자 기록</h2><p class="msg bad">불러오지 못했습니다: ${esc(w.error)}</p><button class="btn" data-act="watchreload">다시 불러오기</button></section>`;
    if (!w.list.length) return '<section class="card"><h2>학습자 기록</h2><p class="muted">등록된 학습자가 없습니다.</p></section>';
    const who = w.list.find(x => x.user_id === w.uid);
    const head = `<section class="card"><div class="cardhead row-between"><div><h2>${esc(who && who.label || '학습자')} 학습 기록</h2><span class="sub">읽기 전용 · 서버에 저장된 기록 기준${w.at ? ' · ' + new Date(w.at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' 확인' : ''}</span></div>
      <div class="btns">${w.list.length > 1 ? `<select data-act="watchwho">${w.list.map(x => `<option value="${x.user_id}" ${x.user_id === w.uid ? 'selected' : ''}>${esc(x.label || x.user_id.slice(0, 8))}</option>`).join('')}</select>` : ''}<button class="btn" data-act="watchreload">${w.loading ? '불러오는 중…' : '새로 불러오기'}</button></div></div>
      <p class="foot" style="margin-top:0">아직 학습자 기기에서 서버로 보내지 못한 풀이는 여기에 보이지 않습니다.</p></section>`;
    if (!w.events) return head;
    const s = K.computeStats(app.bank, w.events, new Date().toISOString());
    const attempts = K.sortedEvents(w.events).filter(e => e.kind === 'attempt');
    // 최근 14일 하루별 풀이 수
    const days = []; for (let i = 13; i >= 0; i--) days.push(K.addDays(s.today, -i));
    const perDay = Object.fromEntries(days.map(d => [d, 0])); attempts.forEach(e => { const d = K.kstDate(e.at); if (d in perDay) perDay[d]++; });
    const max = Math.max(1, ...Object.values(perDay));
    const last = attempts.length ? attempts[attempts.length - 1] : null;
    const activity = `<section class="card"><div class="cardhead"><h2>최근 14일 풀이량</h2><span class="sub">하루에 제출한 횟수 · 마지막 풀이 ${last ? new Date(last.at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '없음'}</span></div>
      <div class="days">${days.map(d => `<div class="day" title="${d} · ${perDay[d]}회"><i style="height:${Math.round(perDay[d] / max * 100)}%"></i><b>${perDay[d] || ''}</b><span>${Number(d.slice(8))}</span></div>`).join('')}</div></section>`;
    const recent = attempts.slice(-30).reverse();
    const list = `<section class="card"><div class="cardhead"><h2>최근 제출 ${recent.length}건</h2><span class="sub">헷갈림 표시는 ?로 보입니다</span></div><div class="tablewrap"><table class="list"><thead><tr><th>시각</th><th>문항</th><th>답</th><th>결과</th><th>구분</th></tr></thead><tbody>
      ${recent.map(e => { const it = app.bank.byId[e.data.item]; const ok = K.scorable(it); const hist = K.itemHistories(K.sortedEvents(w.events), app.bank).get(e.data.item) || []; const first = hist[0] && hist[0].id === e.id;
        return `<tr><td>${new Date(e.at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td><td>${it ? `${it.no}번 ${esc(it.subject)}` : esc(e.data.item)}</td><td>${e.data.choice}${e.data.unsure ? ' ?' : ''}</td><td>${ok ? (K.isCorrect(e, app.bank) ? '<span class="good">정답</span>' : '<span class="bad">오답</span>') : '<span class="muted">검토 대기</span>'}</td><td class="muted">${first ? '첫 풀이' : '복습'}</td></tr>`; }).join('')}
      </tbody></table></div></section>`;
    return head + dashboardHtml(s) + activity + roundsHtml(s) + list;
  }

  // ---------- 회차 결과 ----------
  function finishHtmlToast() {
    const s = stats(); const done = s.doneRounds.find(r => r.session === app.study.sessionId);
    if (done) toast(`회차 완료 · 평균 ${done.average}점${done.failSubjects.length ? ' · 과락 ' + done.failSubjects.join(', ') : ''}`, done.pass ? 'ok' : 'bad');
    else toast('이 풀이를 마쳤어요');
  }

  // =====================================================================
  // 이벤트
  // =====================================================================
  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-act]'); if (!b || b.tagName === 'INPUT') return;
    const act = b.dataset.act;
    try {
      if (act === 'go') { if (b.dataset.v === 'learners' && app.watch && app.watch.list) loadLearnerEvents(); app.view = b.dataset.v; app.viewArg = null; if (b.dataset.v !== 'study') app.study = app.view === 'study' ? app.study : null; render(); window.scrollTo(0, 0); }
      else if (act === 'local') { await startAccount('local', { id: 'local' }); }
      else if (act === 'signup') { const f = $('#loginForm'); if (!f.reportValidity()) return; const fd = new FormData(f); const { error } = await app.sb.auth.signUp({ email: fd.get('email'), password: fd.get('password'), options: { emailRedirectTo: location.href.split('#')[0] } }); $('#loginMsg').textContent = error ? '가입 실패: ' + error.message : '가입 요청 완료. 메일의 확인 링크를 누른 뒤 로그인하세요.'; }
      else if (act === 'sync') { kick(); }
      else if (act === 'resume') { openSession(b.dataset.id); }
      else if (act === 'rec') { const r = K.recommend(app.bank, stats())[Number(b.dataset.i)]; if (r) startSession(r.mode, r.label, r.items, r.roundKey); }
      else if (act === 'quick') { startSession('quick', '15분 학습', K.quickSet(app.bank, stats())); }
      else if (act === 'round') { startSession('round', app.bank.title, app.bank.items.map(i => i.id), app.bank.bankId); }
      else if (act === 'subj') { const S = stats().subjects.find(x => x.subject === b.dataset.s); const ids = b.dataset.new ? S.unseen.slice(0, 5) : app.bank.items.filter(i => i.subject === S.subject).map(i => i.id); startSession('subject', `${S.subject} ${b.dataset.new ? '새 문제' : '전체'}`, ids); }
      else if (act === 'review') { const s = stats(); const all = [...K.itemHistories(K.sortedEvents(events()), app.bank)].map(([, l]) => K.reviewState(l, app.bank)).filter(Boolean); const ids = (b.dataset.all === '1' ? all : all.filter(r => r.due <= s.today)).map(r => r.item); startSession('review', '오답·헷갈림 복습', ids); }
      else if (act === 'pick') { app.study.selected = Number(b.dataset.k); render(); }
      else if (act === 'submit') { b.disabled = true; submit(); }
      else if (act === 'next') { const s = curSession(); if (app.study.idx + 1 < s.items.length) openItem(app.study.idx + 1); else { finishHtmlToast(); app.view = 'home'; app.study = null; render(); } }
      else if (act === 'skip') { openItem(app.study.idx + 1); }
      else if (act === 'prev') { openItem(app.study.idx - 1); }
      else if (act === 'jump') { app.study.grid = false; openItem(Number(b.dataset.i)); }
      else if (act === 'grid') { app.study.grid = !app.study.grid; render(); }
      else if (act === 'orig') { app.study.showOrig = !app.study.showOrig; render(); }
      else if (act === 'finish') { finishHtmlToast(); addEvent('session_end', { session: app.study.sessionId, reason: 'done' }); app.view = 'home'; app.study = null; render(); }
      else if (act === 'stage') { if (confirm(b.dataset.stage === '실기' ? '필기 합격 후 실기 준비를 시작할까요? 필기 기록은 그대로 남습니다.' : '필기 단계로 돌아갈까요?')) { addEvent('stage', { stage: b.dataset.stage }); render(); } }
      else if (act === 'export') { exportBackup(); }
      else if (act === 'reloadbank') { await loadBank(app.gen); render(); }
      else if (act === 'watchreload') { if (app.watch && app.watch.list) loadLearnerEvents(); else { app.watch = null; render(); } }
      else if (act === 'keyfilter') { app.viewArg = b.dataset.f; render(); }
      else if (act === 'logout' || act === 'logoutwipe') { await logout(act === 'logoutwipe'); }
    } catch (err) { console.error(err); toast(String(err.message || err), 'bad'); }
  });
  document.addEventListener('change', async e => {
    const t = e.target; const act = t.dataset && t.dataset.act;
    try {
      if (act === 'unsure') { app.study.unsure = t.checked; }
      else if (act === 'watchwho') { app.watch.uid = t.value; app.watch.events = null; loadLearnerEvents(); }
      else if (act === 'bankfile' && t.files[0]) { await openBankFile(t.files[0]); }
      else if (act === 'import' && t.files[0]) { await importBackup(t.files[0]); }
    } catch (err) { toast(String(err.message || err), 'bad'); }
  });
  document.addEventListener('submit', async e => {
    const f = e.target; e.preventDefault();
    if (f.id === 'loginForm') {
      const fd = new FormData(f); $('#loginMsg').textContent = '로그인 중…';
      const { error } = await app.sb.auth.signInWithPassword({ email: fd.get('email'), password: fd.get('password') });
      if (error) $('#loginMsg').textContent = '로그인 실패: ' + error.message;
    } else if (f.classList.contains('keyform')) await saveKey(f);
    else if (f.id === 'checkForm') await runCheck(f);
  });
  window.addEventListener('online', () => { renderStatus(); kick(); });
  window.addEventListener('offline', renderStatus);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') kick(); });
  window.addEventListener('storage', e => { if (app.store && e.key === app.store.key) { try { app.store.reload(); refreshBank(); softRender(); } catch (_) { } } });

  // ---------- 백업 ----------
  function exportBackup() {
    const st = app.store.state;
    const blob = new Blob([JSON.stringify({ kind: 'kgs-backup', v: 1, exportedAt: new Date().toISOString(), account: app.mode === 'local' ? 'local' : app.user.email, events: Object.values(st.events), keys: st.keys }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `건축기사학습보드-백업-${K.kstDate(new Date().toISOString())}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  async function importBackup(file) {
    const b = JSON.parse(await file.text());
    if (b.kind !== 'kgs-backup' || !Array.isArray(b.events)) throw new Error('학습보드 백업 파일이 아닙니다');
    let n = 0;
    for (const ev of b.events) { if (ev && ev.id && ev.kind && ev.data && ev.at && !app.store.state.events[ev.id]) { app.store.state.events[ev.id] = ev; app.store.state.outbox.push(ev.id); n++; } }
    app.store.save(); toast(`백업에서 ${n}건을 더했습니다`, 'ok'); kick(); render();
  }
  async function logout(wipe) {
    if (wipe && app.store.state.outbox.length && !confirm(`서버에 아직 보내지 못한 기록 ${app.store.state.outbox.length}건이 있습니다. 지우면 사라집니다. 계속할까요?`)) return;
    if (wipe) { app.store.wipe(); try { await idb.del(bankKey()); } catch (_) { } }
    if (app.mode === 'server') await app.sb.auth.signOut(); // onAuthStateChange → teardown
    else { teardown(); app.mode = null; render(); }
  }
  function renderCorrupt(e, uid) {
    $('#app').innerHTML = `<section class="card login"><h2>이 기기의 기록을 읽지 못했어요</h2><p>원본을 지우지 않았습니다. 먼저 원본을 내려받아 보관한 뒤 다시 시작할 수 있어요.</p>
      <button class="btn" id="dlRaw">원본 내려받기</button> <button class="btn danger" id="resetRaw">원본을 받은 뒤 이 기기 기록 새로 시작</button></section>`;
    $('#dlRaw').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([e.raw])); a.download = 'kgs-원본-' + uid + '.txt'; a.click(); };
    $('#resetRaw').onclick = () => { if (confirm('원본을 내려받으셨나요? 이 기기 기록을 비웁니다. 서버에 저장된 기록은 다시 받아옵니다.')) { localStorage.removeItem('kgs1:u:' + uid); location.reload(); } };
  }

  // ---------- 시작 ----------
  async function boot() {
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
    if (serverConfigured()) {
      app.sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { storageKey: 'kgs1-auth', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
      let lastUid = undefined;
      const handle = session => {
        const uid = session && session.user ? session.user.id : null;
        if (uid === lastUid) return; // 같은 계정의 중복 알림 무시
        lastUid = uid;
        if (uid) startAccount('server', session.user); else { teardown(); app.mode = null; render(); }
      };
      app.sb.auth.onAuthStateChange((_ev, session) => setTimeout(() => handle(session), 0));
      const { data } = await app.sb.auth.getSession();
      handle(data.session);
    } else {
      if (CFG.supabaseUrl && !window.supabase) app.libError = true;
      render();
    }
  }
  window.KGS_APP = app; // 점검용
  boot();
})();
