'use strict';
// Connects the web app to Supabase (hosted mode): Supabase Auth for sign-in, and the "api"
// Edge Function for everything else. Loaded only by the GitHub Pages build (web/).
(function () {
  const C = window.MJM_CONFIG;
  if (!C || C.mode !== 'supabase' || !window.supabase) return;
  const sb = window.supabase.createClient(C.supabaseUrl, C.publishableKey, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'mjm-stock-audit-auth' } });
  const FN = `${C.supabaseUrl}/functions/v1/api`;
  const emailFor = (u) => `${String(u || '').trim().toLowerCase()}@${C.loginDomain}`;

  async function token() { const { data } = await sb.auth.getSession(); return data.session ? data.session.access_token : null; }
  function filenameOf(res) { const m = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || ''); return m ? m[1] : 'download'; }

  async function call(method, url, body, raw) {
    const t = await token();
    let res;
    try {
      res = await fetch(FN + url.replace(/^\/api/, ''), {
        method,
        headers: { 'content-type': 'application/json', apikey: C.publishableKey, ...(t ? { authorization: `Bearer ${t}` } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error('Cannot reach the server. Check the internet connection and try again.');
    }
    if (!res.ok) {
      let msg = `Request failed (${res.status})`;
      try { msg = (await res.json()).error || msg; } catch { /* not JSON */ }
      if (res.status === 503 || res.status === 546) msg = 'The server is starting up or the database is paused. Wait a minute and try again.';
      const e = new Error(msg); e.status = res.status; throw e;
    }
    if (raw) return { blob: await res.blob(), filename: filenameOf(res) };
    const ct = res.headers.get('content-type') || '';
    return ct.includes('json') ? res.json() : res.text();
  }

  window.MJM_BACKEND = {
    mode: 'supabase',
    api: (m, u, b) => call(m, u, b),
    raw: (m, u, b) => call(m, u, b, true),
    async login(username, password) {
      const { error } = await sb.auth.signInWithPassword({ email: emailFor(username), password });
      if (error) { const e = new Error(/rate|too many/i.test(error.message) ? 'Too many sign-in attempts. Wait a few minutes and try again.' : 'Username or password is incorrect.'); e.status = 401; throw e; }
      const me = await call('GET', '/api/me');
      if (!me.user) { await sb.auth.signOut(); throw new Error('This account is not active. Ask an Admin.'); }
      return me;
    },
    async logout() { await sb.auth.signOut(); },
    setupStatus: () => call('GET', '/api/setup-status'),
    async setup(form) {
      const tables = await (await fetch('./data/tables.json', { cache: 'no-store' })).json();
      await call('POST', '/api/setup', { ...form, tables });
      return this.login(form.username, form.password);
    },
  };
})();
