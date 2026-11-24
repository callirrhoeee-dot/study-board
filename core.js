/* 건축기사 학습보드 — 핵심 로직 (화면 없음, Node 테스트와 브라우저가 같은 코드를 쓴다)
 * - 학습 기록은 '이벤트'만 쌓는다(append-only). 통계는 저장하지 않고 매번 이벤트에서 계산한다.
 * - 이벤트 id는 기기에서 만든 UUID. 서버는 같은 id를 두 번 받아도 한 번만 저장한다.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KGS = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SUBJECTS = ['건축계획', '건축시공', '건축구조', '건축설비', '건축관계법규'];
  const PASS = { subjectMin: 40, average: 60, sample: 20 }; // 실제 합격 기준: 과목 40점 이상, 평균 60점 이상. 표본 = 시험 1회분 과목 문항 수
  const KINDS = ['attempt', 'session', 'session_end', 'position', 'stage'];

  // ---------- 날짜 (한국 시간) ----------
  const kstFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
  function kstDate(iso) { return kstFmt.format(new Date(iso)); }
  function dayNum(ymd) { const [y, m, d] = ymd.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; }
  function addDays(ymd, n) { return new Date((dayNum(ymd) + n) * 86400000).toISOString().slice(0, 10); }

  function uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
  }

  // ---------- 문제은행 ----------
  /** 문제은행 + 정답 대조 결과(keys)를 합친다. keys가 은행 안의 값보다 우선한다. */
  function effectiveBank(bank, keys) {
    const items = bank.items.map(it => {
      const k = keys && keys[it.id];
      if (!k) return it;
      return Object.assign({}, it, {
        answer: k.answer != null ? k.answer : it.answer,
        status: k.status || it.status,
        keyNote: k.note || null,
      });
    });
    const byId = Object.create(null); items.forEach(it => { byId[it.id] = it; });
    return { bankId: bank.bankId, title: bank.title, subjects: bank.subjects || SUBJECTS, items, byId };
  }
  function scorable(it) { return !!it && it.status === '대조완료' && [1, 2, 3, 4].includes(it.answer); }

  // ---------- 이벤트 정렬 ----------
  function cmpEv(a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); }
  function sortedEvents(events) { return Object.values(events).sort(cmpEv); }

  // ---------- 세션(회차/과목/복습/15분) ----------
  function sessionsOf(evs) {
    const map = new Map();
    for (const e of evs) {
      if (e.kind === 'session') map.set(e.id, { id: e.id, at: e.at, mode: e.data.mode, label: e.data.label, roundKey: e.data.roundKey || null, concept: e.data.concept || null, items: e.data.items, ended: false, answers: new Map(), lastPos: null });
    }
    for (const e of evs) {
      const s = e.data && map.get(e.data.session);
      if (!s) continue;
      if (e.kind === 'session_end') s.ended = true;
      if (e.kind === 'attempt' && !s.answers.has(e.data.item)) s.answers.set(e.data.item, e); // 세션 안에서는 먼저 제출한 답이 그 세션의 답
      if (e.kind === 'position') s.lastPos = e; // 시각 순으로 정렬되어 있으므로 마지막 것이 최신
    }
    return map;
  }
  function sessionDone(s, bank) {
    return s.items.every(id => s.answers.has(id) || !scorable(bank.byId[id]));
  }
  /** 이어서 풀 문항: 마지막으로 연 문항이 아직 안 풀렸으면 그 문항, 아니면 그 뒤의 첫 미제출 문항 */
  function resumeIndex(s) {
    const order = s.items; let start = 0;
    if (s.lastPos) { const i = order.indexOf(s.lastPos.data.item); if (i >= 0) start = i; }
    for (let k = 0; k < order.length; k++) { const i = (start + k) % order.length; if (!s.answers.has(order[i])) return i; }
    return -1;
  }
  function activeSession(evs, bank, stage) {
    const ss = [...sessionsOf(evs).values()].filter(s => !s.ended && (s.items || []).some(id => bank.byId[id]))
      .filter(s => resumeIndex(s) >= 0 && !sessionDone(s, bank));
    if (!ss.length) return null;
    // 가장 최근에 손댄 세션
    const touched = s => { let t = s.at; s.answers.forEach(e => { if (e.at > t) t = e.at; }); if (s.lastPos && s.lastPos.at > t) t = s.lastPos.at; return t; };
    ss.sort((a, b) => touched(b) < touched(a) ? -1 : 1);
    return ss[0];
  }
  function currentStage(evs) { let st = '필기'; for (const e of evs) if (e.kind === 'stage') st = e.data.stage; return st; }

  // ---------- 문항별 이력 ----------
  function itemHistories(evs, bank) {
    const h = new Map();
    for (const e of evs) {
      if (e.kind !== 'attempt') continue;
      const it = bank.byId[e.data.item]; if (!it) continue;
      if (!h.has(it.id)) h.set(it.id, []);
      h.get(it.id).push(e);
    }
    return h;
  }
  function isCorrect(e, bank) { const it = bank.byId[e.data.item]; return scorable(it) && Number(e.data.choice) === it.answer; }

  /** 복습 상태: 틀렸거나 헷갈림을 누른 적이 있는 문항. 끝에서부터 연속 '확실한 정답' 2번이면 졸업. */
  function reviewState(list, bank) {
    const it = bank.byId[list[0].data.item];
    if (!scorable(it)) return null;
    const flagged = list.some(e => !isCorrect(e, bank) || e.data.unsure);
    if (!flagged) return null;
    let streak = 0;
    for (let i = list.length - 1; i >= 0; i--) { const e = list[i]; if (isCorrect(e, bank) && !e.data.unsure) streak++; else break; }
    if (streak >= 2) return null;
    const last = list[list.length - 1];
    const lastDay = kstDate(last.at);
    let gap = 1; // 틀림 → 다음 날
    if (isCorrect(last, bank) && last.data.unsure) gap = 3; // 맞았지만 헷갈림 → 3일 뒤
    else if (streak === 1) gap = 3;
    return { item: it.id, due: addDays(lastDay, gap), lastWrong: !isCorrect(last, bank), unsure: !!last.data.unsure };
  }

  // ---------- 통계 ----------
  function computeStats(bank, events, nowIso) {
    const evs = Array.isArray(events) ? events.slice().sort(cmpEv) : sortedEvents(events);
    const today = kstDate(nowIso);
    const weekStart = addDays(today, -6);
    const hist = itemHistories(evs, bank);
    const subj = {};
    for (const s of bank.subjects) subj[s] = {
      subject: s, available: 0, pending: 0, seen: 0,
      vol: { today: { fresh: 0, review: 0 }, week: { fresh: 0, review: 0 }, all: { fresh: 0, review: 0 } },
      firstCount: 0, firstCorrect: 0, firstWrong: 0, retried: 0, retryCorrect: 0, unsureItems: 0,
      dueReviews: [], unseen: [], rounds: [], roundAvg: null, status: '', statusTone: '',
      lastWeekAttempts: 0,
    };
    for (const it of bank.items) {
      const S = subj[it.subject]; if (!S) continue;
      if (scorable(it)) S.available++; else S.pending++;
      const list = hist.get(it.id);
      if (!list) { if (scorable(it)) S.unseen.push(it.id); continue; }
      if (!scorable(it)) continue; // 정답 확인 전 문항의 풀이는 저장만 하고 집계하지 않는다(정답이 확정되면 자동 반영)
      S.seen++;
      list.forEach((e, i) => {
        const d = kstDate(e.at); const k = i === 0 ? 'fresh' : 'review';
        S.vol.all[k]++;
        if (d >= weekStart && d <= today) { S.vol.week[k]++; S.lastWeekAttempts++; }
        if (d === today) S.vol.today[k]++;
      });
      S.firstCount++;
      if (isCorrect(list[0], bank)) S.firstCorrect++;
      else {
        S.firstWrong++;
        if (list.length > 1) { S.retried++; if (isCorrect(list[1], bank)) S.retryCorrect++; }
      }
      if (list.some(e => e.data.unsure)) S.unsureItems++;
      const rs = reviewState(list, bank);
      if (rs && rs.due <= today) S.dueReviews.push(rs);
    }
    // 회차 점수: 회차 세션이 끝난(모든 채점 가능 문항 제출) 경우만 평균에 넣는다. 회차별 첫 완료 기록 기준.
    const sessions = [...sessionsOf(evs).values()].filter(s => s.mode === 'round');
    const doneRounds = [], progressRounds = [];
    const firstDoneByRound = new Map();
    for (const s of sessions) {
      const per = {};
      for (const sname of bank.subjects) per[sname] = { correct: 0, total: 0, answered: 0, size: 0 };
      for (const id of s.items) {
        const it = bank.byId[id]; if (!it || !per[it.subject]) continue;
        per[it.subject].size++;
        if (s.answers.has(id)) per[it.subject].answered++;
        if (!scorable(it)) continue;
        per[it.subject].total++;
        const e = s.answers.get(id);
        if (e && isCorrect(e, bank)) per[it.subject].correct++;
      }
      const answered = s.items.filter(id => s.answers.has(id)).length;
      const done = sessionDone(s, bank);
      const rec = { session: s.id, label: s.label, roundKey: s.roundKey, at: s.at, done, answered, size: s.items.length, per };
      if (done) {
        for (const k in per) per[k].score = per[k].total ? Math.round(per[k].correct / per[k].total * 1000) / 10 : null;
        const scores = Object.values(per).map(p => p.score).filter(v => v != null);
        rec.average = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 10) / 10 : null;
        rec.failSubjects = Object.keys(per).filter(k => per[k].score != null && per[k].score < PASS.subjectMin);
        rec.pass = rec.average != null && rec.average >= PASS.average && rec.failSubjects.length === 0;
        if (!firstDoneByRound.has(s.roundKey)) { firstDoneByRound.set(s.roundKey, rec); rec.counted = true; } else rec.counted = false;
        doneRounds.push(rec);
      } else if (answered > 0 && !s.ended) progressRounds.push(rec);
    }
    for (const sname of bank.subjects) {
      const S = subj[sname];
      const counted = [...firstDoneByRound.values()].map(r => r.per[sname].score).filter(v => v != null);
      S.roundCount = counted.length;
      S.roundAvg = counted.length ? Math.round(counted.reduce((a, b) => a + b, 0) / counted.length * 10) / 10 : null;
      S.accuracy = S.firstCount ? S.firstCorrect / S.firstCount : null;
      S.progress = S.available ? S.seen / S.available : 0;
      // 판정 (실제 합격 기준과 같은 숫자 사용)
      const acc = S.accuracy == null ? null : S.accuracy * 100;
      const low = v => v != null && v < PASS.subjectMin, under = v => v != null && v < PASS.average;
      if (!S.firstCount) { S.status = '미학습'; S.statusTone = 'none'; }
      else if (S.firstCount < PASS.sample && S.roundCount === 0) { S.status = '판단 보류 · 표본 적음'; S.statusTone = 'muted'; }
      else if (low(acc) || low(S.roundAvg)) { S.status = '과락 위험 (40점 미만)'; S.statusTone = 'bad'; }
      else if (under(acc) || under(S.roundAvg)) { S.status = '보완 필요 (60점 미만)'; S.statusTone = 'warn'; }
      else { S.status = '기준 충족'; S.statusTone = 'good'; }
    }
    const list = bank.subjects.map(s => subj[s]);
    const studied = list.filter(S => S.firstCount > 0);
    const totals = list.reduce((a, S) => ({ first: a.first + S.firstCount, correct: a.correct + S.firstCorrect, available: a.available + S.available, pending: a.pending + S.pending }), { first: 0, correct: 0, available: 0, pending: 0 });
    const overall = {
      subjectMean: studied.length ? studied.reduce((a, S) => a + S.accuracy, 0) / studied.length : null,
      subjectsCounted: studied.length, subjectsTotal: list.length,
      pooled: totals.first ? totals.correct / totals.first : null, pooledN: totals.first, pooledCorrect: totals.correct,
      available: totals.available, pending: totals.pending,
    };
    const active = activeSession(evs, bank);
    return { today, subjects: list, overall, doneRounds, progressRounds, active, activeResume: active ? resumeIndex(active) : -1, stage: currentStage(evs) };
  }

  // ---------- 오늘 공부할 것 ----------
  function recommend(bank, stats) {
    const recs = [];
    const S = stats.subjects.filter(s => s.available > 0);
    if (!stats.overall.pooledN) {
      const round = bank.items.filter(scorable).map(i => i.id);
      if (round.length) recs.push({ kind: 'round', title: `${bank.title} 회차 풀이`, reason: '아직 풀이 기록이 없어요. 실제 시험처럼 한 회차를 풀면 과목별 실력이 한 번에 보입니다.', items: bank.items.map(i => i.id), mode: 'round', label: bank.title, roundKey: bank.bankId, cta: '회차 시작' });
    }
    // ① 점수가 부족한 과목 → 복습
    const weak = S.filter(s => s.firstCount >= PASS.sample || s.roundCount > 0)
      .filter(s => (s.accuracy != null && s.accuracy * 100 < PASS.average) || (s.roundAvg != null && s.roundAvg < PASS.average))
      .sort((a, b) => (a.accuracy || 0) - (b.accuracy || 0));
    for (const s of weak.slice(0, 1)) {
      const due = s.dueReviews.slice(0, 5).map(r => r.item);
      const pct = Math.round(s.accuracy * 100);
      if (due.length) recs.push({ kind: 'weak', subject: s.subject, title: `${s.subject} · 오답 ${due.length}개 복습`, reason: `충분히 풀었는데 점수가 부족해요 — 첫 풀이 ${s.firstCorrect}/${s.firstCount}문항 · ${pct}% (합격선 60점)`, items: due, mode: 'review', label: `${s.subject} 오답 복습`, cta: '복습 시작' });
    }
    // ② 이번 주 가장 적게 푼 과목 → 새 문제
    const fresh = S.filter(s => s.unseen.length > 0).sort((a, b) => a.lastWeekAttempts - b.lastWeekAttempts || a.progress - b.progress);
    if (stats.overall.pooledN && fresh.length) {
      const s = fresh[0];
      const items = s.unseen.slice(0, 5);
      recs.push({ kind: 'fresh', subject: s.subject, title: `${s.subject} · 새 기출 ${items.length}문제`, reason: `이번 주에 가장 적게 푼 과목 — 최근 7일 ${s.lastWeekAttempts}회, 진도 ${s.seen}/${s.available}문항`, items, mode: 'subject', label: `${s.subject} 새 문제`, cta: '새 문제 시작' });
    }
    // ③ 기한이 된 복습(오답·헷갈림)
    const allDue = stats.subjects.flatMap(s => s.dueReviews);
    const usedWeak = new Set(recs.filter(r => r.kind === 'weak').flatMap(r => r.items));
    const rest = allDue.filter(r => !usedWeak.has(r.item));
    if (rest.length) {
      const unsure = rest.filter(r => r.unsure && !r.lastWrong).length;
      recs.push({ kind: 'due', title: `틀린·헷갈린 문제 ${Math.min(rest.length, 8)}개 다시 풀기`, reason: `복습할 때가 된 문항 ${rest.length}개${unsure ? ` (맞혔지만 헷갈림 ${unsure}개 포함)` : ''}`, items: rest.slice(0, 8).map(r => r.item), mode: 'review', label: '오답·헷갈림 복습', cta: '복습 시작' });
    }
    return recs.slice(0, 3);
  }
  /** 15분 학습: 기한 된 복습 최대 4개 + 가장 덜 푼 과목 새 문제로 8문항 */
  function quickSet(bank, stats) {
    const due = stats.subjects.flatMap(s => s.dueReviews).slice(0, 4).map(r => r.item);
    const fresh = stats.subjects.filter(s => s.unseen.length).sort((a, b) => a.lastWeekAttempts - b.lastWeekAttempts || a.progress - b.progress);
    const out = due.slice();
    for (const s of fresh) for (const id of s.unseen) { if (out.length >= 8) break; if (!out.includes(id)) out.push(id); }
    return out;
  }

  // ---------- 개념 카드 (과목에 묶이지 않음 · 기존 기록 방식 그대로) ----------
  /* 카드 학습 = 기존 'session' 사건(mode 'concept', data.concept = 카드 id). 새 사건 종류나 서버 변경이 없다.
   * 확인 문제 풀이는 보통 'attempt'로 쌓여 과목 통계에도 그대로 들어간다(어느 경로로 풀어도 같은 문항 이력). */
  function conceptCards(concepts, subject) {
    const S = concepts && concepts.subjects && concepts.subjects[subject];
    return S ? S.cards : [];
  }
  function allConceptCards(concepts) {
    if (!concepts || !concepts.subjects) return [];
    return Object.keys(concepts.subjects).reduce((a, k) => a.concat(concepts.subjects[k].cards), []);
  }
  /** 하루 묶음: 기출 빈도 순서대로 perDay장씩. 먼저 알아야 할 카드(prereq)가 뒤에 있으면 앞으로 당긴다. */
  function conceptPlan(cards, perDay) {
    perDay = perDay || 3;
    const byId = new Map(cards.map(c => [c.id, c]));
    const seq = [], seen = new Set();
    const put = (c, depth) => {
      if (!c || seen.has(c.id) || depth > 8) return;
      (c.prereq || []).forEach(p => put(byId.get(p), depth + 1));
      if (!seen.has(c.id)) { seen.add(c.id); seq.push(c.id); }
    };
    cards.slice().sort((a, b) => (a.rank || 0) - (b.rank || 0)).forEach(c => put(c, 0));
    const days = [];
    for (let i = 0; i < seq.length; i += perDay) days.push({ day: days.length + 1, ids: seq.slice(i, i + perDay) });
    return days;
  }
  /** 문항 → 관련 카드 (대표 개념 먼저, 함께 걸린 개념 뒤) */
  function conceptsOfItem(cards, itemId) {
    const main = cards.filter(c => c.items.includes(itemId)).map(c => ({ card: c, main: true }));
    const also = cards.filter(c => (c.also || []).includes(itemId) && !c.items.includes(itemId)).map(c => ({ card: c, main: false }));
    return main.concat(also);
  }
  const CALC = /구하면|얼마|값은|크기는|계산|산정/;
  /** 카드 직후 확인 문제(쉬운 것 먼저 최대 max개) + 그 밖의 관련 기출. 채점 가능한 문항만. */
  function conceptItems(card, bank, max) {
    max = max || 3;
    const main = card.items.filter(id => scorable(bank.byId[id]));
    const also = (card.also || []).filter(id => scorable(bank.byId[id]) && !main.includes(id));
    const easy = id => CALC.test(bank.byId[id].stem || '') ? 1 : 0;
    const ordered = main.slice().sort((a, b) => easy(a) - easy(b) || (a < b ? -1 : 1));
    return { check: ordered.slice(0, max), related: ordered.slice(max).concat(also), bankCount: main.length };
  }
  /** 카드별: 카드 학습 시점, 그 개념(대표) 문항의 '카드 보기 전 첫 제출' / '카드 본 뒤 첫 제출' 정답 수 */
  function conceptStats(cards, bank, events) {
    const evs = Array.isArray(events) ? events.slice().sort(cmpEv) : sortedEvents(events);
    const studied = new Map();
    for (const e of evs) {
      if (e.kind !== 'session' || !e.data || e.data.mode !== 'concept' || !e.data.concept || e.data.part === 'related') continue; // 관련 기출 풀이는 카드 학습으로 세지 않음
      const s = studied.get(e.data.concept) || { at: e.at, count: 0, last: e.at };
      s.count++; s.last = e.at; studied.set(e.data.concept, s);
    }
    const hist = itemHistories(evs, bank);
    const out = new Map();
    for (const c of cards) {
      const st = studied.get(c.id) || null; const T = st && st.at;
      const r = { id: c.id, studied: !!st, studiedAt: T, studyCount: st ? st.count : 0, inBank: 0, first: { n: 0, c: 0 }, before: { n: 0, c: 0 }, after: { n: 0, c: 0 } };
      for (const id of c.items) {
        if (!scorable(bank.byId[id])) continue;
        r.inBank++;
        const list = hist.get(id); if (!list) continue;
        r.first.n++; if (isCorrect(list[0], bank)) r.first.c++;
        const b = T ? list.find(e => e.at < T) : null;
        const a = T ? list.find(e => e.at >= T) : null;
        if (b) { r.before.n++; if (isCorrect(b, bank)) r.before.c++; }
        if (a) { r.after.n++; if (isCorrect(a, bank)) r.after.c++; }
      }
      out.set(c.id, r);
    }
    const sum = k => [...out.values()].filter(r => r.studied).reduce((a, r) => ({ n: a.n + r[k].n, c: a.c + r[k].c }), { n: 0, c: 0 });
    return { byCard: out, studiedCount: [...out.values()].filter(r => r.studied).length, total: cards.length, before: sum('before'), after: sum('after') };
  }
  /** 오늘 볼 카드 묶음: 아직 안 본 카드가 있는 첫 날 */
  function conceptToday(plan, cstats) {
    for (const d of plan) { const left = d.ids.filter(id => !(cstats.byCard.get(id) || {}).studied); if (left.length) return { day: d.day, ids: d.ids, left }; }
    return null;
  }

  // ---------- 기기 저장소 (계정별 분리) ----------
  /* storage: localStorage 와 같은 getItem/setItem/removeItem 객체 */
  class LocalStore {
    constructor(storage, userId) { this.storage = storage; this.userId = userId; this.key = 'kgs1:u:' + userId; this.state = this._read(); }
    _empty() { return { v: 1, user: this.userId, events: {}, outbox: [], failed: {}, acked: {}, cursor: null, lastOk: null, lastError: null, keys: {} }; }
    _read() {
      const raw = this.storage.getItem(this.key);
      if (!raw) return this._empty();
      let s; try { s = JSON.parse(raw); } catch (e) { const err = new Error('기기에 보관된 기록을 읽지 못했습니다'); err.code = 'CORRUPT'; err.raw = raw; throw err; }
      if (s.user !== this.userId) { const err = new Error('다른 계정의 기록입니다'); err.code = 'WRONG_USER'; throw err; }
      return Object.assign(this._empty(), s);
    }
    /** 다른 탭이 쓴 내용과 합쳐서 저장(기록을 잃지 않게). 실패하면 예외 */
    save() {
      let disk = null; try { disk = this._read(); } catch (e) { if (e.code !== 'CORRUPT') throw e; }
      if (disk) {
        for (const id in disk.events) if (!this.state.events[id]) this.state.events[id] = disk.events[id];
        for (const id of disk.outbox) if (!this.state.outbox.includes(id) && !this.state.acked[id]) this.state.outbox.push(id);
        Object.assign(this.state.acked, disk.acked);
        this.state.outbox = this.state.outbox.filter(id => !this.state.acked[id]);
        if (disk.cursor && (!this.state.cursor || disk.cursor > this.state.cursor)) this.state.cursor = disk.cursor;
        for (const k in disk.keys) if (!this.state.keys[k] || (disk.keys[k].updated_at || '') > (this.state.keys[k].updated_at || '')) this.state.keys[k] = disk.keys[k];
      }
      this.storage.setItem(this.key, JSON.stringify(this.state));
    }
    reload() { const fresh = this._read(); this.state = fresh; }
    /** 새 이벤트를 기기에 먼저 저장하고 전송 대기열에 넣는다. 같은 id면 아무것도 하지 않는다(중복 제출 방지). */
    add(ev) {
      if (this.state.events[ev.id]) return false;
      this.state.events[ev.id] = ev;
      this.state.outbox.push(ev.id);
      try { this.save(); } catch (e) { delete this.state.events[ev.id]; this.state.outbox = this.state.outbox.filter(x => x !== ev.id); throw e; }
      return true;
    }
    status(id) { if (this.state.acked[id]) return 'saved'; if (this.state.failed[id]) return 'failed'; if (this.state.outbox.includes(id)) return 'pending'; return this.state.events[id] ? 'saved' : 'none'; }
    wipe() { this.storage.removeItem(this.key); this.state = this._empty(); }
  }

  function makeEvent(kind, data, device, nowIso) {
    if (!KINDS.includes(kind)) throw new Error('unknown kind ' + kind);
    return { id: uuid(), kind, item: data.item || null, data, at: nowIso || new Date().toISOString(), device };
  }

  // ---------- 서버 동기화 ----------
  /* api: { insertEvents(rows) -> Promise, fetchEvents(sinceIso, from, to) -> Promise<rows>, fetchKeys() -> Promise<rows> }
   * rows: { id, kind, item_id, data, client_at, device_id, created_at } */
  const OVERLAP_MS = 5 * 60 * 1000; // 커밋 순서 차이로 늦게 보이는 행을 놓치지 않도록 5분 겹쳐 읽고 id로 중복 제거
  class SyncEngine {
    constructor({ store, api, onChange, now }) { this.store = store; this.api = api; this.onChange = onChange || (() => {}); this.now = now || (() => new Date().toISOString()); this.busy = null; this.stopped = false; this.phase = 'idle'; }
    toRow(ev) { return { id: ev.id, kind: ev.kind, item_id: ev.item || null, data: ev.data, client_at: ev.at, device_id: ev.device }; }
    fromRow(r) { return { id: r.id, kind: r.kind, item: r.item_id, data: r.data, at: new Date(r.client_at).toISOString(), device: r.device_id, serverAt: r.created_at }; }
    async push() {
      const st = this.store.state;
      const ids = st.outbox.slice(0, 200);
      if (!ids.length) return { sent: 0 };
      const rows = ids.map(id => this.toRow(st.events[id])).filter(Boolean);
      try {
        await this.api.insertEvents(rows);
      } catch (e) {
        if (this.stopped) return { sent: 0 };
        if (!(e && e.offline)) ids.forEach(id => { st.failed[id] = (st.failed[id] || 0) + 1; }); // 오프라인은 '실패'가 아니라 '대기'
        st.lastError = { at: this.now(), message: String(e && e.message || e), offline: !!(e && e.offline) };
        this.store.save(); this.onChange();
        throw e;
      }
      if (this.stopped) return { sent: 0 };
      ids.forEach(id => { st.acked[id] = this.now(); delete st.failed[id]; });
      st.outbox = st.outbox.filter(id => !st.acked[id]);
      st.lastOk = this.now(); st.lastError = null;
      this.store.save(); this.onChange();
      if (st.outbox.length) return this.push();
      return { sent: ids.length };
    }
    async pull() {
      const st = this.store.state;
      const since = st.cursor ? new Date(new Date(st.cursor).getTime() - OVERLAP_MS).toISOString() : null;
      let from = 0, added = 0, maxCursor = st.cursor; const page = 1000;
      for (;;) {
        const rows = await this.api.fetchEvents(since, from, from + page - 1);
        if (this.stopped) return { added: 0 };
        for (const r of rows) {
          if (!st.events[r.id]) { st.events[r.id] = this.fromRow(r); added++; }
          st.acked[r.id] = st.acked[r.id] || r.created_at; // 서버에 있음 = 저장 완료
          if (!maxCursor || r.created_at > maxCursor) maxCursor = r.created_at;
        }
        if (rows.length < page) break;
        from += page;
      }
      st.outbox = st.outbox.filter(id => !st.acked[id]);
      st.cursor = maxCursor;
      if (this.api.fetchKeys) {
        const keys = await this.api.fetchKeys();
        if (this.stopped) return { added };
        const map = {}; for (const k of keys) map[k.item_id] = { answer: k.answer, status: k.status, note: k.note, updated_at: k.updated_at };
        st.keys = map;
      }
      st.lastPull = this.now();
      this.store.save(); this.onChange();
      return { added };
    }
    /** 보내기 → 받기. 동시에 두 번 돌지 않게 한다. */
    syncNow() {
      if (this.busy) return this.busy;
      this.phase = 'syncing'; this.onChange();
      this.busy = (async () => {
        try {
          // 보내는 동안 새 제출이 생기면 한 번 더 보낸다
          for (let round = 0; round < 3; round++) { await this.push(); await this.pull(); if (!this.store.state.outbox.length || this.stopped) break; }
          this.phase = 'idle';
        }
        catch (e) { this.phase = 'error'; throw e; }
        finally { this.busy = null; this.onChange(); }
      })();
      return this.busy;
    }
    stop() { this.stopped = true; }
    summary(online) {
      const st = this.store.state; const n = st.outbox.length;
      const failed = st.outbox.filter(id => st.failed[id]).length;
      if (this.phase === 'syncing') return { tone: 'busy', text: n ? `서버로 보내는 중 · ${n}건` : '서버와 맞추는 중' };
      if (!n) return { tone: 'ok', text: st.lastOk || st.lastPull ? '서버 저장 완료' : '서버 확인 전' };
      if (online === false) return { tone: 'wait', text: `오프라인 · 이 기기에 저장됨 ${n}건 (연결되면 자동 전송)` };
      if (failed) return { tone: 'bad', text: `저장 실패 · 재시도 대기 ${n}건` };
      return { tone: 'wait', text: `이 기기에 저장됨 · 전송 대기 ${n}건` };
    }
  }

  return { conceptCards, allConceptCards, conceptPlan, conceptsOfItem, conceptItems, conceptStats, conceptToday,
    SUBJECTS, PASS, kstDate, addDays, uuid, effectiveBank, scorable, computeStats, recommend, quickSet, sessionsOf, resumeIndex, activeSession, currentStage, itemHistories, isCorrect, reviewState, LocalStore, SyncEngine, makeEvent, sortedEvents, cmpEv };
});
