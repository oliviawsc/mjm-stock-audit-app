'use strict';
/* MJM Mill Stock Take & Audit System: browser client. All calculation is done on the server. */
(() => {
  const S = { user: null, meta: null, draft: null, step: 1, unit: null, focus: null, dirty: false, results: null, computeTimer: null, computeSeq: 0, dtRaw: {}, hist: { q: '', status: '', product: '', from: '', to: '', demo: '0' }, rowsPage: {} };
  const app = document.getElementById('app');

  // ---------- utilities ----------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
  const n2 = (x) => (isNum(x) ? x.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '–');
  const n0 = (x) => (isNum(x) ? Math.round(x).toLocaleString('en-MY') : '–');
  const signed = (x) => (isNum(x) ? (x > 0 ? '+' : x < 0 ? '−' : '') + n2(Math.abs(x)) : '–');
  const pct = (x) => (isNum(x) ? `${x > 0 ? '+' : x < 0 ? '−' : ''}${n2(Math.abs(x))}%` : 'N/A');
  const fmtDate = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : '');
  const fmtDT = (s) => (s ? (s.length >= 16 ? `${fmtDate(s)} ${s.slice(11, 16)}` : fmtDate(s)) : '');
  const role = () => (S.user ? S.user.role : null);
  const canEdit = () => role() === 'auditor' || role() === 'admin';
  const isAdmin = () => role() === 'admin';
  const P = () => S.meta.products;
  const unitName = (c) => (S.meta.units.find((u) => u.code === c) || {}).name || c;
  const unitsOf = (p) => S.meta.units.filter((u) => u.product === p);
  const STATUS_LABEL = { measured: 'Measured', empty: 'Confirmed empty', excluded: 'Excluded' };
  const AUDIT_STATUS = { draft: ['Draft', 'warn'], final: ['Final', 'good'], superseded: ['Superseded', 'neutral'] };
  // Calibration table status from the import checks. "verified"/"pending_verification" appear only in audits saved by the earlier system.
  const statusPill = (s) => (s === 'needs_attention' ? '<span class="pill warn">Import needs attention</span>' : s === 'ready' ? '<span class="pill good">Ready to use</span>' : s === 'verified' ? '<span class="pill neutral">Verified (earlier system)</span>' : `<span class="pill neutral">${esc(s === 'pending_verification' ? 'Recorded before import checks' : s || '')}</span>`);

  function parseDate(t) {
    const m = String(t || '').trim().match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/);
    if (!m) return null;
    const d = +m[1], mo = +m[2], y = +m[3];
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  function parseTime(t) {
    const s = String(t || '').trim();
    const m = s.match(/^(\d{1,2})[:.]?(\d{2})$/);
    if (!m) return null;
    const h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return null;
    return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
  }
  function getPath(o, path) { return path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o); }
  function setPath(o, path, val) {
    const ks = path.split('.'); let cur = o;
    for (let i = 0; i < ks.length - 1; i++) { const k = ks[i]; if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = /^\d+$/.test(ks[i + 1]) ? [] : {}; cur = cur[k]; }
    cur[ks[ks.length - 1]] = val;
  }

  // Hosted (GitHub Pages + Supabase) mode supplies window.MJM_BACKEND; otherwise talk to this server.
  const B = window.MJM_BACKEND || null;
  async function api(method, url, body) {
    if (B) {
      try { return await B.api(method, url, body); } catch (e) {
        if (e.status === 401 && url !== '/api/me') { S.user = null; renderLogin('Your session has ended. Please sign in again.'); throw new Error('signed out'); }
        throw e;
      }
    }
    const res = await fetch(url, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    if (res.status === 401 && url !== '/api/login' && url !== '/api/me') { S.user = null; renderLogin('Your session has ended. Please sign in again.'); throw new Error('signed out'); }
    if (!res.ok) { const e = new Error((data && data.error) || `Request failed (${res.status})`); e.status = res.status; throw e; }
    return data;
  }
  function saveBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
  // Download a file produced by the API (CSV, backup) with the signed-in session.
  async function downloadApi(url) {
    try {
      if (B) { const r = await B.raw('GET', url); return saveBlob(r.blob, r.filename); }
      const res = await fetch(url);
      if (!res.ok) { let m = `Download failed (${res.status})`; try { m = (await res.json()).error || m; } catch { /* binary */ } throw new Error(m); }
      const fn = (/filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '') || [])[1] || 'download';
      saveBlob(await res.blob(), fn);
    } catch (e) { fail(e); }
  }
  // Open a new tab straight away (so pop-up blockers allow it), then point it at the file.
  function pendingTab() { const w = window.open('', '_blank'); if (w) w.document.write('<p style="font:16px system-ui;padding:24px">Preparing the document…</p>'); return w; }
  async function openSource(file) {
    const w = pendingTab();
    try { const { url } = await api('GET', `/api/source-url/${encodeURIComponent(file)}`); if (w) w.location = url; else location.href = url; } catch (e) { if (w) w.close(); fail(e); }
  }
  async function pdfReport(a, download) {
    if (!B) { if (download) location.href = `/api/audits/${a.id}/report.pdf?download=1`; else window.open(`/api/audits/${a.id}/report.pdf`, '_blank', 'noopener'); return; }
    const w = download ? null : pendingTab();
    try {
      if (!window.PDFDocument) throw new Error('The PDF tool did not load. Check the internet connection and reload the page.');
      const report = window.MJM.load('server/report');
      const blob = await new Promise((resolve, reject) => {
        const chunks = [];
        try { report.pdf(a, (doc) => { doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(new Blob(chunks, { type: 'application/pdf' }))); }, window.PDFDocument); } catch (e) { reject(e); }
      });
      const name = `${report.fileBase(a)}.pdf`;
      if (download) saveBlob(blob, name);
      else { const u = URL.createObjectURL(blob); if (w) w.location = u; else window.open(u, '_blank'); }
    } catch (e) { if (w) w.close(); fail(e); }
  }
  let toastTimer;
  function toast(msg, err) { const t = $('#toast'); t.textContent = msg; t.className = `toast${err ? ' err' : ''}`; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), err ? 7000 : 3200); }
  function fail(e) { if (e && e.message !== 'signed out') { if (String(e.message).includes('\n')) modal({ title: 'Please check', body: `<p style="white-space:pre-line">${esc(e.message)}</p>`, actions: [{ label: 'OK', value: 'ok', primary: true }] }); else toast(e.message, true); } }

  function modal({ title, body, actions }) {
    return new Promise((resolve) => {
      const m = $('#modal'), box = $('.modal-box', m);
      box.innerHTML = `<h2 id="modalTitle">${esc(title)}</h2><div class="stack">${body || ''}</div><div class="row end">${actions.map((a, i) => `<button type="button" data-i="${i}" class="${a.primary ? 'btn-primary' : ''} ${a.danger ? 'btn-danger' : ''}">${esc(a.label)}</button>`).join('')}</div>`;
      m.hidden = false;
      const first = box.querySelector('input, textarea, select') || box.querySelector('button.btn-primary') || box.querySelector('button');
      first && first.focus();
      const close = (val) => {
        const form = {}; $$('[name]', box).forEach((el) => (form[el.name] = el.type === 'checkbox' ? el.checked : el.value));
        m.hidden = true; box.innerHTML = ''; document.removeEventListener('keydown', onKey); resolve({ action: val, form });
      };
      const onKey = (e) => { if (e.key === 'Escape') close('cancel'); };
      document.addEventListener('keydown', onKey);
      box.querySelectorAll('button[data-i]').forEach((b) => b.addEventListener('click', () => close(actions[+b.dataset.i].value)));
    });
  }

  // ---------- auth ----------
  function showChrome(on) { $('#topbar').hidden = !on; document.body.classList.toggle('signed-in', on); }
  function renderLogin(msg) {
    showChrome(false);
    app.innerHTML = `<form class="panel login" id="loginForm">
      <div><h1>MJM Mill Stock Take &amp; Audit System</h1><p class="muted">MJM (Palm Oil Mill) Sdn Bhd</p></div>
      ${msg ? `<div class="notice info">${esc(msg)}</div>` : ''}
      <label class="field"><span>Username</span><input type="text" id="lu" autocomplete="username" required></label>
      <label class="field"><span>Password</span><input type="password" id="lp" autocomplete="current-password" required></label>
      <button class="btn-primary" type="submit">Sign in</button>
    </form>`;
    $('#loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('#loginForm button'); btn.disabled = true;
      try { const r = B ? await B.login($('#lu').value, $('#lp').value) : await api('POST', '/api/login', { username: $('#lu').value, password: $('#lp').value }); S.user = r.user; await boot(); } catch (err) { fail(err); } finally { btn.disabled = false; }
    });
    $('#lu').focus();
  }
  function renderSetup() {
    showChrome(false);
    app.innerHTML = `<form class="panel login" id="setupForm">
      <div><h1>Set up the MJM Mill Stock Take &amp; Audit System</h1><p class="muted">This is a new installation. Create the first Admin account. You will add other staff afterwards under Users.</p></div>
      <label class="field"><span>Your full name</span><input type="text" name="displayName" required></label>
      <label class="field"><span>Username <span class="hint">3 to 32 letters, numbers, dots, dashes or underscores</span></span><input type="text" name="username" autocomplete="username" required></label>
      <label class="field"><span>Password <span class="hint">At least 8 characters</span></span><input type="password" name="password" autocomplete="new-password" required></label>
      <label class="field"><span>Repeat password</span><input type="password" name="password2" autocomplete="new-password" required></label>
      <p class="small muted">Setup also loads the six calibration tables (figures exactly as printed in the PDFs), the initial settings and the June 2026 demonstration audit.</p>
      <button class="btn-primary" type="submit">Create Admin and sign in</button>
    </form>`;
    $('#setupForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      if (f.password !== f.password2) return toast('The two passwords are different.', true);
      const btn = $('#setupForm button'); btn.disabled = true; btn.textContent = 'Setting up…';
      try { const r = await B.setup({ username: f.username, displayName: f.displayName, password: f.password }); S.user = r.user; await boot(); } catch (err) { fail(err); btn.disabled = false; btn.textContent = 'Create Admin and sign in'; }
    });
  }
  async function boot() {
    S.meta = await api('GET', '/api/meta');
    showChrome(true);
    $$('[data-role="editor"]').forEach((a) => (a.hidden = !canEdit()));
    const roleName = S.user.role[0].toUpperCase() + S.user.role.slice(1);
    const initials = String(S.user.displayName || S.user.username || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
    $('#accountBtn').innerHTML = `<span class="avatar" aria-hidden="true">${esc(initials)}</span><span class="who"><b>${esc(S.user.displayName)}</b><small>${esc(roleName)}</small></span>`;
    $('#accountBtn').setAttribute('aria-label', `Account menu for ${S.user.displayName}`);
    $('#accountMenu').innerHTML = `<a href="#/account">Your account</a>${isAdmin() ? '<a href="#/users">Users</a><a href="#/backup">Backup</a>' : ''}<hr><button type="button" id="logoutBtn">Sign out</button>`;
    $('#logoutBtn').onclick = async () => { $('#account').open = false; if (S.dirty && !confirm('You have unsaved changes. Sign out anyway?')) return; if (B) await B.logout(); else await api('POST', '/api/logout'); S.user = null; S.dirty = false; renderLogin(); };
    route();
  }

  // ---------- routing ----------
  let lastHash = location.hash;
  window.addEventListener('hashchange', () => {
    if (S.skipRoute) { S.skipRoute = false; lastHash = location.hash; return; }
    if (S.dirty && !location.hash.includes('/edit') && !confirm('You have unsaved changes in this stock take. Leave without saving?')) { S.skipRoute = true; location.hash = lastHash; return; }
    if (!location.hash.includes('/edit') && location.hash !== '#/new') S.dirty = false;
    lastHash = location.hash; route();
  });
  window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });
  // Close the account menu when clicking elsewhere.
  document.addEventListener('click', (e) => { const acc = $('#account'); if (acc && acc.open && !acc.contains(e.target)) acc.open = false; });

  function setNav(key) { $$('#nav a[data-nav]').forEach((a) => { const on = a.dataset.nav === key; a.classList.toggle('active', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }); const acc = $('#account'); if (acc) acc.open = false; }
  // Start page: New Stock Take for users who can create audits, Audit History for view-only users.
  const landing = () => (canEdit() ? '#/new' : '#/history');
  async function route() {
    if (!S.user) return renderLogin();
    const parts = (location.hash.slice(2) || '').split('/').filter(Boolean);
    window.scrollTo(0, 0);
    try {
      if (!parts.length || parts[0] === 'dashboard') { history.replaceState(null, '', landing()); lastHash = location.hash; return route(); }
      if (parts[0] === 'new') { setNav('new'); return startNew(); }
      if (parts[0] === 'history') { setNav('history'); return await renderHistory(); }
      if (parts[0] === 'audit' && parts[2] === 'edit') { setNav('new'); return await openWizard(Number(parts[1]), Number(parts[3] || 1), parts[4]); }
      if (parts[0] === 'audit') { setNav('history'); return await renderAuditView(Number(parts[1])); }
      if (parts[0] === 'settings') { setNav('settings'); return await renderSettings(parts.slice(1)); }
      if (parts[0] === 'users') { setNav(''); return await renderUsers(); }
      if (parts[0] === 'backup') { setNav(''); return renderBackup(); }
      if (parts[0] === 'account') { setNav(''); return renderAccount(); }
      app.innerHTML = '<div class="panel"><h1>Page not found</h1><p><a href="#/">Go to the start page</a></p></div>';
    } catch (e) { if (e.message !== 'signed out') app.innerHTML = `<div class="notice bad"><strong>Could not load this page.</strong><span>${esc(e.message)}</span></div>`; }
  }

  // ---------- shared result renderers ----------
  function limitPill(ls) {
    if (!ls) return '';
    const cls = { within: 'good', below: 'bad', above: 'bad', not_set: 'neutral', na: 'neutral' }[ls.code] || 'neutral';
    return `<span class="pill ${cls}">${esc(ls.label)}</span>`;
  }
  function productResultsHtml(r, opts = {}) {
    if (!r || !Object.keys(r.products).length) return '<p class="muted">Choose products and enter measurements to see results.</p>';
    return Object.values(r.products).map((pr) => {
      const u = pr.unit, c = pr.comparison;
      const rows = pr.units.map((code) => {
        const x = r.units[code];
        return `<tr><td>${esc(x.name)}</td><td>${x.status ? `<span class="pill ${x.status === 'excluded' ? 'warn' : 'info'}">${STATUS_LABEL[x.status]}</span>` : '<span class="pill bad">Not set</span>'}${x.excludeReason ? `<div class="small muted">${esc(x.excludeReason)}</div>` : ''}</td>
          <td>${esc(fmtDT(x.measuredAt))}</td><td class="n">${x.status === 'excluded' ? '' : n2(x.quantity)}</td><td class="n">${x.status === 'excluded' ? '' : signed(x.adjustment)}</td><td class="n"><b>${x.status === 'excluded' ? '' : n2(x.adjustedQuantity)}</b></td>
          <td class="n">${x.book !== undefined ? n2(x.book) : ''}</td><td class="n">${x.variance !== undefined ? `${signed(x.variance)}<div class="small muted">${pct(x.variancePct)}</div>` : ''}</td></tr>`;
      }).join('');
      return `<div class="panel product-block">
        <div class="panel-head"><span class="product-tag ${pr.code}">${esc(P()[pr.code].short)}</span><h3>${esc(pr.name)}</h3>${pr.partial ? '<span class="pill warn">Partial: units excluded</span>' : ''}${pr.hasEstimates ? '<span class="pill warn">Includes estimates</span>' : ''}<span class="spacer"></span>${limitPill(pr.limitStatus)}</div>
        <div class="table-wrap"><table><thead><tr><th>Storage unit</th><th>Status</th><th>Measured at</th><th class="n">Measured (${u})</th><th class="n">Movements (${u})</th><th class="n">At cut-off (${u})</th><th class="n">Unit book (${u})</th><th class="n">Unit variance</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td colspan="3">${esc(P()[pr.code].short)} total${pr.partial ? ' (included units only)' : ''}</td><td class="n">${n2(pr.measuredTotal)}</td><td class="n">${signed(pr.adjustmentTotal)}</td><td class="n">${n2(pr.adjustedTotal)}</td><td colspan="2"></td></tr></tfoot></table></div>
        <dl class="kv">
          <dt>Physical stock at cut-off</dt><dd><b>${n2(pr.adjustedTotal)} ${u}</b></dd>
          <dt>Book stock</dt><dd>${c.basis ? `${n2(c.book)} ${u}${c.basis === 'matching_units' ? ' <span class="small muted">(per-unit balances of included units)</span>' : ''}` : (isNum(pr.book.total) ? `${n2(pr.book.total)} ${u}` : '–')}</dd>
          <dt>Variance</dt><dd>${c.variance !== null && c.variance !== undefined ? `<b>${signed(c.variance)} ${u}</b> (${c.direction === 'surplus' ? 'surplus' : c.direction === 'shortage' ? 'shortage' : 'nil'})` : '–'}</dd>
          <dt>Variance %</dt><dd>${c.variance !== null && c.variance !== undefined ? `<b>${pct(c.variancePct)}</b>` : '–'}</dd>
        </dl>
        ${c.message ? `<div class="notice ${c.variance === null ? 'warn' : 'info'}">${esc(c.message)}</div>` : ''}
        ${opts.compact ? '' : pr.issues.filter((i) => i.level !== 'info').map((i) => `<div class="notice warn">${esc(i.text)}</div>`).join('')}
      </div>`;
    }).join('');
  }
  function issuesHtml(r, { demo } = {}) {
    if (!r) return '';
    const blocks = r.allIssues.filter((i) => i.level === 'block');
    const warns = r.allIssues.filter((i) => i.level === 'warn');
    const gateNote = (i) => (demo && (i.gate === 'calibration' || i.gate === 'settings') ? ' <span class="pill neutral">not required for a demo</span>' : '');
    return `${blocks.length ? `<div class="notice bad"><strong>Must be resolved before finalising (${blocks.length})</strong><ul class="issues">${blocks.map((i) => `<li>${esc(i.text)}${gateNote(i)}</li>`).join('')}</ul></div>` : '<div class="notice good"><strong>No items block finalisation.</strong></div>'}
      ${warns.length ? `<div class="notice warn"><strong>Warnings and notes (${warns.length})</strong><ul class="issues">${warns.map((i) => `<li>${esc(i.text)}</li>`).join('')}</ul></div>` : ''}`;
  }
  function measurementDetailHtml(x, inputs) {
    const m = x.measurement;
    const t = x.table;
    let h = `<div class="unit-card p-${x.product}"><div class="panel-head"><span class="product-tag ${x.product}">${esc(P()[x.product].short)}</span><h3>${esc(x.name)}</h3><span class="pill ${x.status === 'excluded' ? 'warn' : 'info'}">${STATUS_LABEL[x.status] || 'Status not set'}</span></div>`;
    if (t) h += `<p class="small muted">Calibration table v${t.version} (${t.status === 'needs_attention' ? 'import needs attention' : t.status === 'ready' ? 'ready to use' : esc(t.status || '')}) · ${esc(t.reportReference)} · calibrated ${fmtDate(t.calibrationDate)} · ${t.basis} in ${t.measurementUnit}, volume in ${t.volumeUnit}</p>`;
    if (x.status === 'excluded') return h + `<p><b>Reason:</b> ${esc(x.excludeReason)}</p></div>`;
    if (x.measuredAt) h += `<p><b>${x.product === 'CPO' ? 'Dipping' : 'Measurement'} time:</b> ${fmtDT(x.measuredAt)}</p>`;
    if (x.status === 'empty') h += '<p>Confirmed empty. Quantity 0.</p>';
    if (m && x.product === 'CPO') {
      const ru = m.readings[0] ? m.readings[0].unit : '';
      h += `<div class="table-wrap"><table><thead><tr><th>#</th><th class="n">Reference mark (${esc(ru)})</th><th class="n">Wetted part (${esc(ru)})</th><th class="n">Ullage (${esc(ru)})</th><th class="n">Ullage (mm)</th><th class="n">Observed volume (L)</th><th class="n">Quantity (MT)</th></tr></thead><tbody>
        ${m.readings.map((rd) => `<tr><td>${rd.n}</td><td class="n">${esc(rd.ref)}</td><td class="n">${esc(rd.wet)}</td><td class="n">${n2(rd.ullage)}</td><td class="n">${n2(rd.ullageMm)}</td><td class="n">${n2(rd.volumeL)}</td><td class="n">${n2(rd.mt)}</td></tr>`).join('')}
        </tbody></table></div>
        <dl class="kv"><dt>Temperature</dt><dd>${esc(((inputs.units || {})[x.code] || {}).temperatureC)} °C</dd>
        <dt>Conversion</dt><dd>${m.conversion ? esc(m.conversion.describe) : '<span class="pill bad">Not available</span>'}</dd>
        <dt>Adopted result rule</dt><dd>${esc(m.adoptedRule.label)} ${m.adoptedRule.status !== 'confirmed' ? '<span class="pill warn">Provisional</span>' : ''}</dd>
        <dt>Spread of ullages</dt><dd>${m.spreadMm !== undefined ? `${n2(m.spreadMm)} mm` : '–'}</dd>
        <dt>Adopted volume</dt><dd>${n2(m.volumeL)} L</dd><dt>Adopted quantity</dt><dd><b>${n2(m.mt)} MT</b></dd></dl>`;
    }
    if (m && x.product === 'PK') {
      const pu = m.points[0] ? m.points[0].unit : '';
      h += `<div class="table-wrap"><table><thead><tr><th>#</th><th>Location</th><th class="n">Ullage (${esc(pu)})</th><th class="n">Ullage (mm)</th><th class="n">Volume at point (L)</th></tr></thead><tbody>
        ${m.points.map((pt) => `<tr><td>${pt.n}</td><td>${esc(pt.label)}</td><td class="n">${esc(pt.ullage)}</td><td class="n">${n2(pt.ullageMm)}</td><td class="n">${n2(pt.volumeL)}</td></tr>`).join('')}</tbody></table></div>
        <dl class="kv"><dt>Adopted method</dt><dd>${esc(m.adoptedMethod.label)} ${m.adoptedMethod.approvedStatus !== 'confirmed' ? '<span class="pill warn">Awaiting confirmation</span>' : ''}</dd>
        ${m.adoptedNote ? `<dt>Method note</dt><dd>${esc(m.adoptedNote)}</dd>` : ''}
        <dt>Adopted ullage</dt><dd>${n2(m.adoptedUllageMm)} mm</dd><dt>Volume</dt><dd>${n2(m.volumeL)} L</dd>
        <dt>Bulk density</dt><dd>${m.density ? `${esc(m.density.value)} kg/L ${m.density.status !== 'confirmed' ? '<span class="pill warn">Awaiting confirmation</span>' : ''}` : esc(m.densityNote || '–')}</dd>
        <dt>Quantity</dt><dd><b>${n2(m.mt)} MT</b> <span class="small muted">(litres × density ÷ 1,000; no temperature correction)</span></dd></dl>`;
    }
    if (m && x.product === 'DSL') {
      h += `<dl class="kv"><dt>Dip</dt><dd>${esc(m.dip)} ${esc(m.dipUnit || '')} (${n2(m.dipMm)} mm)</dd><dt>Volume at dip</dt><dd>${n2(m.grossL)} L</dd><dt>Water bottom</dt><dd>${esc(m.waterNote || '')}</dd><dt>Net volume</dt><dd><b>${n2(m.netL)} L</b></dd></dl>`;
    }
    if (x.remarks) h += `<p><b>Remarks:</b> ${esc(x.remarks)}</p>`;
    return h + '</div>';
  }
  function movementsTableHtml(r) {
    if (!r.movements.length) return '<p class="muted">No movements recorded.</p>';
    return `<div class="table-wrap"><table><thead><tr><th>#</th><th>Unit</th><th>Type</th><th>Date/time</th><th class="n">Quantity</th><th>Basis</th><th>Ref.</th><th>Applied</th><th>Remarks</th></tr></thead><tbody>
      ${r.movements.map((m) => `<tr><td>${m.n}</td><td>${esc(unitName(m.unit))}${m.toUnit ? ` → ${esc(unitName(m.toUnit))}` : ''}</td><td>${esc(m.typeLabel)}</td><td>${fmtDT(m.at)}</td><td class="n">${n2(m.qty)} ${esc(m.qtyUnit || '')}</td>
        <td>${m.basis === 'estimated' ? `<span class="pill warn">Estimated</span>${m.estimateText ? `<div class="small">${esc(m.estimateText)}</div>` : ''}` : 'Actual'}</td><td>${esc(m.ref || '')}</td>
        <td class="small">${m.effects.map((e) => `${esc(unitName(e.unit))}: ${e.applied ? `<b>${signed(e.adjustment)}</b>` : 'not applied'} <span class="muted">(${esc(e.reason)})</span>`).join('<br>') || '<span class="muted">Not applied (incomplete)</span>'}</td>
        <td class="small">${esc(m.remarks || '')}${m.discrepancyNote ? `<div class="notice warn small">${esc(m.discrepancyNote)}</div>` : ''}</td></tr>`).join('')}
    </tbody></table></div>`;
  }

  function bindRowLinks() { $$('tr[data-href]').forEach((tr) => tr.addEventListener('click', () => (location.hash = tr.dataset.href))); }

  // ---------- history ----------
  async function renderHistory() {
    const h = S.hist;
    app.innerHTML = `<div class="page-head"><div><h1>Audit History</h1><p class="muted">Search and open past stock takes. Finalised results are frozen as recorded.</p></div>${canEdit() ? '<a class="btn btn-primary" href="#/new">New stock take</a>' : ''}</div>
      <form class="panel" id="histForm"><div class="grid">
        <label class="field"><span>Search</span><input type="search" id="hq" value="${esc(h.q)}" placeholder="Reference, auditor, remarks"></label>
        <label class="field"><span>Status</span><select id="hs"><option value="">Any</option><option value="draft">Draft</option><option value="final">Final</option><option value="superseded">Superseded</option></select></label>
      </div><details id="hmore" ${h.product || h.from || h.to || h.demo !== '0' || window.innerWidth > 760 ? 'open' : ''}><summary>More filters</summary><div class="grid" style="padding-top:8px">
        <label class="field"><span>Product</span><select id="hp"><option value="">Any</option>${Object.values(P()).map((p) => `<option value="${p.code}">${esc(p.short)}</option>`).join('')}</select></label>
        <label class="field"><span>Stock take date from <span class="hint">DD/MM/YYYY</span></span><input type="text" id="hf" value="${esc(h.from ? fmtDate(h.from) : '')}" inputmode="numeric" placeholder="01/06/2026"></label>
        <label class="field"><span>Stock take date to <span class="hint">DD/MM/YYYY</span></span><input type="text" id="ht" value="${esc(h.to ? fmtDate(h.to) : '')}" inputmode="numeric" placeholder="30/06/2026"></label>
        <label class="field"><span>Demonstrations</span><select id="hd"><option value="0">Hide demonstrations</option><option value="">Show all</option><option value="1">Only demonstrations</option></select></label>
      </div></details><div class="row end"><button type="button" class="btn-ghost" id="hclear">Clear</button><button class="btn-primary">Search</button></div></form>
      <div id="histResults"><p class="muted">Loading…</p></div>`;
    $('#hs').value = h.status; $('#hp').value = h.product; $('#hd').value = h.demo;
    const load = async () => {
      const from = $('#hf').value.trim(), to = $('#ht').value.trim();
      if (from && !parseDate(from)) return toast('Enter "from" as DD/MM/YYYY.', true);
      if (to && !parseDate(to)) return toast('Enter "to" as DD/MM/YYYY.', true);
      Object.assign(h, { q: $('#hq').value.trim(), status: $('#hs').value, product: $('#hp').value, from: from ? parseDate(from) : '', to: to ? parseDate(to) : '', demo: $('#hd').value });
      const qs = new URLSearchParams(Object.entries(h).filter(([, v]) => v !== '')).toString();
      const rows = await api('GET', `/api/audits?${qs}`);
      // Drafts: "Continue filling" (for users who can edit). Finalised and superseded: "View report".
      const action = (a) => (a.status === 'draft' && canEdit()
        ? `<a class="btn btn-primary btn-sm" href="#/audit/${a.id}/edit/1">Continue filling</a>`
        : `<a class="btn btn-sm" href="#/audit/${a.id}">View report</a>`);
      const tags = (a) => a.products.map((p) => `<span class="product-tag ${p}">${esc(P()[p].short)}</span>`).join(' ');
      const summary = (a) => Object.entries(a.summary).map(([p, s]) => `${esc(P()[p].short)}: ${n2(s.adjustedTotal)} ${s.unit}${s.variance !== null && s.variance !== undefined ? `, ${signed(s.variance)} (${pct(s.variancePct)})` : ''}${s.partial ? ' <span class="pill warn">Partial</span>' : ''}`).join('<br>');
      const ref = (a) => `<b>${esc(a.reference)}</b>${a.revision ? ` rev ${a.revision}` : ''} ${a.isDemo ? '<span class="pill info">Demo</span>' : ''}`;
      const st = (a) => `<span class="pill ${AUDIT_STATUS[a.status][1]}">${AUDIT_STATUS[a.status][0]}</span>`;
      $('#histResults').innerHTML = rows.length ? `<div class="table-wrap hist-table"><table><thead><tr><th>Reference</th><th>Status</th><th>Stock take date</th><th>Compared as at</th><th>Prepared by</th><th>Stock</th><th>Results (finalised)</th><th></th></tr></thead><tbody>
        ${rows.map((a) => `<tr class="clickable" data-href="#/audit/${a.id}"><td>${ref(a)}</td><td>${st(a)}</td><td>${fmtDate(a.auditDate)}</td><td>${fmtDT(a.cutoff)}</td><td>${esc(a.preparedBy || '')}</td><td>${tags(a)}</td>
          <td class="small">${summary(a) || '<span class="muted">–</span>'}</td><td>${action(a)}</td></tr>`).join('')}
        </tbody></table></div>
        <div class="hist-cards">${rows.map((a) => `<article class="hist-card"><div class="hc-top">${ref(a)} ${st(a)}</div>
          <div class="row small">${tags(a)}<span>Stock take ${fmtDate(a.auditDate) || '–'}</span><span class="muted">Compared as at ${fmtDT(a.cutoff) || '–'}</span></div>
          ${a.preparedBy ? `<div class="small muted">Prepared by ${esc(a.preparedBy)}</div>` : ''}
          ${summary(a) ? `<div class="small">${summary(a)}</div>` : ''}
          ${action(a)}</article>`).join('')}</div>
        <p class="small muted">${rows.length} audit(s)</p>` : '<div class="panel"><p class="muted">No audits match these filters.</p></div>';
      $$('#histResults tr[data-href] a').forEach((x) => x.addEventListener('click', (e) => e.stopPropagation()));
      bindRowLinks();
    };
    $('#histForm').addEventListener('submit', (e) => { e.preventDefault(); load().catch(fail); });
    $('#hclear').onclick = () => { S.hist = { q: '', status: '', product: '', from: '', to: '', demo: '0' }; renderHistory(); };
    await load();
  }

  // ---------- audit view ----------
  async function renderAuditView(id) {
    const a = await api('GET', `/api/audits/${id}`);
    const r = a.results, inp = a.inputs;
    const st = AUDIT_STATUS[a.status];
    const so = inp.signoff || {};
    app.innerHTML = `<div class="report stack">
      <div class="page-head"><div><p class="muted">${esc(S.meta.company)}</p><h1>${esc(a.reference)}${a.revision ? ` <span class="muted">rev ${a.revision}</span>` : ''}</h1></div>
        <div class="row no-print">
          ${a.status === 'draft' && canEdit() ? `<a class="btn btn-primary" href="#/audit/${a.id}/edit/1">Continue filling</a><a class="btn" href="#/audit/${a.id}/edit/3/finalise">Check &amp; finalise</a>` : ''}
          ${a.status === 'final' && canEdit() ? '<button id="reviseBtn">Correct (new revision)</button>' : ''}
          <button type="button" id="pdfBtn">PDF report</button>
          <button type="button" id="pdfDlBtn">Download PDF</button>
          <button id="printBtn">Print</button>
          <button type="button" id="csvBtn">Export CSV</button>
          ${a.status === 'draft' && canEdit() ? '<button class="btn-danger" id="delBtn">Delete draft</button>' : ''}
        </div></div>
      ${a.isDemo ? '<div class="watermark">DEMONSTRATION · NOT AN ACTUAL AUDIT</div>' : ''}
      <div class="row"><span class="pill ${st[1]}">${st[0]}</span>${a.snapshotInfo.live ? '<span class="small muted">Draft results are calculated with the current settings and calibration tables and may change.</span>' : `<span class="small muted">Frozen at finalisation on ${fmtDT(a.finalisedAt)} by ${esc(a.finalisedBy)} (settings v${a.snapshotInfo.settingsVersion}). Later changes to settings do not recalculate this audit.</span>`}</div>
      ${a.status === 'superseded' ? '<div class="notice warn">This version was replaced by a later revision. See the revision list below.</div>' : ''}
      ${a.revisionReason ? `<div class="notice info"><strong>Reason for revision ${a.revision}:</strong> ${esc(a.revisionReason)}</div>` : ''}
      <section class="panel"><h2>Audit details</h2><dl class="kv">
        <dt>Audit reference</dt><dd>${esc(a.reference)}${a.revision ? ` (revision ${a.revision})` : ''}</dd>
        <dt>Stock take date</dt><dd>${fmtDate(inp.auditDate)}</dd>
        <dt>Stock compared as at (cut-off)</dt><dd>${fmtDT(inp.cutoff)} (Asia/Kuching)</dd>
        <dt>Auditor / prepared by</dt><dd>${esc(inp.preparedBy)}</dd>
        <dt>Products included</dt><dd>${(inp.products || []).map((p) => esc(P()[p].name)).join(', ')}</dd>
        <dt>Remarks</dt><dd>${esc(inp.remarks || '–')}</dd></dl></section>
      <section class="stack"><h2>Results by product</h2>${productResultsHtml(r)}</section>
      <section class="stack"><h2>Measurements</h2>${Object.values(r.units).map((x) => measurementDetailHtml(x, inp)).join('')}</section>
      <section class="stack"><h2>Stock movements</h2><p class="small muted">Applied when after the cut-off and at or before the unit's measurement time. Outflows are added back; inflows are deducted.</p>${movementsTableHtml(r)}</section>
      <section class="panel"><h2>Calibration tables and settings used</h2>
        <div class="table-wrap"><table><thead><tr><th>Storage unit</th><th>Table version</th><th>Status</th></tr></thead><tbody>${Object.entries(a.snapshotInfo.tables).filter(([k]) => r.units[k]).map(([k, t]) => `<tr><td>${esc(unitName(k))}</td><td>v${t.version}</td><td>${statusPill(t.status)}</td></tr>`).join('')}</tbody></table></div>
        <p class="small muted">Settings version ${a.snapshotInfo.settingsVersion}${a.snapshotInfo.engineVersion ? `, calculation engine ${esc(a.snapshotInfo.engineVersion)}` : ''}.</p></section>
      <section class="stack"><h2>${a.status === 'draft' ? 'Items to resolve' : 'Warnings and notes'}</h2>${issuesHtml(r, { demo: a.isDemo })}</section>
      <section class="panel"><h2>Sign-off</h2><div class="table-wrap"><table><thead><tr><th>Role</th><th>Name</th><th>Signature</th><th>Date</th></tr></thead><tbody>
        <tr><td>Prepared by</td><td>${esc(so.preparedBy || inp.preparedBy || '')}</td><td style="height:48px"></td><td></td></tr><tr><td>Checked by</td><td>${esc(so.checkedBy || '')}</td><td style="height:48px"></td><td></td></tr><tr><td>Approved by</td><td>${esc(so.approvedBy || '')}</td><td style="height:48px"></td><td></td></tr></tbody></table></div></section>
      <section class="panel no-print"><h2>Revisions and change history</h2>
        ${a.revisions.length > 1 ? `<div class="table-wrap"><table><thead><tr><th>Revision</th><th>Status</th><th>Finalised</th><th>Reason</th></tr></thead><tbody>${a.revisions.map((x) => `<tr class="clickable" data-href="#/audit/${x.id}"><td>${x.revision}${x.id === a.id ? ' (this)' : ''}</td><td>${AUDIT_STATUS[x.status][0]}</td><td>${fmtDT(x.finalised_at)}</td><td>${esc(x.revision_reason || '')}</td></tr>`).join('')}</tbody></table></div>` : ''}
        <div class="table-wrap"><table><thead><tr><th>Date/time</th><th>By</th><th>Action</th><th>Detail</th></tr></thead><tbody>${a.events.map((e) => `<tr><td>${fmtDT(e.at)}</td><td>${esc(e.user_name)}</td><td>${esc(e.action.replace(/_/g, ' '))}</td><td class="small">${e.detail ? esc(Object.entries(e.detail).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('; ')) : ''}</td></tr>`).join('')}</tbody></table></div></section>
    </div>`;
    bindRowLinks();
    $('#printBtn').onclick = () => window.print();
    $('#pdfBtn').onclick = () => pdfReport(a, false);
    $('#pdfDlBtn').onclick = () => pdfReport(a, true);
    $('#csvBtn').onclick = () => downloadApi(`/api/audits/${a.id}/export.csv`);
    const rb = $('#reviseBtn');
    if (rb) rb.onclick = async () => {
      const res = await modal({ title: 'Correct a finalised audit', body: '<p>This keeps the finalised version unchanged and creates a new revision as a draft. When the revision is finalised, it replaces this version.</p><label class="field"><span>Reason for the correction</span><textarea name="reason" required></textarea></label>', actions: [{ label: 'Cancel', value: 'cancel' }, { label: 'Create revision', value: 'ok', primary: true }] });
      if (res.action !== 'ok') return;
      try { const n = await api('POST', `/api/audits/${a.id}/revise`, { reason: res.form.reason }); toast(`Revision ${n.revision} created.`); location.hash = `#/audit/${n.id}/edit/1`; } catch (e) { fail(e); }
    };
    const db = $('#delBtn');
    if (db) db.onclick = async () => {
      const res = await modal({ title: 'Delete this draft?', body: `<p>${esc(a.reference)} will be deleted permanently.</p>`, actions: [{ label: 'Keep it', value: 'cancel' }, { label: 'Delete draft', value: 'ok', danger: true }] });
      if (res.action !== 'ok') return;
      try { await api('DELETE', `/api/audits/${a.id}`); toast('Draft deleted.'); location.hash = '#/history'; } catch (e) { fail(e); }
    };
  }

  // ---------- stock take: 1 Choose stock · 2 Enter readings · 3 See result ----------
  const STEPS = ['Choose stock', 'Enter readings', 'See result'];
  // Saved links from the earlier five-step form: steps 4 (book stock & results) and 5 (review &
  // finalise) now live in step 3. Steps 1 to 3 keep their numbers (step 3 still starts with movements).
  const OLD_STEP = { 4: { step: 3, focus: 'book' }, 5: { step: 3, focus: 'finalise' } };
  const PRODUCT_CARD = { CPO: ['CPO', '3 tanks'], PK: ['Palm Kernel', '2 bunkers'], DSL: ['Diesel', '1 tank'] };
  const NOUN = { CPO: 'tank', PK: 'bunker', DSL: 'tank' };
  const STOCK_WORD = { CPO: 'CPO', PK: 'PK', DSL: 'diesel' };
  const unitWord = (p) => (P()[p].unit === 'L' ? 'litres' : P()[p].unit);
  const cap = (t) => t[0].toUpperCase() + t.slice(1);
  function blankInputs() {
    return { auditDate: S.meta.now.slice(0, 10), cutoff: '', preparedBy: S.user.displayName, products: [], remarks: '', units: {}, movements: [], book: { CPO: {}, PK: {}, DSL: {} }, signoff: {} };
  }
  function startNew() {
    if (!canEdit()) { app.innerHTML = '<div class="notice warn">Your role can view audits but cannot create them.</div>'; return; }
    S.draft = { id: null, reference: null, isDemo: false, status: 'draft', inputs: blankInputs() };
    S.dtRaw = {}; S.dirty = false; S.results = null; S.step = 1; S.unit = null; S.focus = null;
    renderWizard();
  }
  async function openWizard(id, step, focus) {
    if (!canEdit()) { location.hash = `#/audit/${id}`; return; }
    if (!S.draft || S.draft.id !== id) {
      const a = await api('GET', `/api/audits/${id}`);
      if (a.status !== 'draft') { toast('This audit is finalised. Create a revision to correct it.', true); location.hash = `#/audit/${id}`; return; }
      S.draft = { id: a.id, reference: a.reference, revision: a.revision, isDemo: a.isDemo, status: a.status, revisionReason: a.revisionReason, inputs: a.inputs };
      S.results = a.results; S.dtRaw = {}; S.dirty = false; S.unit = null;
    }
    const old = OLD_STEP[step];
    S.step = old ? old.step : Math.min(3, Math.max(1, step || 1));
    S.focus = old ? old.focus : (focus || null);
    if (old || step > 3 || focus) { history.replaceState(null, '', `#/audit/${id}/edit/${S.step}`); lastHash = location.hash; }
    renderWizard();
  }
  // Where each item to resolve is fixed.
  function issueTarget(i) {
    if (i.gate) return { step: 3, settings: i.gate };
    if (i.unit) return { step: 2, unit: i.unit };
    if (i.movement) return { step: 3, focus: `mv-${i.movement - 1}` };
    if (i.product) return { step: 3, focus: `book-${i.product}` };
    return { step: 1 };
  }
  function stepIssues(r) {
    const c = [0, 0, 0, 0];
    if (!r) return c;
    for (const i of r.blockers) c[issueTarget(i).step]++;
    return c;
  }
  function renderWizard() {
    const d = S.draft;
    const counts = stepIssues(S.results);
    app.innerHTML = `
      <div class="wiz-head"><div><h1>${d.id ? `Stock take ${esc(d.reference)}${d.revision ? ` <span class="muted">rev ${d.revision}</span>` : ''}` : 'New stock take'}</h1>
        <p class="muted">${d.id ? 'Draft. Finish the three steps, then finalise.' : 'The reference number is given automatically when you first save.'}</p></div></div>
      ${d.isDemo ? '<div class="watermark">DEMONSTRATION · NOT AN ACTUAL AUDIT</div>' : ''}
      ${d.revisionReason ? `<div class="notice info"><strong>Revision ${d.revision}:</strong> ${esc(d.revisionReason)}</div>` : ''}
      <ol class="progress" aria-label="Steps">${STEPS.map((s, i) => `<li><button type="button" data-step="${i + 1}" class="${S.step > i + 1 ? 'done' : ''}" ${S.step === i + 1 ? 'aria-current="step"' : ''}><span class="n">${S.step > i + 1 ? '✓' : i + 1}</span><span class="lbl">${esc(s)}</span>${counts[i + 1] ? `<span class="pill bad" title="Items to complete">${counts[i + 1]}</span>` : ''}</button></li>`).join('')}</ol>
      <div id="stepBody" class="stack"></div>
      <div class="wizard-bar">
        ${S.step > 1 ? '<button type="button" id="prevBtn">← Back</button>' : ''}
        <span class="spacer"></span>
        <span class="save-state ${S.dirty ? 'dirty' : ''}" id="saveState">${S.dirty ? 'Unsaved changes' : (d.id ? 'All changes saved' : 'Not saved yet')}</span>
        <button type="button" id="saveBtn" class="${S.dirty ? 'dirty' : ''}"><span class="long">Save for later</span><span class="short">Save</span></button>
        ${S.step === 1 ? '<button type="button" class="btn-primary" id="nextBtn"><span class="long">Enter readings →</span><span class="short">Readings →</span></button>' : ''}
        ${S.step === 2 ? '<button type="button" class="btn-primary" id="nextBtn"><span class="long">See result →</span><span class="short">Result →</span></button>' : ''}
        ${S.step === 3 ? '<button type="button" class="btn-primary" id="finaliseBtn"><span class="long">Finalise stock take</span><span class="short">Finalise</span></button>' : ''}
      </div>`;
    bindStep($('#stepBody'));
    renderStep();
    $$('.progress button').forEach((b) => (b.onclick = () => goStep(+b.dataset.step)));
    const pb = $('#prevBtn'); if (pb) pb.onclick = () => goStep(S.step - 1);
    const nb = $('#nextBtn'); if (nb) nb.onclick = () => goStep(S.step + 1);
    const fb = $('#finaliseBtn'); if (fb) fb.onclick = () => finalise();
    $('#saveBtn').onclick = () => saveDraft().catch(fail);
    if (!S.results) scheduleCompute(0);
  }
  function goStep(n, focus) {
    if (n > 1 && S.step === 1 && !S.draft.inputs.products.length) { toast('Choose one or more: CPO, Palm Kernel or Diesel.', true); return; }
    S.step = Math.min(3, Math.max(1, n));
    S.focus = focus || null;
    if (S.draft.id) { S.skipRoute = true; location.hash = `#/audit/${S.draft.id}/edit/${S.step}`; }
    renderWizard(); if (!S.focus) window.scrollTo(0, 0);
  }
  function markDirty() { S.dirty = true; const s = $('#saveState'); if (s) { s.textContent = 'Unsaved changes'; s.classList.add('dirty'); } const sb = $('#saveBtn'); if (sb) sb.classList.add('dirty'); }
  async function saveDraft() {
    const d = S.draft;
    const flagged = $$('input.invalid', app);
    if (flagged.length) toast('Some dates or times are not valid yet; they were saved as blank.', true);
    if (!d.id) {
      const a = await api('POST', '/api/audits', { inputs: d.inputs });
      Object.assign(d, { id: a.id, reference: a.reference, revision: a.revision });
      S.results = a.results; S.dirty = false;
      S.skipRoute = true; location.hash = `#/audit/${a.id}/edit/${S.step}`;
      renderWizard();
    } else {
      const a = await api('PUT', `/api/audits/${d.id}`, { inputs: d.inputs });
      S.results = a.results; S.dirty = false; renderWizard();
    }
    toast(`Saved (${d.reference}). You can continue later from Audit History.`);
  }
  function scheduleCompute(delay = 450) {
    clearTimeout(S.computeTimer);
    S.computeTimer = setTimeout(async () => {
      const seq = ++S.computeSeq;
      try { const r = await api('POST', '/api/compute', { inputs: S.draft.inputs }); if (seq === S.computeSeq) { S.results = r; updateCalc(); } } catch (e) { fail(e); }
    }, delay);
  }

  // field builders
  const bindAttr = (path) => `data-bind="${esc(path)}"`;
  const val = (path) => { const v = getPath(S.draft.inputs, path); return v === undefined || v === null ? '' : v; };
  function textField(label, path, o = {}) {
    return `<label class="field"><span>${label}${o.hint ? ` <span class="hint">${o.hint}</span>` : ''}</span>${o.suffix ? `<div class="unit-suffix">` : ''}<input type="text" ${o.num ? 'inputmode="decimal"' : ''} ${bindAttr(path)} value="${esc(val(path))}" ${o.placeholder ? `placeholder="${esc(o.placeholder)}"` : ''} ${o.id ? `id="${o.id}"` : ''} ${o.autocomplete ? `autocomplete="${o.autocomplete}"` : ''}>${o.suffix ? `<span>${esc(o.suffix)}</span></div>` : ''}${o.help ? `<span class="help">${o.help}</span>` : ''}</label>`;
  }
  function selectField(label, path, options, o = {}) {
    const v = val(path);
    return `<label class="field"><span>${label}${o.hint ? ` <span class="hint">${o.hint}</span>` : ''}</span><select ${bindAttr(path)} ${o.rerender ? 'data-rerender="1"' : ''}>${options.map(([k, l]) => `<option value="${esc(k)}" ${String(v) === String(k) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>${o.help ? `<span class="help">${o.help}</span>` : ''}</label>`;
  }
  function areaField(label, path, o = {}) {
    return `<label class="field"><span>${label}${o.hint ? ` <span class="hint">${o.hint}</span>` : ''}</span><textarea ${bindAttr(path)} ${o.rows ? `rows="${o.rows}"` : ''}>${esc(val(path))}</textarea></label>`;
  }
  function dtField(label, path, o = {}) {
    const v = val(path);
    const raw = S.dtRaw[path] || { date: v ? fmtDate(v.slice(0, 10)) : '', time: v && v.length >= 16 ? v.slice(11, 16) : '' };
    return `<div class="field"><span class="field-label">${label}${o.hint ? ` <span class="hint">${o.hint}</span>` : ''}</span>
      ${o.help ? `<span class="help">${o.help}</span>` : ''}
      <div class="dt"><label class="field"><span class="hint">Date (DD/MM/YYYY)</span><input type="text" inputmode="numeric" data-dt="${esc(path)}" data-part="date" value="${esc(raw.date)}" placeholder="23/06/2026" class="${raw.date && !parseDate(raw.date) ? 'invalid' : ''}"></label>
      ${o.dateOnly ? '' : `<label class="field"><span class="hint">Time (24-hour)</span><input type="text" inputmode="numeric" data-dt="${esc(path)}" data-part="time" value="${esc(raw.time)}" placeholder="06:00" class="${raw.time && !parseTime(raw.time) ? 'invalid' : ''}"></label>`}
      ${o.noNow ? '' : `<button type="button" class="btn-sm" data-act="now" data-path="${esc(path)}" data-dateonly="${o.dateOnly ? 1 : ''}">${o.dateOnly ? 'Today' : 'Now'}</button>`}</div></div>`;
  }
  const unitOpts = [['', 'Choose…'], ['mm', 'millimetres (mm)'], ['cm', 'centimetres (cm)'], ['m', 'metres (m)']];

  function renderStep() {
    const body = $('#stepBody');
    const inp = S.draft.inputs;
    if (S.step === 1) body.innerHTML = step1(inp);
    if (S.step === 2) body.innerHTML = step2(inp);
    if (S.step === 3) body.innerHTML = step3(inp);
    updateCalc();
    if (S.focus) {
      const target = S.focus === 'book' ? $('[id^="book-"]') : $(`#${S.focus === 'finalise' ? 'sec-finalise' : S.focus}`);
      S.focus = null;
      if (target) setTimeout(() => { target.scrollIntoView({ block: 'start' }); const f = target.querySelector('input, select, textarea, button'); if (f) f.focus({ preventScroll: true }); }, 30);
    }
  }

  // Step 1: what is being checked, and when
  function step1(inp) {
    return `<section class="card"><div><h2>What are you checking?</h2><p class="help">Choose one or more.</p></div>
      <div class="choice-grid">${Object.values(P()).map((p) => `<label class="choice ${p.code}"><input type="checkbox" data-product="${p.code}" ${inp.products.includes(p.code) ? 'checked' : ''}><span class="bar" aria-hidden="true"></span><span class="tick" aria-hidden="true">✓</span><span class="choice-title">${esc(PRODUCT_CARD[p.code][0])}</span><span class="choice-sub">${esc(PRODUCT_CARD[p.code][1])}</span></label>`).join('')}</div></section>
      <section class="card">
        <div class="grid-2">${dtField('Stock take date', 'auditDate', { dateOnly: true })}${textField('Prepared by', 'preparedBy', { autocomplete: 'name' })}</div>
        ${dtField('Compare stock as at', 'cutoff', { help: 'Use the date and time shown on your book stock record. Example: 6:00 a.m.', noNow: true })}
        <details ${inp.remarks ? 'open' : ''}><summary>Add remarks (optional)</summary>${areaField('Remarks', 'remarks', { rows: 3 })}</details>
        <p class="small muted">All times are Malaysia time (Asia/Kuching).</p>
        <div id="calc-step1"></div></section>`;
  }

  // Step 2: one tank or bunker at a time
  function includedUnits(inp) { return inp.products.flatMap((p) => unitsOf(p)); }
  function unitState(code) {
    const ui = (S.draft.inputs.units || {})[code] || {};
    const x = S.results && S.results.units[code];
    if (!ui.status) return ['todo', 'Not started', ''];
    if (ui.status === 'excluded') return x && x.issues.some((i) => i.level === 'block') ? ['issue', 'Reason needed', '!'] : ['skip', 'Not checked', '–'];
    if (x && x.issues.some((i) => i.level === 'block' && !i.gate)) return ['issue', 'Needs attention', '!'];
    return ['done', ui.status === 'empty' ? 'Empty' : 'Done', '✓'];
  }
  function unitPickerHtml(inp) {
    const units = includedUnits(inp);
    const done = units.filter((u) => ['done', 'skip'].includes(unitState(u.code)[0])).length;
    return `<div class="up-head"><h2>Enter readings</h2><span class="muted">${done} of ${units.length} ${units.length === 1 ? 'tank or bunker' : 'tanks and bunkers'} done</span></div>
      <div class="up-list" role="list">${units.map((u) => { const [st, label, ico] = unitState(u.code); return `<button type="button" role="listitem" class="up state-${st}" data-unit="${u.code}" aria-current="${S.unit === u.code}"><span class="up-ico" aria-hidden="true">${ico}</span><span class="up-txt"><span>${esc(u.name)}</span><small>${esc(label)}</small></span></button>`; }).join('')}</div>`;
  }
  function step2(inp) {
    if (!inp.products.length) return '<div class="notice warn"><span>Choose what you are checking first.</span><div><button type="button" class="btn-sm" data-goto="1">Go to step 1</button></div></div>';
    const units = includedUnits(inp);
    if (!units.some((u) => u.code === S.unit)) S.unit = (units.find((u) => unitState(u.code)[0] === 'todo') || units[0]).code;
    const u = units.find((x) => x.code === S.unit);
    return `<section class="card unit-picker" id="unitPicker">${unitPickerHtml(inp)}</section>${unitCard(u, inp, units)}`;
  }
  function tableBadge(code) {
    const t = S.results && S.results.units[code] && S.results.units[code].table;
    if (!t) return '';
    return `<a class="small" href="#/settings/unit/${code}" target="_blank" rel="noopener">Calibration table v${t.version} · ${t.status === 'needs_attention' ? 'import needs attention' : 'ready to use'}</a>`;
  }
  function numField(label, path, unit, o = {}) {
    return textField(label, path, { num: true, suffix: unit || 'unit?', ...o });
  }
  function unitCard(u, inp, units) {
    const base = `units.${u.code}`;
    const ui = (inp.units && inp.units[u.code]) || {};
    const st = ui.status || '';
    const noun = NOUN[u.product];
    const idx = units.findIndex((x) => x.code === u.code);
    const prev = units[idx - 1], next = units[idx + 1];
    let h = `<section class="card unit-panel p-${u.product}" id="unit-${u.code}">
      <div class="unit-title"><span class="product-tag ${u.product}">${esc(P()[u.product].short)}</span><h2>${esc(u.name)}</h2></div>
      <fieldset class="status-choice"><legend>What did you find?</legend>
        <label class="opt"><input type="radio" name="st-${u.code}" data-status="${u.code}" value="measured" ${st === 'measured' ? 'checked' : ''}><span><b>Enter readings</b><small>Measured today</small></span></label>
        <label class="opt"><input type="radio" name="st-${u.code}" data-status="${u.code}" value="empty" ${st === 'empty' ? 'checked' : ''}><span><b>${cap(noun)} is empty</b><small>Counted as zero</small></span></label>
        <label class="opt"><input type="radio" name="st-${u.code}" data-status="${u.code}" value="excluded" ${st === 'excluded' ? 'checked' : ''}><span><b>Not checked</b><small>Left out, with a reason</small></span></label>
      </fieldset>`;
    if (!st) h += `<p class="help">Choose one. A ${noun} left blank is not counted as empty.</p>`;
    if (st === 'excluded') h += textField(`Why was this ${noun} not checked?`, `${base}.excludeReason`, { placeholder: 'For example: tank under maintenance', help: 'Required. The stock take is marked as partial.' });
    if (st === 'empty') h += `${dtField(`Date and time the ${noun} was checked`, `${base}.measuredAt`)}<details ${ui.remarks ? 'open' : ''}><summary>Add remarks (optional)</summary>${textField('Remarks', `${base}.remarks`)}</details>`;
    if (st === 'measured') {
      if (u.product === 'CPO') {
        const ru = ui.readingUnit || '';
        h += `<div class="grid-2">${dtField('Dipping date and time', `${base}.measuredAt`)}${selectField('Tape reading unit', `${base}.readingUnit`, unitOpts, { rerender: true, help: 'The tank table is in mm. The June 2026 readings were in cm.' })}</div>
          <div class="readings">${[0, 1, 2].map((i) => `<div class="reading-block"><h3>Reading ${i + 1}</h3>
            ${numField('Reference mark', `${base}.readings.${i}.ref`, ru)}
            ${numField('Wetted part', `${base}.readings.${i}.wet`, ru)}
            <div class="ullage-box" aria-live="polite"><span>Empty space (ullage)</span><b data-calc="ull-${u.code}-${i}">–</b></div></div>`).join('')}</div>
          <div class="grid-2">${textField('Oil temperature', `${base}.temperatureC`, { num: true, suffix: '°C' })}</div>`;
      } else if (u.product === 'PK') {
        const pts = (ui.points && ui.points.length) ? ui.points : [{ label: '', ullage: '' }];
        if (!ui.points || !ui.points.length) setPath(inp, `${base}.points`, pts);
        if (!ui.adoptedMethod) setPath(inp, `${base}.adoptedMethod`, (S.settingsCache && S.settingsCache.pk.samplingMethod.value) || 'average_ullage');
        const pu = ui.pointUnit || '';
        const methodIssue = S.results && S.results.units[u.code] && S.results.units[u.code].issues.some((i) => /^pk_(manual|single|method)/.test(i.code));
        h += `<div class="grid-2">${dtField('Measurement date and time', `${base}.measuredAt`)}${selectField('Measurement unit', `${base}.pointUnit`, unitOpts, { rerender: true, help: 'The bunker table is in mm.' })}</div>
          <div class="stack"><div><h3>Measuring points</h3><p class="help">Measure the empty space above the kernels at each point. Every point is kept.</p></div>
          ${pts.map((pt, i) => `<div class="point-row">${textField(`Point ${i + 1} name`, `${base}.points.${i}.label`, { placeholder: 'For example: centre, north edge' })}${numField('Empty space above kernels (ullage)', `${base}.points.${i}.ullage`, pu)}
            <div class="ullage-box"><span>Volume at this point</span><b data-calc="ptvol-${u.code}-${i}">–</b></div>
            <div>${pts.length > 1 ? `<button type="button" class="btn-sm btn-danger" data-act="del-point" data-unit="${u.code}" data-i="${i}">Remove</button>` : ''}</div></div>`).join('')}
          <div><button type="button" class="btn-sm" data-act="add-point" data-unit="${u.code}">+ Add a measuring point</button></div></div>
          <details class="more" ${ui.adoptedMethod === 'manual' || methodIssue ? 'open' : ''}><summary>Measurement method (${esc(S.meta.pkSamplingMethods[ui.adoptedMethod || ''] || 'choose')})</summary>
            <div class="grid-2">${selectField('How the measurement used for the stock was obtained', `${base}.adoptedMethod`, Object.entries(S.meta.pkSamplingMethods), { rerender: true })}
            ${ui.adoptedMethod === 'manual' ? numField('Measurement used (ullage)', `${base}.adoptedUllage`, pu) : ''}</div>
            ${areaField(`Notes on how it was measured${ui.adoptedMethod === 'manual' ? ' (required)' : ''}`, `${base}.adoptedNote`, { rows: 2 })}</details>`;
      } else {
        const du = ui.dipUnit || '';
        h += `<div class="grid-2">${dtField('Measurement date and time', `${base}.measuredAt`)}${selectField('Measurement unit', `${base}.dipUnit`, unitOpts, { rerender: true, help: 'The diesel table uses depth of liquid, in mm.' })}</div>
          <div class="grid-2">${numField('Diesel depth', `${base}.dip`, du)}</div>
          <details ${ui.waterDip !== undefined && ui.waterDip !== '' ? 'open' : ''}><summary>Water at the bottom (optional)</summary>
            <div class="grid-2">${numField('Water depth', `${base}.waterDip`, du, { help: 'Leave blank if not measured. Enter 0 if checked and no water was found.' })}</div></details>`;
      }
      h += `<details ${ui.remarks ? 'open' : ''}><summary>Add remarks (optional)</summary>${textField('Remarks', `${base}.remarks`)}</details>`;
    }
    h += `<div data-calc="qty-${u.code}"></div>
      <div data-calc="uissues-${u.code}"></div>
      <details class="more"><summary>Show calculation details</summary><div data-calc="unit-${u.code}"></div><div>${tableBadge(u.code)}</div></details>
      <div class="unit-nav">${prev ? `<button type="button" data-unit="${prev.code}">← ${esc(prev.name)}</button>` : '<span></span>'}${next ? `<button type="button" data-unit="${next.code}">Next: ${esc(next.name)} →</button>` : ''}</div>
      </section>`;
    return h;
  }

  // Step 3: movements, book stock, result, finalise
  const MV_GROUPS = {
    out: { title: 'Stock sent OUT', add: 'stock sent out', help: (p) => (p === 'DSL' ? 'Issued or used.' : 'Despatched or otherwise removed.'), types: (p) => S.meta.movementTypes[p].filter((t) => t.sign < 0) },
    in: { title: 'Stock added IN', add: 'stock added in', help: (p) => (p === 'DSL' ? 'Received or returned to the tank.' : 'Produced or received.'), types: (p) => S.meta.movementTypes[p].filter((t) => t.sign > 0) },
    transfer: { title: 'Transfers between tanks/bunkers', add: 'transfer', help: (p) => `Moved from one ${NOUN[p]} to another. Enter each transfer once.`, types: (p) => S.meta.movementTypes[p].filter((t) => t.code === 'transfer') },
  };
  function mvGroup(m) {
    const t = (S.meta.movementTypes[m.product] || []).find((x) => x.code === m.type);
    if (!t) return 'unsorted';
    return t.code === 'transfer' ? 'transfer' : t.sign < 0 ? 'out' : 'in';
  }
  function intervalHtml(inp) {
    if (!inp.cutoff) return '<div class="interval">Enter <b>Compare stock as at</b> in step 1 first. Movements are counted from that time up to each measurement.</div>';
    const units = includedUnits(inp).filter((u) => { const x = (inp.units || {})[u.code] || {}; return x.status === 'measured' || x.status === 'empty'; });
    const times = units.map((u) => [u, (inp.units[u.code] || {}).measuredAt || '']);
    const distinct = [...new Set(times.map(([, t]) => t))];
    if (times.length && distinct.length === 1 && distinct[0]) return `<div class="interval">Enter movements between <b>${fmtDT(inp.cutoff)}</b> and <b>${fmtDT(distinct[0])}</b>.</div>`;
    if (!times.length) return `<div class="interval">Enter movements between <b>${fmtDT(inp.cutoff)}</b> and the time each ${'tank or bunker'} was measured (step 2).</div>`;
    return `<div class="interval">Enter movements between <b>${fmtDT(inp.cutoff)}</b> and the time each tank or bunker was measured:
      <ul>${times.map(([u, t]) => `<li>${esc(u.name)}: until <b>${t ? fmtDT(t) : 'not measured yet'}</b></li>`).join('')}</ul></div>`;
  }
  function step3(inp) {
    if (!inp.products.length) return '<div class="notice warn"><span>Choose what you are checking first.</span><div><button type="button" class="btn-sm" data-goto="1">Go to step 1</button></div></div>';
    const mvs = inp.movements || [];
    const unsorted = mvs.map((m, i) => [m, i]).filter(([m]) => mvGroup(m) === 'unsorted');
    return `<section class="card"><div><h2>Stock movements</h2><p class="help">Despatches, production, receipts, issues and transfers after the stock was compared and before it was measured. They take the measured stock back to the comparison time.</p></div>
        ${intervalHtml(inp)}
        <details><summary>How movements are counted</summary><p class="small">A movement is counted when it is <b>after</b> the comparison time and <b>at or before</b> the ${'tank or bunker'}'s measurement time. A movement exactly at the comparison time is already in the book stock. Stock sent out is added back; stock added in is taken off. Each transfer is entered once, from one ${'tank or bunker'} to another.</p></details>
        ${unsorted.length ? `<div class="stack"><h3>Movements to complete</h3>${unsorted.map(([m, i]) => movementCard(m, i, inp, null)).join('')}</div>` : ''}</section>
      ${inp.products.map((p) => productSection(p, inp)).join('')}
      <section class="card" id="sec-finalise"><div><h2>Check and finalise</h2><p class="help">Finalising freezes the readings, calibration table versions and settings used. After that, a correction is made as a new revision with a reason.</p></div>
        ${S.draft.isDemo ? '<div class="notice info">This is a demonstration. It can be finalised for demonstration even while settings are pending; the report is marked as a demonstration.</div>' : ''}
        <div data-calc="review" class="stack"></div>
        <div><h3>Sign-off names</h3><p class="help">Printed on the report with spaces for signatures and dates.</p></div>
        <div class="grid">${textField('Prepared by', 'signoff.preparedBy', { placeholder: inp.preparedBy })}${textField('Checked by', 'signoff.checkedBy')}${textField('Approved by', 'signoff.approvedBy')}</div>
      </section>`;
  }
  function productSection(p, inp) {
    const mvs = (inp.movements || []).map((m, i) => [m, i]).filter(([m]) => m.product === p && mvGroup(m) !== 'unsorted');
    const none = !!(inp.noMovements && inp.noMovements[p]);
    const groups = Object.entries(MV_GROUPS).filter(([, g]) => g.types(p).length);
    const cut = inp.cutoff ? fmtDT(inp.cutoff) : 'the comparison time';
    return `<section class="card" id="prod-${p}"><div class="prod-head"><span class="product-tag ${p}">${esc(P()[p].short)}</span><h2>${esc(P()[p].name)}</h2></div>
      <div class="stack">
        ${groups.map(([key, g]) => { const list = mvs.filter(([m]) => mvGroup(m) === key); return `<div class="mv-group"><div><h3>${esc(g.title)}</h3><p class="help">${esc(g.help(p))}</p></div>
          ${list.map(([m, i]) => movementCard(m, i, inp, key)).join('')}
          ${none ? '' : `<button type="button" class="btn-add" data-act="add-mv" data-product="${p}" data-group="${key}">+ Add ${esc(g.add)}</button>`}</div>`; }).join('')}
        <label class="check"><input type="checkbox" data-nomv="${p}" ${none ? 'checked' : ''} ${mvs.length ? 'disabled' : ''}> No movements during this period${mvs.length ? ' <span class="hint">(remove the entries above first)</span>' : ''}</label>
      </div>
      <div class="stack" id="book-${p}"><h3>Book stock at ${esc(cut)}</h3>
        <div class="grid-2">${textField(`Total ${STOCK_WORD[p]} book stock`, `book.${p}.total`, { num: true, suffix: P()[p].unit })}</div>
        <details ${Object.keys((inp.book[p] || {}).perUnit || {}).length ? 'open' : ''}><summary>Book stock for each ${NOUN[p]} (optional)</summary>
          <p class="help">Needed to compare a partial stock take, where a ${NOUN[p]} was not checked.</p>
          <div class="grid">${unitsOf(p).map((u) => textField(u.name, `book.${p}.perUnit.${u.code}`, { num: true, suffix: P()[p].unit })).join('')}</div></details>
        <details ${(inp.book[p] || {}).note ? 'open' : ''}><summary>Book stock note (optional)</summary>${textField('Note', `book.${p}.note`)}</details>
      </div>
      <div class="stack"><h3>Result</h3><div data-calc="result-${p}" class="stack"></div></div>
    </section>`;
  }
  function movementCard(m, i, inp, group) {
    const base = `movements.${i}`;
    const p = m.product;
    const allTypes = S.meta.movementTypes[p] || [];
    const types = group ? MV_GROUPS[group].types(p) : allTypes;
    const units = unitsOf(p);
    const unit = P()[p] ? P()[p].unit : '';
    const isTransfer = m.type === 'transfer';
    const est = m.basis === 'estimated';
    const hoursRate = est && m.estimateMethod === 'hours_rate';
    const n = (inp.movements || []).filter((x, k) => k <= i && x.product === p && mvGroup(x) === mvGroup(m)).length;
    const title = group === 'transfer' ? `Transfer ${n}` : group === 'out' ? `Sent out ${n}` : group === 'in' ? `Added in ${n}` : `Movement ${i + 1}`;
    const src = (inp.units || {})[m.unit] || {};
    return `<div class="mv-card" id="mv-${i}"><div class="mv-head"><span class="product-tag ${p}">${esc(P()[p] ? P()[p].short : p)}</span><h4>${esc(title)}</h4><span class="spacer"></span><button type="button" class="btn-sm btn-danger" data-act="del-mv" data-i="${i}">Remove</button></div>
      <div class="grid">
        ${types.length > 1 || !group ? selectField('Type', `${base}.type`, [['', 'Choose…'], ...(group ? types : allTypes).map((t) => [t.code, t.label])], { rerender: true }) : ''}
        ${selectField(isTransfer ? `From ${NOUN[p]}` : (units.length > 1 ? `Which ${NOUN[p]}?` : cap(NOUN[p])), `${base}.unit`, [['', 'Choose…'], ...units.map((u) => [u.code, u.name])], { rerender: true })}
        ${isTransfer ? selectField(`To ${NOUN[p]}`, `${base}.toUnit`, [['', 'Choose…'], ...units.map((u) => [u.code, u.name])]) : ''}
      </div>
      ${m.unit && inp.cutoff ? `<p class="small muted">Counts for ${esc(unitName(m.unit))} if between ${fmtDT(inp.cutoff)} and ${src.measuredAt ? fmtDT(src.measuredAt) : 'its measurement time (not entered yet)'}.</p>` : ''}
      ${dtField('Date and time', `${base}.at`)}
      <div class="field"><span class="field-label">Quantity is</span><div class="seg">
        <label><input type="radio" name="basis-${i}" data-mvbasis="${i}" value="actual" ${m.basis === 'actual' ? 'checked' : ''}> Actual (ticket / meter)</label>
        <label><input type="radio" name="basis-${i}" data-mvbasis="${i}" value="estimated" ${est ? 'checked' : ''}> Estimated</label></div></div>
      ${est && p !== 'DSL' ? `<div class="field"><span class="field-label">How was it estimated?</span><div class="seg">
        <label><input type="radio" name="estm-${i}" data-mvestm="${i}" value="quantity" ${!hoursRate ? 'checked' : ''}> Enter the estimated quantity</label>
        <label><input type="radio" name="estm-${i}" data-mvestm="${i}" value="hours_rate" ${hoursRate ? 'checked' : ''}> Hours × ${unit} per hour</label></div></div>` : ''}
      <div class="grid">
        ${hoursRate ? `${textField('Hours', `${base}.estHours`, { num: true, suffix: 'h' })}${textField(`Estimated ${unit} per hour`, `${base}.estRate`, { num: true, suffix: `${unit}/h`, hint: 'No default rate is used' })}<div class="field"><span class="field-label">Estimated quantity</span><div class="ullage-box"><b data-calc="mvqty-${i}">–</b></div></div>`
          : textField('Quantity', `${base}.qty`, { num: true, suffix: unit })}
        ${textField('Ticket / document reference', `${base}.ref`)}
      </div>
      <details ${m.remarks || m.discrepancyNote ? 'open' : ''}><summary>Remarks and notes (optional)</summary>
        ${textField('Remarks', `${base}.remarks`)}
        ${textField('Discrepancy or assumption note', `${base}.discrepancyNote`, { help: 'Shown as a warning on the result and report.' })}</details>
      <div class="calc-box" data-calc="mv-${i}"></div></div>`;
  }

  function bindStep(body) {
    body.addEventListener('input', (e) => {
      const t = e.target;
      if (t.dataset.bind) {
        setPath(S.draft.inputs, t.dataset.bind, t.value);
        markDirty();
        if (t.dataset.rerender) { renderStep(); scheduleCompute(0); } else { liveUllage(t.dataset.bind); scheduleCompute(); }
      } else if (t.dataset.dt) onDt(t);
    });
    body.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.product) {
        const ps = new Set(S.draft.inputs.products);
        t.checked ? ps.add(t.dataset.product) : ps.delete(t.dataset.product);
        S.draft.inputs.products = Object.keys(P()).filter((p) => ps.has(p));
        markDirty(); scheduleCompute(0);
      } else if (t.dataset.status) {
        setPath(S.draft.inputs, `units.${t.dataset.status}.status`, t.value);
        markDirty(); renderStep(); scheduleCompute(0);
      } else if (t.dataset.nomv) {
        const nm = S.draft.inputs.noMovements || (S.draft.inputs.noMovements = {});
        if (t.checked) nm[t.dataset.nomv] = true; else delete nm[t.dataset.nomv];
        markDirty(); renderStep();
      } else if (t.dataset.mvbasis !== undefined) {
        const m = S.draft.inputs.movements[+t.dataset.mvbasis];
        m.basis = t.value;
        if (t.value === 'estimated' && !m.estimateMethod) m.estimateMethod = 'quantity';
        markDirty(); renderStep(); scheduleCompute(0);
      } else if (t.dataset.mvestm !== undefined) {
        S.draft.inputs.movements[+t.dataset.mvestm].estimateMethod = t.value;
        markDirty(); renderStep(); scheduleCompute(0);
      }
    });
    body.addEventListener('click', (e) => {
      const ub = e.target.closest('[data-unit]:not([data-act])');
      if (ub) { S.unit = ub.dataset.unit; renderStep(); const card = $(`#unit-${S.unit}`); if (card && ub.closest('.unit-nav')) card.scrollIntoView({ block: 'start' }); return; }
      const g = e.target.closest('[data-goto]');
      if (g) {
        const t = JSON.parse(g.dataset.goto.startsWith('{') ? g.dataset.goto : `{"step":${g.dataset.goto}}`);
        if (t.settings) { location.hash = t.settings === 'settings' ? '#/settings/methods' : '#/settings'; return; }
        if (t.unit) S.unit = t.unit;
        if (t.step === S.step) { S.focus = t.focus || null; renderStep(); if (t.unit) { const c = $(`#unit-${t.unit}`); if (c) c.scrollIntoView({ block: 'start' }); } } else goStep(t.step, t.focus);
        return;
      }
      const b = e.target.closest('[data-act]'); if (!b) return;
      const inp = S.draft.inputs;
      const act = b.dataset.act;
      if (act === 'now') {
        const path = b.dataset.path; const now = S.meta.now;
        const v = b.dataset.dateonly ? now.slice(0, 10) : nowKuchingClient();
        setPath(inp, path, v); delete S.dtRaw[path]; markDirty(); renderStep(); scheduleCompute(0);
      }
      if (act === 'add-point') { const pts = getPath(inp, `units.${b.dataset.unit}.points`) || []; pts.push({ label: '', ullage: '' }); setPath(inp, `units.${b.dataset.unit}.points`, pts); markDirty(); renderStep(); }
      if (act === 'del-point') { const pts = getPath(inp, `units.${b.dataset.unit}.points`); pts.splice(+b.dataset.i, 1); markDirty(); renderStep(); scheduleCompute(0); }
      if (act === 'add-mv') {
        const p = b.dataset.product, grp = MV_GROUPS[b.dataset.group];
        const types = grp ? grp.types(p) : [];
        inp.movements = inp.movements || [];
        inp.movements.push({ id: `m${Date.now()}`, product: p, type: types.length ? types[0].code : '', unit: unitsOf(p).length === 1 ? unitsOf(p)[0].code : '', at: '', qty: '', basis: '', ref: '', remarks: '' });
        if (inp.noMovements) delete inp.noMovements[p];
        S.focus = `mv-${inp.movements.length - 1}`;
        markDirty(); renderStep(); scheduleCompute(0);
      }
      if (act === 'del-mv') { inp.movements.splice(+b.dataset.i, 1); markDirty(); renderStep(); scheduleCompute(0); }
    });
  }
  function nowKuchingClient() {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kuching', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
    const g = (t) => parts.find((p) => p.type === t).value;
    return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`;
  }
  function onDt(t) {
    const path = t.dataset.dt;
    const wrap = t.closest('.dt');
    const dEl = $('[data-part="date"]', wrap), tEl = $('[data-part="time"]', wrap);
    const raw = { date: dEl.value, time: tEl ? tEl.value : '' };
    S.dtRaw[path] = raw;
    const d = parseDate(raw.date), tm = tEl ? parseTime(raw.time) : '00:00';
    dEl.classList.toggle('invalid', !!raw.date && !d);
    if (tEl) tEl.classList.toggle('invalid', !!raw.time && !tm);
    const v = tEl ? (d && tm ? `${d}T${tm}` : '') : (d || '');
    setPath(S.draft.inputs, path, v);
    markDirty(); scheduleCompute();
  }
  function liveUllage(path) {
    const m = path.match(/^units\.(CPO-T\d)\.readings\.(\d)\.(ref|wet)$/);
    if (!m) return;
    const r = getPath(S.draft.inputs, `units.${m[1]}.readings.${m[2]}`) || {};
    const u = getPath(S.draft.inputs, `units.${m[1]}.readingUnit`) || '';
    const el = $(`[data-calc="ull-${m[1]}-${m[2]}"]`);
    const ref = Number(r.ref), wet = Number(r.wet);
    if (el) el.textContent = r.ref !== '' && r.wet !== '' && r.ref != null && r.wet != null && Number.isFinite(ref) && Number.isFinite(wet) ? `${n2(ref - wet)} ${u}` : '–';
  }

  // Technical details for one tank or bunker (under "Show calculation details").
  function unitCalcHtml(x) {
    if (!x) return '';
    const m = x.measurement;
    const lines = [];
    let extra = '';
    if (x.status === 'empty') lines.push(['Quantity', `0.00 ${P()[x.product].unit}`]);
    if (m && x.product === 'CPO') {
      extra = `<div class="table-wrap"><table><thead><tr><th>Reading</th><th class="n">Ullage (mm)</th><th class="n">Observed volume (L)</th><th class="n">Quantity (MT)</th><th>Table lookup</th></tr></thead><tbody>
        ${m.readings.map((rd) => `<tr><td>${rd.n}</td><td class="n">${n2(rd.ullageMm)}</td><td class="n">${n2(rd.volumeL)}</td><td class="n">${n2(rd.mt)}</td><td class="small">${(rd.steps || []).map(esc).join('<br>')}</td></tr>`).join('')}</tbody></table></div>`;
      if (m.conversion) lines.push(['Conversion', esc(m.conversion.describe)]);
      if (m.spreadMm !== undefined) lines.push(['Spread of repeated ullages', `${n2(m.spreadMm)} mm`]);
      lines.push([`Adopted result (${esc(m.adoptedRule.label)}${m.adoptedRule.status !== 'confirmed' ? ', provisional' : ''})`, `${n2(m.volumeL)} L · <b>${n2(m.mt)} MT</b>`]);
    }
    if (m && x.product === 'PK') {
      extra = `<div class="table-wrap"><table><thead><tr><th>Point</th><th>Name</th><th class="n">Ullage (mm)</th><th class="n">Volume (L)</th></tr></thead><tbody>${m.points.map((pt) => `<tr><td>${pt.n}</td><td>${esc(pt.label)}</td><td class="n">${n2(pt.ullageMm)}</td><td class="n">${n2(pt.volumeL)}</td></tr>`).join('')}</tbody></table></div>`;
      lines.push(['Method', esc(m.adoptedMethod.label)]);
      lines.push(['Ullage used', `${n2(m.adoptedUllageMm)} mm`]);
      lines.push(['Volume', `${n2(m.volumeL)} L`]);
      if (m.steps && m.steps.length) lines.push(['Table lookup', m.steps.map(esc).join('<br>')]);
      if (m.density) lines.push(['Bulk density', `${esc(m.density.value)} kg/L${m.density.status !== 'confirmed' ? ' (awaiting confirmation)' : ''}`]);
      lines.push(['Quantity', `<b>${n2(m.mt)} MT</b> (litres × density ÷ 1,000)`]);
    }
    if (m && x.product === 'DSL') {
      lines.push(['Depth in mm', n2(m.dipMm)]);
      lines.push(['Volume at depth', `${n2(m.grossL)} L`]);
      if (m.steps && m.steps.length) lines.push(['Table lookup', m.steps.map(esc).join('<br>')]);
      if (m.waterNote) lines.push(['Water at the bottom', esc(m.waterNote)]);
      lines.push(['Net volume', `<b>${n2(m.netL)} L</b>`]);
    }
    if (x.status && x.status !== 'excluded' && (x.adjustment || x.movementLines.length)) lines.push(['Movements taking it back to the comparison time', `${signed(x.adjustment)} ${P()[x.product].unit}`]);
    const info = x.issues.filter((i) => i.level === 'info');
    return `${extra}${lines.length ? `<div class="calc-box">${lines.map(([k, v]) => `<div class="line"><span>${k}</span><b>${v}</b></div>`).join('')}</div>` : '<p class="muted small">Details appear once the readings are complete.</p>'}
      ${info.length ? `<ul class="issues small muted">${info.map((i) => `<li>${esc(i.text)}</li>`).join('')}</ul>` : ''}`;
  }
  function stockResultHtml(x) {
    const p = x.product, noun = NOUN[p];
    const label = `Calculated ${STOCK_WORD[p]} stock`;
    if (x.status === 'excluded') return `<div class="stock-result skip"><span class="sr-label">${esc(label)}</span><span class="sr-value">Not checked</span><span class="help">This ${noun} is left out of the total, so the ${STOCK_WORD[p]} result will be partial.</span></div>`;
    if (isNum(x.quantity)) return `<div class="stock-result" aria-live="polite"><span class="sr-label">${esc(label)}</span><span class="sr-value">${n2(x.quantity)}<small>${esc(unitWord(p))}</small></span>${x.status === 'empty' ? `<span class="help">Empty ${noun}.</span>` : '<span class="help">Calculated from the readings and the calibration table. It cannot be typed in.</span>'}</div>`;
    return `<div class="stock-result pending"><span class="sr-label">${esc(label)}</span><span class="sr-value">–<small>${esc(unitWord(p))}</small></span><span class="help">${x.status ? 'Complete the readings above to see the stock.' : `Choose what you found in this ${noun}.`}</span></div>`;
  }
  function unitIssuesHtml(x) {
    const items = x.issues.filter((i) => i.level !== 'info');
    if (!items.length) return '';
    const block = items.some((i) => i.level === 'block');
    return `<div class="notice ${block ? 'bad' : 'warn'}"><strong>${block ? 'Still needed' : 'Please check'}</strong><ul class="issues">${items.map((i) => `<li>${esc(i.text)}${i.gate ? ' <span class="small">(set in Calibration Tables)</span>' : ''}</li>`).join('')}</ul></div>`;
  }
  // Measured stock + stock sent out − stock added in = stock at the comparison time.
  function breakdownHtml(pr, r) {
    if (!isNum(pr.adjustedTotal) || !isNum(pr.measuredTotal)) return '';
    let out = 0, inn = 0;
    for (const code of pr.includedUnits || []) for (const ml of r.units[code].movementLines || []) { if (ml.adjustment > 0) out += ml.adjustment; else inn -= ml.adjustment; }
    const u = unitWord(pr.code);
    if (Math.abs(pr.measuredTotal + out - inn - pr.adjustedTotal) > 1e-6) return `<div class="breakdown">Measured stock ${n2(pr.measuredTotal)} ${signed(pr.adjustmentTotal)} movements = stock at the comparison time <b>${n2(pr.adjustedTotal)} ${u}</b></div>`;
    return `<div class="breakdown">Measured stock ${n2(pr.measuredTotal)} + stock sent out ${n2(out)} − stock added in ${n2(inn)} = stock at the comparison time <b>${n2(pr.adjustedTotal)} ${u}</b></div>`;
  }
  function productResultPanels(pr, r, inp) {
    const c = pr.comparison, u = unitWord(pr.code);
    const has = c.variance !== null && c.variance !== undefined;
    const dir = has ? c.direction : null;
    const dirText = { surplus: 'More than book stock', shortage: 'Less than book stock', nil: 'Matches book stock' }[dir] || '';
    const excl = (pr.excludedUnits || []).map((x) => x.name);
    return `<div class="result-panels">
        <div class="result-panel main"><span class="rp-label">Physical stock at ${esc(inp.cutoff ? fmtDT(inp.cutoff) : 'the comparison time')}</span><span class="rp-big">${n2(pr.adjustedTotal)}<small>${esc(u)}</small></span>
          ${pr.partial ? `<span class="pill warn" style="align-self:flex-start">Partial: ${esc(excl.join(', '))} not checked</span>` : ''}${pr.hasEstimates ? '<span class="pill warn" style="align-self:flex-start">Includes estimates</span>' : ''}</div>
        <div class="result-panel ${dir || ''}"><span class="rp-label">Difference from book stock</span><span class="rp-big">${has ? `${signed(c.variance)}<small>${esc(u)}</small>` : '–'}</span>
          ${has ? `<span class="rp-dir">${esc(dirText)}${isNum(c.variancePct) ? ` · ${pct(c.variancePct)}` : ''}</span><span class="help">Book stock ${n2(c.book)} ${esc(u)}${c.basis === 'matching_units' ? ' (book balances of the checked units only)' : ''}</span>` : ''}
          <div>${limitPill(pr.limitStatus)}</div></div></div>
      ${breakdownHtml(pr, r)}
      ${c.message ? `<div class="notice ${has ? 'info' : 'warn'}">${esc(c.message)}</div>` : ''}
      ${pr.issues.filter((i) => i.level === 'warn' || i.level === 'block').map((i) => `<div class="notice ${i.level === 'block' ? 'bad' : 'warn'}">${esc(i.text)}</div>`).join('')}
      <details class="more"><summary>Show calculation details</summary>${productResultsHtml({ products: { [pr.code]: pr }, units: r.units })}</details>`;
  }
  function gotoLabel(t) {
    if (t.settings) return t.settings === 'settings' ? 'Open calculation settings' : 'Open Calibration Tables';
    if (t.unit) return `Go to ${unitName(t.unit)}`;
    if (t.focus && t.focus.startsWith('mv-')) return 'Go to the movement';
    if (t.focus && t.focus.startsWith('book-')) return 'Go to book stock';
    return 'Go to step 1';
  }
  function reviewHtml(r) {
    const demo = S.draft.isDemo;
    const blocks = r.allIssues.filter((i) => i.level === 'block');
    const warns = r.allIssues.filter((i) => i.level === 'warn');
    const item = (i) => { const t = issueTarget(i); return `<li><span>${esc(i.text)}${demo && i.gate ? ' <span class="pill neutral">not required for a demonstration</span>' : ''}</span> <button type="button" class="btn-link" data-goto='${esc(JSON.stringify(t))}'>${esc(gotoLabel(t))}</button></li>`; };
    const ok = demo ? r.canFinaliseDemo : r.canFinalise;
    return `${blocks.length ? `<div class="notice ${ok ? 'warn' : 'bad'}"><strong>${ok ? 'Not needed for a demonstration' : `To finish before finalising (${blocks.length})`}</strong><ul class="check-list">${blocks.map(item).join('')}</ul></div>` : '<div class="notice good"><strong>Everything needed is filled in. You can finalise.</strong></div>'}
      ${warns.length ? `<details ${blocks.length ? '' : 'open'}><summary>Warnings and notes (${warns.length})</summary><ul class="check-list">${warns.map(item).join('')}</ul></details>` : ''}`;
  }
  function updateCalc() {
    const r = S.results;
    if (!r) return;
    const counts = stepIssues(r);
    $$('.progress button').forEach((b) => { const n = +b.dataset.step; let pill = $('.pill', b); if (counts[n]) { if (!pill) { pill = document.createElement('span'); pill.className = 'pill bad'; pill.title = 'Items to complete'; b.appendChild(pill); } pill.textContent = counts[n]; } else if (pill) pill.remove(); });
    const step1 = $('#calc-step1');
    if (step1) { const top = r.allIssues.filter((i) => issueTarget(i).step === 1 && i.level === 'block'); step1.innerHTML = top.length ? `<div class="notice warn"><strong>Still needed</strong><ul class="issues">${top.map((i) => `<li>${esc(i.text)}</li>`).join('')}</ul></div>` : ''; }
    const picker = $('#unitPicker'); if (picker) picker.innerHTML = unitPickerHtml(S.draft.inputs);
    for (const [code, x] of Object.entries(r.units)) {
      const el = $(`[data-calc="unit-${code}"]`); if (el) el.innerHTML = unitCalcHtml(x);
      const q = $(`[data-calc="qty-${code}"]`); if (q) q.innerHTML = stockResultHtml(x);
      const ui = $(`[data-calc="uissues-${code}"]`); if (ui) ui.innerHTML = unitIssuesHtml(x);
      const m = x.measurement;
      if (m && x.product === 'CPO') m.readings.forEach((rd, i) => {
        const c = $(`[data-calc="ull-${code}-${i}"]`);
        if (c && rd.ullage !== null) c.textContent = `${n2(rd.ullage)} ${rd.unit}${rd.unit !== 'mm' ? ` = ${n2(rd.ullageMm)} mm` : ''}`;
      });
      if (m && x.product === 'PK') m.points.forEach((pt, i) => { const a = $(`[data-calc="ptvol-${code}-${i}"]`); if (a) a.textContent = pt.volumeL !== null ? `${n2(pt.volumeL)} L` : '–'; });
    }
    r.movements.forEach((m, i) => {
      const el = $(`[data-calc="mv-${i}"]`);
      if (el) el.innerHTML = `${m.effects.length ? m.effects.map((e) => `<div class="line"><span>${esc(unitName(e.unit))}</span><span>${e.applied ? `<b>${signed(e.adjustment)} ${esc(m.qtyUnit)}</b> ` : '<b>Not counted</b> '}<span class="muted">(${esc(e.reason)})</span></span></div>`).join('') : '<span class="muted">Complete the entry to see how it is counted.</span>'}
        ${m.issues.filter((x) => x.level !== 'info').map((x) => `<div class="small" style="color:${x.level === 'block' ? 'var(--bad)' : 'var(--warn)'}">${esc(x.text)}</div>`).join('')}`;
      const q = $(`[data-calc="mvqty-${i}"]`); if (q) q.textContent = isNum(m.qty) ? `${n2(m.qty)} ${m.qtyUnit}` : '–';
    });
    for (const [p, pr] of Object.entries(r.products)) { const el = $(`[data-calc="result-${p}"]`); if (el) el.innerHTML = productResultPanels(pr, r, S.draft.inputs); }
    const rev = $('[data-calc="review"]'); if (rev) rev.innerHTML = reviewHtml(r);
    const fb = $('#finaliseBtn'); if (fb) { const ok = S.draft.isDemo ? r.canFinaliseDemo : r.canFinalise; fb.disabled = !ok; fb.title = ok ? '' : 'Finish the items listed under "Check and finalise" first.'; }
  }
  async function finalise() {
    const d = S.draft;
    const res = await modal({ title: 'Finalise this stock take?', body: `<p>Finalising freezes the readings, calibration table versions and settings used for ${esc(d.reference || 'this stock take')}. Later changes will not recalculate it. A correction will need a new revision with a reason.</p>${d.isDemo ? '<div class="notice info">This will be finalised as a demonstration only.</div>' : ''}`, actions: [{ label: 'Cancel', value: 'cancel' }, { label: 'Finalise', value: 'ok', primary: true }] });
    if (res.action !== 'ok') return;
    try {
      await saveDraft();
      await api('POST', `/api/audits/${d.id}/finalise`);
      S.dirty = false; toast('Stock take finalised.'); const id = d.id; S.draft = null; location.hash = `#/audit/${id}`;
    } catch (e) { fail(e); }
  }

  // ---------- settings ----------
  async function renderSettings(parts) {
    const tab = parts[0] || 'tables';
    const head = `<div class="page-head"><div><h1>Calibration Tables</h1><p class="muted">Each table follows its calibration PDF exactly. ${isAdmin() ? 'Changes create a new version; finalised stock takes keep the versions they used.' : 'Read only. Only an Admin can change calibration data and settings.'}</p></div></div>
      <nav class="tabs"><a href="#/settings" class="${['tables', 'unit', 'table'].includes(tab) ? 'active' : ''}">Tables</a><a href="#/settings/methods" class="${tab === 'methods' ? 'active' : ''}">Calculation settings</a><a href="#/settings/limits" class="${tab === 'limits' ? 'active' : ''}">Variance limits</a><a href="#/settings/sources" class="${tab === 'sources' ? 'active' : ''}">Source documents</a></nav>`;
    if (tab === 'tables') return renderTablesList(head);
    if (tab === 'unit') return renderTableDetail(head, parts[1], null, parts[2]);
    if (tab === 'table') return renderTableDetail(head, null, Number(parts[1]), parts[2]);
    if (tab === 'methods' || tab === 'limits') return renderMethods(head, tab);
    if (tab === 'sources') {
      const files = await api('GET', '/api/sources');
      const expected = ['CPO Tank No. 1 Table.pdf', 'CPO Tank No. 2 Table.pdf', 'CPO Tank No. 3 Table.pdf', 'PK Bunker No. 1 Table.pdf', 'PK Bunker No. 2 Table.pdf', 'Diesel Tank Table.pdf', 'MJM Mill Audit - HQ 23.06.2026 - Audit Result CPO 1.pdf'];
      const all = [...new Set([...expected, ...files])];
      app.innerHTML = `${head}<section class="panel"><h2>Original source documents</h2><p class="muted">Preserved exactly as supplied. PDFs imported with a new table version are listed with the storage unit and date in front of the name.</p>
        <div class="table-wrap"><table><thead><tr><th>Document</th><th>Status</th><th></th></tr></thead><tbody>${all.map((f) => `<tr><td>${esc(f)}</td><td>${files.includes(f) ? '<span class="pill good">Available</span>' : '<span class="pill warn">Not uploaded yet</span>'}</td><td>${files.includes(f) ? `<button type="button" class="btn-sm" data-src="${esc(f)}">Open</button>` : ''}</td></tr>`).join('')}</tbody></table></div>
        ${isAdmin() ? `<div class="stack"><h3>Upload source PDFs</h3><p class="small muted">Choose the original PDF files. Keep their file names exactly as listed above so each calibration table links to its document. Stored documents are never overwritten. To replace a calibration PDF, use <b>Import new version</b> on that table instead.</p><input type="file" id="srcFiles" accept="application/pdf" multiple><div id="srcOut"></div></div>` : ''}</section>`;
      $$('[data-src]').forEach((b) => (b.onclick = () => openSource(b.dataset.src)));
      const sf = $('#srcFiles');
      if (sf) sf.addEventListener('change', async () => {
        for (const file of sf.files) {
          $('#srcOut').innerHTML = `<p class="muted">Uploading ${esc(file.name)}…</p>`;
          try {
            const buf = new Uint8Array(await file.arrayBuffer());
            let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
            await api('POST', '/api/sources', { name: file.name, base64: btoa(bin) });
          } catch (e) { fail(e); }
        }
        toast('Upload finished.'); renderSettings(['sources']);
      });
    }
  }
  const STATUS_HELP = {
    ready: 'All entries were extracted and passed the import checks. The table is used for calculations.',
    needs_attention: 'Some entries could not be read or did not pass the import checks. Readings that need them are held; every other reading is calculated normally.',
  };
  async function renderTablesList(head) {
    const d = await api('GET', '/api/calibration');
    const todo = d.units.flatMap((u) => (u.active && u.active.importCheck ? u.active.importCheck.items.filter((i) => i.level === 'attention').map((i) => ({ u, i })) : []));
    app.innerHTML = `${head}<div class="notice info"><span>A table is available for calculations as soon as it is imported. Entries that cannot be read are never guessed; only readings that need them are held.</span></div>
      ${todo.length ? `<div class="notice warn"><strong>Entries to correct from the PDF (${todo.length})</strong><ul class="issues">${todo.map(({ u, i }) => `<li><a href="#/settings/table/${u.active.id}">${esc(u.name)}</a>: ${esc(i.text)}</li>`).join('')}</ul></div>` : ''}
      <div class="table-wrap"><table><thead><tr><th>Storage unit</th><th>Product</th><th>Active version</th><th>Status</th><th>Basis</th><th>Range (mm)</th><th>Report reference</th><th>Calibrated</th><th>Source PDF</th></tr></thead><tbody>
      ${d.units.map((u) => { const t = u.active; return `<tr class="clickable" data-href="#/settings/unit/${u.code}"><td><b>${esc(u.name)}</b></td><td><span class="product-tag ${u.product}">${esc(P()[u.product].short)}</span></td><td>v${t.version}</td><td>${statusPill(t.status)}${t.importCheck && t.importCheck.attention ? ` <span class="small muted">${t.importCheck.attention} to correct</span>` : ''}</td><td>${t.basis === 'dip' ? 'Dip depth' : 'Ullage'}</td><td class="n">${n0(t.validRange.min)}–${n0(t.validRange.max)}</td><td>${esc(t.reportReference)}</td><td>${fmtDate(t.calibrationDate)}</td><td class="small">${esc(t.sourceOriginalName || t.sourceFile)}</td></tr>`; }).join('')}
      </tbody></table></div>`;
    bindRowLinks();
  }

  // URL for showing a source PDF inside the page. Hosted: a short-lived link, loaded as a local copy.
  const pdfUrlCache = {};
  async function sourceFrameUrl(file) {
    if (pdfUrlCache[file]) return pdfUrlCache[file];
    const { url } = await api('GET', `/api/source-url/${encodeURIComponent(file)}`);
    if (!B) return (pdfUrlCache[file] = url);
    const res = await fetch(url);
    if (!res.ok) throw new Error('The source PDF could not be loaded.');
    return (pdfUrlCache[file] = URL.createObjectURL(new Blob([await res.arrayBuffer()], { type: 'application/pdf' })));
  }
  const pageOfRow = (t, mm) => { for (const p of t.pageMap || []) if (mm >= p.min && mm <= p.max) return p.page; return null; };
  const itemPage = (it) => it.page || (it.pages || [])[0] || null;

  async function renderTableDetail(head, unitCode, id, mode) {
    if (!id) { const d = await api('GET', '/api/calibration'); const u = d.units.find((x) => x.code === unitCode); if (!u) throw new Error('Unknown storage unit.'); id = u.active.id; }
    const t = await api('GET', `/api/calibration/${id}`);
    const all = await api('GET', '/api/calibration');
    const versions = all.units.find((u) => u.code === t.unitCode).versions;
    if (mode === 'edit' && isAdmin()) return renderTableEditor(head, t);
    const page = S.rowsPage[t.id] || 0;
    const PER = 150;
    const rows = t.rows;
    const pages = Math.ceil(rows.length / PER);
    const tp = t.tankDetails || {};
    const items = t.importCheck.items;
    const attention = items.filter((i) => i.level === 'attention');
    const notes = items.filter((i) => i.level === 'note');
    const heldRows = new Map(attention.filter((i) => i.kind === 'row').map((i) => [i.mm, i]));
    const heldParts = new Map(attention.filter((i) => i.kind === 'part').map((i) => [i.key, i]));
    const marks = new Map((t.sourceMarks || []).map((m) => [m.kind === 'row' ? `r${m.mm}` : `p${m.from}|${m.to}|${m.part}`, m]));
    const canFix = isAdmin() && t.isActive;
    const itemLi = (it, idx) => `<li><span class="pill warn">${itemPage(it) ? `PDF page ${itemPage(it)}` : 'Page not recorded'}</span> ${esc(it.text)}
      <span class="row">${itemPage(it) ? `<button type="button" class="btn-sm" data-pdfpage="${itemPage(it)}">Show page ${itemPage(it)}</button>` : ''}${canFix ? `<button type="button" class="btn-sm btn-primary" data-fix="${idx}">Enter value from PDF</button>` : ''}</span></li>`;
    app.innerHTML = `${head}
      <div class="page-head"><div><p><a href="#/settings">← All tables</a></p><h2 style="font-size:1.5rem">${esc(t.unitName)} · version ${t.version}</h2></div>
        <div class="row">${statusPill(t.status)}${t.isActive ? '<span class="pill info">Active</span>' : '<span class="pill neutral">Not active</span>'}
        <button type="button" id="pdfSideBtn">Show PDF beside table</button>
        <button type="button" id="srcBtn">Open PDF in new tab</button>
        <button type="button" id="tblCsvBtn">Export CSV</button>
        ${isAdmin() ? `<a class="btn" href="#/settings/table/${t.id}/edit">Import new version</a>${!t.isActive ? '<button id="activateBtn">Make this the active version</button>' : ''}` : ''}</div></div>
      <div class="split" id="split"><div class="split-main">
      ${t.status === 'ready' ? `<div class="notice good"><strong>Ready to use</strong><span>${STATUS_HELP.ready} Source: ${esc(t.sourceOriginalName || t.sourceFile)}.</span></div>`
        : `<section class="notice warn"><strong>Import needs attention: ${attention.length} ${attention.length === 1 ? 'entry' : 'entries'} to correct</strong><span>${STATUS_HELP.needs_attention}</span>
          <ul class="issues">${attention.map(itemLi).join('')}</ul>${!t.isActive ? '<span class="small">Corrections are made on the active version.</span>' : ''}</section>`}
      <div class="grid-2">
        <section class="panel"><h3>Calibration details</h3><dl class="kv">
          <dt>Storage unit</dt><dd>${esc(t.unitName)} (${esc(t.unitCode)})</dd>
          <dt>Measurement basis</dt><dd>${t.basis === 'dip' ? 'Dip depth (DIP)' : 'Ullage'}</dd>
          <dt>Measurement units</dt><dd>${esc(t.measurementUnit)}</dd><dt>Volume units</dt><dd>${esc(t.volumeUnit === 'L' ? 'litres' : t.volumeUnit)}</dd>
          <dt>Reference height</dt><dd>${n0(t.referenceHeightMm)} mm</dd>
          <dt>Valid range</dt><dd>${n0(t.validRange.min)} to ${n0(t.validRange.max)} mm (${n0(t.rowCount || rows.length)} rows)</dd>
          <dt>Calibration date</dt><dd>${fmtDate(t.calibrationDate)}</dd>
          <dt>Report reference</dt><dd>${esc(t.reportReference)}${t.jobCode ? ` (job ${esc(t.jobCode)})` : ''}</dd>
          ${t.reportIssueDate ? `<dt>Report issued</dt><dd>${fmtDate(t.reportIssueDate)}</dd>` : ''}
          ${t.reverificationDue ? `<dt>Re-verification due</dt><dd>${fmtDate(t.reverificationDue)}</dd>` : ''}
          <dt>Calibrated by</dt><dd>${esc(t.calibratedBy)}</dd><dt>Standard</dt><dd>${esc(t.standard)}</dd><dt>Method</dt><dd>${esc(t.method)}</dd>
          <dt>Table basis</dt><dd>${esc(t.tableBasisNote || '')}</dd>
          <dt>Source PDF</dt><dd>${esc(t.sourceOriginalName || t.sourceFile)}</dd>
          <dt>Source pages</dt><dd>${esc(Object.entries(t.sourcePages || {}).map(([k, v]) => `${k.replace(/([A-Z])/g, ' $1').toLowerCase()}: p${v.join(', ')}`).join('; '))}</dd>
          <dt>Version note</dt><dd>${esc(t.changeNote || '')} <span class="muted small">(${fmtDT(t.createdAt)}, ${esc(t.createdBy)})</span></dd>
        </dl></section>
        <section class="panel"><h3>Tank details from certificate</h3><dl class="kv">
          ${Object.entries(tp).map(([k, v]) => `<dt>${esc(k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).replace(/ Mm$/, ' (mm)').replace(/ L$/, ' (L)').replace(/ M$/, ' (m)').replace(/ C$/, ' (°C)'))}</dt><dd>${typeof v === 'number' ? v.toLocaleString('en-MY') : esc(v)}</dd>`).join('')}</dl>
          <h3>Lookup method (from the PDF)</h3><p>${esc(t.interpolationNote || '')}</p>
          <p class="small muted">Where the table gives no fractional parts, the volume is interpolated linearly between the printed rows and the result says so. Values outside the valid range are rejected; there is no extrapolation.</p>
        </section>
      </div>
      ${t.flags.length || notes.length ? `<section class="panel"><h3>Notes on the source document</h3><ul class="issues">${notes.map((i) => `<li><span class="pill neutral">${n0(i.from)}–${n0(i.to)} mm</span> ${esc(i.text)}</li>`).join('')}${t.flags.map((f) => `<li><span class="pill neutral">Note</span> ${esc(f.text)}</li>`).join('')}</ul></section>` : ''}
      <section class="panel"><h3>Try a lookup</h3><div class="row"><label class="field" style="max-width:260px"><span>${t.basis === 'dip' ? 'Dip' : 'Ullage'} (mm)</span><input type="text" inputmode="decimal" id="lkMm"></label><button id="lkBtn" style="align-self:flex-end">Look up</button></div><div id="lkOut"></div></section>
      ${(t.fractionalBands || []).length ? `<section class="panel"><h3>Fractional / proportional parts (litres)</h3><div class="table-wrap"><table><thead><tr><th>From (mm)</th><th>To (mm)</th>${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => `<th class="n">${k} mm</th>`).join('')}<th>PDF page</th></tr></thead><tbody>${t.fractionalBands.map((b) => `<tr><td>${n0(b.from)}</td><td>${n0(b.to)}</td>${b.parts.map((x, i) => { const key = `${b.from}|${b.to}|${i + 1}`; const m = marks.get(`p${key}`); const h = heldParts.get(key); return `<td class="n${h ? ' cell-flag' : ''}"${h ? ` title="${esc(h.text)}"` : ''}>${x === null ? `<span class="pill bad">${m && m.printed ? `“${esc(m.printed)}” unreadable` : 'unreadable'}</span>` : x}</td>`; }).join('')}<td>${(b.pages || []).map((pg) => `<button type="button" class="btn-link" data-pdfpage="${pg}">${pg}</button>`).join(' ') || '–'}</td></tr>`).join('')}</tbody></table></div></section>` : ''}
      <section class="panel"><div class="panel-head"><h3>Main table rows</h3><span class="spacer"></span><label class="field" style="flex-direction:row;align-items:center"><span class="small">Jump to mm</span><input type="text" inputmode="numeric" id="jump" style="width:120px;min-height:40px"></label></div>
        <div class="table-wrap"><table><thead><tr><th class="n">${t.basis === 'dip' ? 'Dip' : 'Ullage'} (mm)</th><th class="n">Volume (L)</th><th class="n">Change from previous row (L)</th><th>PDF page</th></tr></thead><tbody>
        ${rows.slice(page * PER, page * PER + PER).map(([h, v], i) => { const k = page * PER + i; const prev = k > 0 ? rows[k - 1][1] : null; const held = heldRows.get(h); const m = marks.get(`r${h}`); const pg = pageOfRow(t, h); return `<tr${held ? ` class="row-flag" title="${esc(held.text)}"` : ''}><td class="n">${n0(h)}</td><td class="n">${v === null ? `<span class="pill bad">${m && m.printed ? `“${esc(m.printed)}” unreadable` : 'unreadable'}</span>` : n0(v)}${held && v !== null ? ' <span class="pill warn">check</span>' : ''}</td><td class="n muted">${prev !== null && v !== null ? n0(v - prev) : ''}</td><td>${pg ? `<button type="button" class="btn-link" data-pdfpage="${pg}">${pg}</button>` : ''}</td></tr>`; }).join('')}
        </tbody></table></div>
        <div class="row"><button id="pgPrev" ${page === 0 ? 'disabled' : ''}>Previous rows</button><span class="muted">Rows ${page * PER + 1}–${Math.min(rows.length, page * PER + PER)} of ${rows.length}</span><button id="pgNext" ${page >= pages - 1 ? 'disabled' : ''}>Next rows</button></div></section>
      <section class="panel"><h3>Version history</h3><p class="small muted">Each import or correction is a new version. Finalised audits keep the version (and PDF) they used.</p><div class="table-wrap"><table><thead><tr><th>Version</th><th>Status</th><th>Active</th><th>Source PDF</th><th>Created</th><th>Note</th></tr></thead><tbody>
        ${versions.map((v) => `<tr class="clickable" data-href="#/settings/table/${v.id}"><td>v${v.version}</td><td>${statusPill(v.status)}</td><td>${v.isActive ? 'Yes' : ''}</td><td class="small">${esc(v.sourceFile || '')}</td><td class="small">${fmtDT(v.createdAt)}<br>${esc(v.createdBy)}</td><td class="small">${esc(v.changeNote || '')}</td></tr>`).join('')}</tbody></table></div></section>
      </div><aside class="split-pdf" id="pdfPane" hidden><div class="row"><b class="spacer">${esc(t.sourceOriginalName || t.sourceFile)}</b><button type="button" class="btn-sm" id="pdfClose">Close</button></div><iframe id="pdfFrame" title="Source PDF"></iframe></aside></div>`;
    bindRowLinks();
    const wide = () => window.matchMedia('(min-width: 1100px)').matches;
    const showPdf = async (pg) => {
      if (!wide()) { // phones and small tablets: open the PDF itself
        const w = pendingTab();
        try { const url = await sourceFrameUrl(t.sourceFile); if (w) w.location = url + (pg ? `#page=${pg}` : ''); } catch (e) { if (w) w.close(); fail(e); }
        return;
      }
      try {
        const url = await sourceFrameUrl(t.sourceFile);
        $('#split').classList.add('open'); $('#pdfPane').hidden = false;
        const f = $('#pdfFrame'); f.src = 'about:blank';
        setTimeout(() => { f.src = url + (pg ? `#page=${pg}` : ''); }, 30);
      } catch (e) { fail(e); }
    };
    $('#pdfSideBtn').onclick = () => showPdf(null);
    $('#pdfClose').onclick = () => { $('#split').classList.remove('open'); $('#pdfPane').hidden = true; $('#pdfFrame').src = 'about:blank'; };
    $$('[data-pdfpage]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); showPdf(Number(b.dataset.pdfpage)); }));
    $$('[data-fix]').forEach((b) => (b.onclick = async () => {
      const it = attention[Number(b.dataset.fix)];
      const where = it.kind === 'row' ? `Row ${n0(it.mm)} mm` : `Fractional parts ${n0(it.band.from)}–${n0(it.band.to)} mm, ${it.part} mm column`;
      if (itemPage(it)) showPdf(itemPage(it));
      const res = await modal({ title: 'Enter value from the PDF', body: `<p>${esc(where)}${itemPage(it) ? `, PDF page ${itemPage(it)}` : ''}.</p><p class="small muted">${esc(it.text)}</p>
        <label class="field"><span>Value exactly as printed in the PDF (litres)</span><input name="value" inputmode="decimal" value="${it.value ?? ''}"></label>
        <label class="field"><span>Note (optional)</span><input name="note" placeholder="For example: read from the paper original"></label>
        <p class="small muted">This saves a new version of the table. Enter the extracted value unchanged to record that it matches the PDF.</p>`,
      actions: [{ label: 'Cancel', value: 'cancel' }, { label: 'Save', value: 'save', primary: true }] });
      if (res.action !== 'save') return;
      const body = it.kind === 'row' ? { kind: 'row', mm: it.mm } : { kind: 'part', from: it.band.from, to: it.band.to, part: it.part };
      try { const nv = await api('POST', `/api/calibration/${t.id}/resolve`, { ...body, value: res.form.value, note: res.form.note }); toast(`Saved as version ${nv.version}. ${nv.status === 'ready' ? 'Ready to use.' : `${nv.importCheck.attention} still to correct.`}`); location.hash = `#/settings/table/${nv.id}`; } catch (e) { fail(e); }
    }));
    $('#srcBtn').onclick = () => openSource(t.sourceFile);
    $('#tblCsvBtn').onclick = () => downloadApi(`/api/calibration/${t.id}/export.csv`);
    $('#pgPrev').onclick = () => { S.rowsPage[t.id] = page - 1; renderTableDetail(head, null, t.id); };
    $('#pgNext').onclick = () => { S.rowsPage[t.id] = page + 1; renderTableDetail(head, null, t.id); };
    $('#jump').addEventListener('change', (e) => { const x = Number(e.target.value); if (!Number.isFinite(x)) return; const idx = rows.findIndex((r) => r[0] >= x); S.rowsPage[t.id] = Math.max(0, Math.floor((idx < 0 ? rows.length - 1 : idx) / PER)); renderTableDetail(head, null, t.id); });
    const doLookup = async () => {
      const mm = $('#lkMm').value.trim();
      try {
        const r = await api('GET', `/api/calibration/${t.id}/lookup?mm=${encodeURIComponent(mm)}`);
        $('#lkOut').innerHTML = r.ok ? `<div class="calc-box"><div class="line"><span>Volume</span><b>${n2(r.volume)} L</b></div>${r.steps.map((s) => `<div class="small">${esc(s)}</div>`).join('')}</div>${r.issues.map((i) => `<div class="notice ${i.level === 'block' ? 'bad' : i.level === 'warn' ? 'warn' : 'info'}">${esc(i.text)}</div>`).join('')}` : r.issues.map((i) => `<div class="notice bad">${esc(i.text)}</div>`).join('');
      } catch (e) { fail(e); }
    };
    $('#lkBtn').onclick = doLookup;
    $('#lkMm').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLookup(); });
    const ab = $('#activateBtn');
    if (ab) ab.onclick = async () => { try { await api('POST', `/api/calibration/${t.id}/activate`); toast('Version is now active.'); renderTableDetail(head, null, t.id); } catch (e) { fail(e); } };
  }
  function tableCsvText(t) {
    const marks = new Map((t.sourceMarks || []).map((m) => [m.kind === 'row' ? `r${m.mm}` : `p${m.from}|${m.to}|${m.part}`, m]));
    const cell = (v, key) => (v === null ? `${(marks.get(key) || {}).printed || ''}?` : v);
    const L = ['measurement_mm,volume_l,pdf_page', ...t.rows.map(([h, v]) => `${h},${cell(v, `r${h}`)},${pageOfRow(t, h) || ''}`)];
    if ((t.fractionalBands || []).length) { L.push('', 'fractional_from_mm,fractional_to_mm,1mm,2mm,3mm,4mm,5mm,6mm,7mm,8mm,9mm,pdf_pages'); for (const b of t.fractionalBands) L.push([b.from, b.to, ...b.parts.map((x, i) => cell(x, `p${b.from}|${b.to}|${i + 1}`)), (b.pages || []).join(';')].join(',')); }
    return L.join('\n');
  }
  async function fileBase64(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function renderTableEditor(head, t) {
    const F = (label, key, type = 'text') => `<label class="field"><span>${label}</span><input type="text" ${type === 'num' ? 'inputmode="decimal"' : ''} data-meta="${key}" data-type="${type}" value="${esc(t[key] ?? '')}"></label>`;
    app.innerHTML = `${head}<div class="page-head"><div><p><a href="#/settings/table/${t.id}">← Back to table</a></p><h2 style="font-size:1.5rem">Import a new version of ${esc(t.unitName)}</h2><p class="muted">Based on version ${t.version}. The new version is checked against the PDF rules and becomes the active table straight away. Finalised audits keep the version and PDF they used.</p></div></div>
      <section class="panel"><h3>Calibration PDF</h3>
        <p class="small muted">Current PDF: <b>${esc(t.sourceOriginalName || t.sourceFile)}</b>. To replace the calibration (for example after re-calibration), choose the new PDF and enter its values below. The current PDF is kept with the earlier version.</p>
        <input type="file" id="pdfFile" accept="application/pdf"></section>
      <section class="panel"><h3>Calibration details</h3><div class="grid">
        ${F('Report reference', 'reportReference')}${F('Calibration date (YYYY-MM-DD)', 'calibrationDate')}${F('Report issue date (YYYY-MM-DD)', 'reportIssueDate')}${F('Re-verification due (YYYY-MM-DD)', 'reverificationDue')}${F('Reference height (mm)', 'referenceHeightMm', 'num')}
        <label class="field"><span>Measurement basis</span><select data-meta="basis"><option value="ullage" ${t.basis === 'ullage' ? 'selected' : ''}>Ullage</option><option value="dip" ${t.basis === 'dip' ? 'selected' : ''}>Dip depth</option></select></label>
        <label class="field"><span>Volume unit</span><select data-meta="volumeUnit"><option value="L" ${t.volumeUnit === 'L' ? 'selected' : ''}>litres</option><option value="kg" ${t.volumeUnit === 'kg' ? 'selected' : ''}>kg (mass table)</option><option value="MT" ${t.volumeUnit === 'MT' ? 'selected' : ''}>MT (mass table)</option></select></label>
      </div>
      <label class="field"><span>Lookup method as stated in the PDF</span><textarea data-meta="interpolationNote" rows="3">${esc(t.interpolationNote || '')}</textarea></label></section>
      <section class="panel"><h3>Table values from the PDF (CSV)</h3><p class="small muted">One row per line: <code>measurement_mm,volume_l,pdf_page</code>. Fractional parts after a blank line: <code>fractional_from_mm,fractional_to_mm,1mm,…,9mm,pdf_pages</code>. Enter every value exactly as printed. If a value cannot be read, enter <code>?</code>, or the visible characters followed by <code>?</code> (for example <code>14_.7?</code>). Never guess: the entry is listed for correction with its page and row, and only readings that need it are held.</p>
        <input type="file" id="csvFile" accept=".csv,text/csv">
        <textarea class="code" id="csvText" rows="18">${esc(tableCsvText(t))}</textarea></section>
      <section class="panel"><label class="field"><span>What changed and why (required)</span><textarea id="chNote" rows="2" placeholder="For example: new calibration certificate after tank repair, or: corrected 6,710 mm from 1,984,768 to 1,984,788 L as printed on PDF page 10."></textarea></label>
        <div class="row end"><a class="btn" href="#/settings/table/${t.id}">Cancel</a><button class="btn-primary" id="saveVer">Import and check</button></div></section>`;
    $('#csvFile').addEventListener('change', async (e) => { const f = e.target.files[0]; if (f) $('#csvText').value = await f.text(); });
    $('#saveVer').onclick = async () => {
      const data = {};
      $$('[data-meta]').forEach((el) => { const v = el.value.trim(); data[el.dataset.meta] = el.dataset.type === 'num' ? (v === '' ? null : Number(v)) : (v || null); });
      const btn = $('#saveVer'); btn.disabled = true;
      try {
        const body = { data, csv: $('#csvText').value, note: $('#chNote').value };
        const pdf = $('#pdfFile').files[0];
        if (pdf) {
          if (String(body.note).trim().length < 5) throw new Error('Describe what changed in this version.');
          btn.textContent = 'Uploading PDF…';
          const up = await api('POST', '/api/sources', { name: pdf.name, base64: await fileBase64(pdf), unit: t.unitCode });
          Object.assign(body, { sourceFile: up.name, sourceOriginalName: pdf.name });
        }
        btn.textContent = 'Checking…';
        const nv = await api('POST', `/api/calibration/unit/${t.unitCode}/versions`, body);
        toast(`Version ${nv.version} imported: ${nv.status === 'ready' ? 'Ready to use.' : `Import needs attention (${nv.importCheck.attention} to correct).`}`);
        location.hash = `#/settings/table/${nv.id}`;
      } catch (e) { fail(e); btn.disabled = false; btn.textContent = 'Import and check'; }
    };
  }

  async function renderMethods(head, tab) {
    const s = await api('GET', '/api/settings');
    S.settingsCache = s.data;
    const d = JSON.parse(JSON.stringify(s.data));
    const dis = isAdmin() ? '' : 'disabled';
    const stSel = (path, v) => `<select data-s="${path}" ${dis}><option value="pending" ${v !== 'confirmed' ? 'selected' : ''}>Awaiting confirmation</option><option value="confirmed" ${v === 'confirmed' ? 'selected' : ''}>Confirmed by the mill</option></select>`;
    const c = d.cpo.conversion;
    const methods = tab === 'methods' ? `
      <section class="panel"><h2>CPO temperature / density conversion</h2>
        ${!c.rows.length ? '<div class="notice bad"><strong>CPO temperature conversion setup required.</strong></div>' : ''}
        <p class="small muted">Source: ${esc(c.source || 'none')}. ${esc(c.note || '')}</p>
        <div class="grid">
          <label class="field"><span>Method</span><select data-s="cpo.conversion.method" ${dis}><option value="density_table" ${c.method === 'density_table' ? 'selected' : ''}>Density in kg/litre at measured temperature</option><option value="vcf_table" ${c.method === 'vcf_table' ? 'selected' : ''}>Dimensionless VCF, then density at reference temperature</option></select></label>
          <label class="field"><span>Temperatures between table rows</span><select data-s="cpo.conversion.temperatureRule" ${dis}><option value="linear" ${c.temperatureRule === 'linear' ? 'selected' : ''}>Interpolate linearly</option><option value="nearest" ${c.temperatureRule === 'nearest' ? 'selected' : ''}>Use the nearest whole degree</option><option value="exact" ${c.temperatureRule === 'exact' ? 'selected' : ''}>Exact table rows only</option></select></label>
          <label class="field"><span>Reference density (VCF method only)</span><div class="unit-suffix"><input type="text" inputmode="decimal" data-s="cpo.conversion.referenceDensity" data-num="1" value="${esc(c.referenceDensity ?? '')}" ${dis}><span>kg/L</span></div></label>
          <label class="field"><span>Reference temperature (VCF method only)</span><div class="unit-suffix"><input type="text" inputmode="decimal" data-s="cpo.conversion.referenceTempC" data-num="1" value="${esc(c.referenceTempC ?? '')}" ${dis}><span>°C</span></div></label>
          <label class="field"><span>Status</span>${stSel('cpo.conversion.status', c.status)}</label>
        </div>
        <div class="notice info small">Density method: MT = observed litres × density at the measured temperature ÷ 1,000. VCF method: standard litres = observed litres × VCF; MT = standard litres × reference density ÷ 1,000. A VCF is never used as a density, and temperature correction is applied only once.</div>
        <label class="field"><span>Conversion table <span class="hint">One row per line: temperature °C, value. Paste or load a CSV.</span></span><textarea class="code" id="convRows" ${dis}>${esc(c.rows.map((r) => r.join(',')).join('\n'))}</textarea></label>
        ${isAdmin() ? '<input type="file" id="convFile" accept=".csv,text/csv">' : ''}
      </section>
      <section class="panel"><h2>CPO repeated readings</h2><div class="grid">
        <label class="field"><span>Adopted result rule</span><select data-s="cpo.adoptedRule.value" ${dis}>${Object.entries(S.meta.cpoAdoptedRules).map(([k, l]) => `<option value="${k}" ${d.cpo.adoptedRule.value === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        <label class="field"><span>Status</span>${stSel('cpo.adoptedRule.status', d.cpo.adoptedRule.status)}</label>
        <label class="field"><span>Warn when repeated ullages differ by more than <span class="hint">Blank = no warning</span></span><div class="unit-suffix"><input type="text" inputmode="decimal" data-s="cpo.repeatTolerance.ullageMm" data-num="1" value="${esc(d.cpo.repeatTolerance.ullageMm ?? '')}" ${dis}><span>mm</span></div></label>
      </div><p class="small muted">${esc(d.cpo.adoptedRule.note || '')}</p></section>
      <section class="panel"><h2>Palm kernel</h2>
        ${Object.entries(d.pk.density).map(([code, x]) => `<div class="unit-card p-PK"><h3>${esc(unitName(code))} bulk density</h3><p class="small muted">Source: ${esc(x.source)}</p><div class="grid">
          <label class="field"><span>Bulk density</span><div class="unit-suffix"><input type="text" inputmode="decimal" data-s="pk.density.${code}.value" data-num="1" value="${esc(x.value ?? '')}" ${dis}><span>kg/L</span></div></label>
          <label class="field"><span>Status</span>${stSel(`pk.density.${code}.status`, x.status)}</label></div>
          <label class="check"><input type="checkbox" data-s="pk.density.${code}.wordingConfirmed" data-bool="1" ${x.wordingConfirmed ? 'checked' : ''} ${dis}> Confirmed that this value is the palm kernel bulk density for this bunker${code === 'PK-B1' ? ' (the cover says "kernel shell density")' : ''}</label>
          <p class="small">${esc(x.note || '')}</p></div>`).join('')}
        <div class="grid"><label class="field"><span>Approved PK sampling and averaging method</span><select data-s="pk.samplingMethod.value" ${dis}>${Object.entries(S.meta.pkSamplingMethods).map(([k, l]) => `<option value="${k}" ${d.pk.samplingMethod.value === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
          <label class="field"><span>Status</span>${stSel('pk.samplingMethod.status', d.pk.samplingMethod.status)}</label></div>
        <label class="field"><span>Description of the approved method</span><textarea data-s="pk.samplingMethod.note" ${dis}>${esc(d.pk.samplingMethod.note || '')}</textarea></label>
        <p class="small muted">PK: MT = litres × bulk density ÷ 1,000. No CPO temperature correction is applied. If a bunker table returns mass, density is not applied again.</p>
      </section>
      <section class="panel"><h2>Diesel</h2><p>Diesel is reported in litres straight from the dip table. No density and no temperature correction. Water bottom (optional): net litres = volume at product dip − volume at water dip.</p></section>` : `
      <section class="panel"><h2>Variance limits</h2><p>Set separate lower and upper limits for each product, as a percentage of book stock. Leave both blank to show "Variance limits not set". The June report's "Benchmark −0.5%" has not been turned into a limit.</p>
        ${Object.values(P()).map((p) => `<div class="unit-card p-${p.code}"><h3>${esc(p.name)}</h3><div class="grid">
          <label class="field"><span>Lower limit</span><div class="unit-suffix"><input type="text" inputmode="decimal" data-s="varianceLimits.${p.code}.lowerPct" data-num="1" value="${esc(d.varianceLimits[p.code].lowerPct ?? '')}" placeholder="e.g. -0.5" ${dis}><span>%</span></div></label>
          <label class="field"><span>Upper limit</span><div class="unit-suffix"><input type="text" inputmode="decimal" data-s="varianceLimits.${p.code}.upperPct" data-num="1" value="${esc(d.varianceLimits[p.code].upperPct ?? '')}" placeholder="e.g. 0.5" ${dis}><span>%</span></div></label></div></div>`).join('')}
      </section>`;
    app.innerHTML = `${head}${methods}
      ${isAdmin() ? `<section class="panel"><label class="field"><span>What changed and why (required)</span><input type="text" id="setNote" placeholder="For example: mill confirmed CPO density table and nearest-degree rule"></label><div class="row end"><button class="btn-primary" id="saveSettings">Save settings (new version)</button></div></section>` : ''}
      <section class="panel"><h3>Settings history</h3><div class="table-wrap"><table><thead><tr><th>Version</th><th>Saved</th><th>By</th><th>Note</th></tr></thead><tbody>${s.history.map((h) => `<tr><td>v${h.version}${h.version === s.version ? ' (current)' : ''}</td><td>${fmtDT(h.created_at)}</td><td>${esc(h.created_by)}</td><td>${esc(h.change_note)}</td></tr>`).join('')}</tbody></table></div></section>`;
    const cf = $('#convFile'); if (cf) cf.addEventListener('change', async (e) => { const f = e.target.files[0]; if (f) $('#convRows').value = await f.text(); });
    const sb = $('#saveSettings');
    if (sb) sb.onclick = async () => {
      const errs = [];
      $$('[data-s]').forEach((el) => {
        let v;
        if (el.dataset.bool) v = el.checked;
        else if (el.dataset.num) { const t = el.value.trim(); v = t === '' ? null : Number(t); if (t !== '' && !Number.isFinite(v)) errs.push(`"${t}" is not a number.`); }
        else v = el.value;
        setPath(d, el.dataset.s, v);
      });
      const cr = $('#convRows');
      if (cr) {
        const rows = [];
        cr.value.split(/\r?\n/).forEach((ln, i) => { const s2 = ln.trim(); if (!s2 || s2.startsWith('#') || /^[a-z]/i.test(s2)) return; const [a, b] = s2.split(/[,;\t ]+/).map(Number); if (!Number.isFinite(a) || !Number.isFinite(b)) errs.push(`Conversion table line ${i + 1} is not two numbers.`); else rows.push([a, b]); });
        d.cpo.conversion.rows = rows.sort((x, y) => x[0] - y[0]);
      }
      if (errs.length) return fail(new Error(errs.slice(0, 10).join('\n') + '\n'));
      try { await api('PUT', '/api/settings', { data: d, note: $('#setNote').value }); toast('Settings saved as a new version.'); renderMethods(head, tab); } catch (e) { fail(e); }
    };
  }

  // ---------- users, account, backup ----------
  async function renderUsers() {
    if (!isAdmin()) { app.innerHTML = '<div class="notice warn">Only an Admin can manage users.</div>'; return; }
    const users = await api('GET', '/api/users');
    app.innerHTML = `<div class="page-head"><div><h1>Users</h1><p class="muted">Admin: everything, including settings, calibration and backups. Auditor: create, edit and finalise audits. Viewer: read only.</p></div></div>
      <div class="table-wrap"><table><thead><tr><th>Username</th><th>Name</th><th>Role</th><th>Active</th><th></th></tr></thead><tbody>
      ${users.map((u) => `<tr><td>${esc(u.username)}</td><td>${esc(u.displayName)}</td><td><select data-role-for="${u.id}">${['admin', 'auditor', 'viewer'].map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${r[0].toUpperCase() + r.slice(1)}</option>`).join('')}</select></td><td><label class="check"><input type="checkbox" data-active-for="${u.id}" ${u.active ? 'checked' : ''}> Active</label></td><td><button class="btn-sm" data-reset="${u.id}">Reset password</button></td></tr>`).join('')}
      </tbody></table></div>
      <form class="panel" id="addUser"><h2>Add a user</h2><div class="grid">
        <label class="field"><span>Username</span><input type="text" name="username" required></label>
        <label class="field"><span>Full name</span><input type="text" name="displayName" required></label>
        <label class="field"><span>Role</span><select name="role"><option value="auditor">Auditor</option><option value="viewer">Viewer</option><option value="admin">Admin</option></select></label>
        <label class="field"><span>Temporary password <span class="hint">At least 8 characters</span></span><input type="text" name="password" required></label>
      </div><div class="row end"><button class="btn-primary">Add user</button></div></form>`;
    $$('[data-role-for]').forEach((el) => el.addEventListener('change', async () => { try { await api('PUT', `/api/users/${el.dataset.roleFor}`, { role: el.value }); toast('Role updated.'); } catch (e) { fail(e); renderUsers(); } }));
    $$('[data-active-for]').forEach((el) => el.addEventListener('change', async () => { try { await api('PUT', `/api/users/${el.dataset.activeFor}`, { active: el.checked }); toast(el.checked ? 'User activated.' : 'User deactivated.'); } catch (e) { fail(e); renderUsers(); } }));
    $$('[data-reset]').forEach((el) => el.addEventListener('click', async () => {
      const r = await modal({ title: 'Reset password', body: '<label class="field"><span>New password (at least 8 characters)</span><input type="text" name="pw"></label>', actions: [{ label: 'Cancel', value: 'cancel' }, { label: 'Reset', value: 'ok', primary: true }] });
      if (r.action === 'ok') try { await api('PUT', `/api/users/${el.dataset.reset}`, { password: r.form.pw }); toast('Password reset. The user must sign in again.'); } catch (e) { fail(e); }
    }));
    $('#addUser').addEventListener('submit', async (e) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); try { await api('POST', '/api/users', f); toast('User added.'); renderUsers(); } catch (err) { fail(err); } });
  }
  function renderAccount() {
    app.innerHTML = `<form class="panel" id="pwForm" style="max-width:520px"><h1>Your account</h1><p>${esc(S.user.displayName)} · ${esc(S.user.username)} · ${esc(S.user.role)}</p>
      <label class="field"><span>Current password</span><input type="password" name="current" autocomplete="current-password" required></label>
      <label class="field"><span>New password <span class="hint">At least 8 characters</span></span><input type="password" name="next" autocomplete="new-password" required></label>
      <div class="row end"><button class="btn-primary">Change password</button></div></form>`;
    $('#pwForm').addEventListener('submit', async (e) => { e.preventDefault(); try { await api('POST', '/api/me/password', Object.fromEntries(new FormData(e.target))); toast('Password changed.'); e.target.reset(); } catch (err) { fail(err); } });
  }
  function renderBackup() {
    if (!isAdmin()) { app.innerHTML = '<div class="notice warn">Only an Admin can back up and restore.</div>'; return; }
    app.innerHTML = `<div class="page-head"><div><h1>Backup and restore</h1></div></div>
      <section class="panel"><h2>Download a backup</h2><p>A single file with all audits, snapshots, calibration versions, settings${B ? ' and history (staff sign-in accounts are managed separately and are not part of the file)' : ', users and history'}. It includes a checksum so damage or tampering is detected on restore. Keep backups somewhere safe.</p><div><button type="button" class="btn-primary" id="bkDownload">Download backup</button></div></section>
      <section class="panel"><h2>Restore from a backup</h2><div class="notice warn">Restoring replaces <b>all</b> current data with the backup and signs everyone out.</div>
        <input type="file" id="bkFile" accept=".json,application/json"><div id="bkOut"></div></section>`;
    $('#bkDownload').onclick = () => downloadApi('/api/backup');
    $('#bkFile').addEventListener('change', async (e) => {
      const f = e.target.files[0]; if (!f) return;
      let b; try { b = JSON.parse(await f.text()); } catch { $('#bkOut').innerHTML = '<div class="notice bad">This file is not valid JSON.</div>'; return; }
      try {
        const v = await api('POST', '/api/restore', b);
        $('#bkOut').innerHTML = `<div class="notice good"><strong>Backup is valid.</strong><span>Created ${fmtDT(v.createdAt)} by ${esc(v.createdBy)}. Contains: ${Object.entries(v.summary).map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`).join(', ')}.</span></div>
          <label class="check"><input type="checkbox" id="bkConfirm"> I understand that all current data will be replaced.</label><div><button class="btn-danger" id="bkGo">Restore this backup</button></div>`;
        $('#bkGo').onclick = async () => {
          if (!$('#bkConfirm').checked) return toast('Tick the box to confirm.', true);
          try { await api('POST', '/api/restore', { ...b, confirm: true }); if (B) { toast('Backup restored.'); location.hash = '#/'; route(); } else { S.user = null; renderLogin('Backup restored. Please sign in again.'); } } catch (err) { fail(err); }
        };
      } catch (err) { $('#bkOut').innerHTML = `<div class="notice bad" style="white-space:pre-line">${esc(err.message)}</div>`; }
    });
  }

  // ---------- start ----------
  (async () => {
    if (B) {
      try { if ((await B.setupStatus()).needsSetup) return renderSetup(); } catch (e) { app.innerHTML = `<div class="notice bad login"><strong>Cannot reach the server.</strong><span>${esc(e.message)}</span><button type="button" id="retryBtn">Try again</button></div>`; $('#retryBtn').onclick = () => location.reload(); return; }
    }
    try { const r = await api('GET', '/api/me'); S.user = r.user; } catch { /* not signed in */ }
    if (!S.user) return renderLogin();
    try { const s = await api('GET', '/api/settings'); S.settingsCache = s.data; } catch { /* ignore */ }
    boot();
  })();
})();
