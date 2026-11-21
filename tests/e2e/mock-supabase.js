/* 브라우저 테스트용 가짜 supabase-js. 실제 SDK와 같은 모양의 일부 기능만 흉내 내고,
 * 데이터는 Node 모의 서버(/mock/*)에 보낸다. 모의 서버가 '자기 기록만' 규칙을 적용한다. */
(function () {
  async function call(path, body) {
    if (window.__offline) throw new TypeError('Failed to fetch');
    const r = await fetch('/mock/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return r.json();
  }
  function createClient(url, key, opts) {
    const skey = (opts && opts.auth && opts.auth.storageKey) || 'sb';
    const persist = !(opts && opts.auth && opts.auth.persistSession === false);
    let session = persist ? JSON.parse(localStorage.getItem(skey) || 'null') : null;
    const subs = [];
    const emit = (ev) => subs.forEach(f => f(ev, session));
    const auth = {
      async getSession() { return { data: { session } }; },
      onAuthStateChange(f) { subs.push(f); setTimeout(() => f('INITIAL_SESSION', session), 0); return { data: { subscription: { unsubscribe() {} } } }; },
      async signInWithPassword({ email, password }) {
        const r = await call('login', { email, password }); if (r.error) return { data: {}, error: r.error };
        session = { access_token: r.token, user: r.user }; if (persist) localStorage.setItem(skey, JSON.stringify(session)); emit('SIGNED_IN'); return { data: { user: r.user, session }, error: null };
      },
      async signUp({ email, password }) { const r = await call('signup', { email, password }); return { data: {}, error: r.error || null }; },
      async signOut() { session = null; if (persist) localStorage.removeItem(skey); emit('SIGNED_OUT'); return { error: null }; },
    };
    function builder(table) {
      const q = { table, op: 'select', filters: [], order: [], range: null, limit: null, rows: null, patch: null, opts: null, single: false, returning: false };
      const b = {
        select() { if (q.op !== 'select') q.returning = true; return b; },
        order(c, o) { q.order.push([c, !o || o.ascending !== false]); return b; },
        range(a, z) { q.range = [a, z]; return b; },
        limit(n) { q.limit = n; return b; },
        gte(c, v) { q.filters.push(['gte', c, v]); return b; },
        eq(c, v) { q.filters.push(['eq', c, v]); return b; },
        maybeSingle() { q.single = true; return b; },
        upsert(rows, o) { q.op = 'upsert'; q.rows = Array.isArray(rows) ? rows : [rows]; q.opts = o || {}; return b; },
        insert(rows) { q.op = 'insert'; q.rows = Array.isArray(rows) ? rows : [rows]; return b; },
        update(p) { q.op = 'update'; q.patch = p; return b; },
        delete() { q.op = 'delete'; return b; },
        then(res, rej) {
          return call('query', { token: session && session.access_token, q }).then(r => {
            if (r.error) return { data: null, error: r.error };
            let data = r.data; if (q.single) data = data && data.length ? data[0] : null;
            return { data, error: null };
          }, e => ({ data: null, error: { message: e.message } })).then(res, rej);
        },
      };
      return b;
    }
    const storage = { from(bucket) { return { async download(name) {
      try { const r = await call('download', { token: session && session.access_token, bucket, name }); if (r.error) return { data: null, error: r.error }; return { data: new Blob([r.text]), error: null }; }
      catch (e) { return { data: null, error: { message: e.message } }; }
    } }; } };
    return { auth, from: builder, storage };
  }
  window.supabase = { createClient };
})();
