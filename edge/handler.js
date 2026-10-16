// Request handler for the "api" Supabase Edge Function. Platform-independent so it can be
// tested locally: everything that touches Supabase (auth, storage) arrives through `deps`.
//
// deps = {
//   db,                                   // see db.js (q, tx, columns, afterRestore, like)
//   auth: { getUserId(token), createUser(email, password), updatePassword(id, pw),
//           verifyPassword(email, pw), deleteUser(id) },
//   storage: { list(), signedUrl(name), upload(name, bytes) },
//   sha256(text) -> hex, loginEmail(username) -> email
// }
import { load } from './bundle.js';

const { createRoutes, HttpError, ROLE_RANK } = load('server/routes');
const { nowKuching } = load('lib/time');
const { defaultSettings } = load('lib/settings-default');
const { juneDemoInputs } = load('lib/demo');
const { UNITS } = load('lib/units');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Expose-Headers': 'content-disposition',
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
const publicUser = (u) => ({ id: u.id, username: u.username, displayName: u.display_name, role: u.role, active: !!u.active });

export function makeHandler(deps) {
  const { db, auth, storage, sha256, loginEmail } = deps;
  const q = (sql) => db.q(sql);
  const routes = createRoutes({ db, sha256, backupUsers: false });

  async function currentUser(req) {
    const h = req.headers.get('authorization') || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!token) return null;
    const authId = await auth.getUserId(token);
    if (!authId) return null;
    const u = await q('SELECT * FROM users WHERE auth_id = ?').get(authId);
    return u && u.active ? u : null;
  }

  async function userCount() { return Number((await q('SELECT COUNT(*) AS n FROM users').get()).n); }

  function checkSetupTables(t) {
    if (!t || !Array.isArray(t.tables) || !t.cpoDensityTable) throw new HttpError(400, 'Calibration data is missing from the setup request.');
    for (const u of UNITS) {
      const x = t.tables.find((y) => y.unitCode === u.code);
      if (!x || !Array.isArray(x.rows) || x.rows.length < 2 || !x.validRange) throw new HttpError(400, `Calibration table for ${u.name} is missing or damaged.`);
    }
  }

  async function seedData(tables, now) {
    if (!Number((await q('SELECT COUNT(*) AS n FROM calibration_tables').get()).n)) {
      for (const u of UNITS) {
        const t = tables.tables.find((y) => y.unitCode === u.code);
        await q('INSERT INTO calibration_tables (unit_code, version, status, is_active, data, change_note, created_at, created_by) VALUES (?,?,?,?,?,?,?,?)')
          .run(u.code, 1, 'verified', 1, JSON.stringify({ ...t, version: 1, status: 'verified' }), 'Version 1: figures exactly as printed in the supplied calibration PDF.', now, 'system import');
      }
    }
    if (!Number((await q('SELECT COUNT(*) AS n FROM settings_versions').get()).n)) {
      await q('INSERT INTO settings_versions (version, data, change_note, created_at, created_by) VALUES (?,?,?,?,?)')
        .run(1, JSON.stringify(defaultSettings(tables.cpoDensityTable)), 'Initial settings. Source-derived values awaiting confirmation.', now, 'system import');
    }
    if (!Number((await q('SELECT COUNT(*) AS n FROM audits WHERE is_demo = 1').get()).n)) {
      const inputs = juneDemoInputs();
      const r = await q('INSERT INTO audits (reference, revision, is_demo, status, inputs, audit_date, products, created_by, created_at, updated_by, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run('DEMO-2026-06-23-CPO', 0, 1, 'draft', JSON.stringify(inputs), inputs.auditDate, inputs.products.join(','), 'system', now, 'system', now);
      await q('INSERT INTO audit_events (audit_id, at, user_name, action, detail) VALUES (?,?,?,?,?)').run(r.lastInsertRowid, now, 'system', 'created', JSON.stringify({ note: 'June 2026 CPO demonstration loaded' }));
    }
  }

  function validNewUser(b) {
    const username = String(b.username || '').trim().toLowerCase();
    if (!USERNAME_RE.test(username)) throw new HttpError(400, 'Username: 3 to 32 letters, numbers, dots, dashes or underscores.');
    if (String(b.password || '').length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
    return { username, displayName: String(b.displayName || username).trim() || username, password: String(b.password) };
  }

  async function createAccount({ username, displayName, password }, role) {
    if (await q('SELECT id FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'That username is taken.');
    const authId = await auth.createUser(loginEmail(username), password);
    try {
      await q('INSERT INTO users (auth_id, username, display_name, role, active, created_at) VALUES (?,?,?,?,?,?)').run(authId, username, displayName, role, 1, nowKuching());
    } catch (e) { await auth.deleteUser(authId).catch(() => {}); throw e; }
  }

  async function special(method, path, body, req) {
    // ---- public: first-time setup ----
    if (method === 'GET' && path === '/setup-status') return json({ needsSetup: (await userCount()) === 0 });
    if (method === 'POST' && path === '/setup') {
      const nu = validNewUser(body);
      checkSetupTables(body.tables);
      const now = nowKuching();
      await db.tx(async () => {
        await q('SELECT pg_advisory_xact_lock(4242)').get();
        if ((await userCount()) > 0) throw new HttpError(409, 'Setup has already been completed. Sign in instead.');
        await seedData(body.tables, now);
        await createAccount(nu, 'admin');
      });
      return json({ ok: true }, 201);
    }

    const user = await currentUser(req);
    if (method === 'GET' && path === '/me') return json({ user: user ? publicUser(user) : null });
    if (!user) throw new HttpError(401, 'Please sign in.');
    const need = (role) => { if (ROLE_RANK[user.role] < ROLE_RANK[role]) throw new HttpError(403, `This action needs the ${role === 'admin' ? 'Admin' : 'Auditor'} role.`); };

    if (method === 'POST' && path === '/me/password') {
      if (String(body.next || '').length < 8) throw new HttpError(400, 'New password must be at least 8 characters.');
      if (!(await auth.verifyPassword(loginEmail(user.username), String(body.current || '')))) throw new HttpError(400, 'Current password is incorrect.');
      await auth.updatePassword(user.auth_id, String(body.next));
      return json({ ok: true });
    }

    // ---- users (Admin) ----
    if (path === '/users' && method === 'GET') { need('admin'); return json((await q('SELECT * FROM users ORDER BY username').all()).map(publicUser)); }
    if (path === '/users' && method === 'POST') {
      need('admin');
      if (!ROLE_RANK[body.role]) throw new HttpError(400, 'Choose a role.');
      await createAccount(validNewUser(body), body.role);
      return json({ ok: true }, 201);
    }
    const um = path.match(/^\/users\/(\d+)$/);
    if (um && method === 'PUT') {
      need('admin');
      const u = await q('SELECT * FROM users WHERE id = ?').get(Number(um[1]));
      if (!u) throw new HttpError(404, 'User not found.');
      const { displayName, role, active, password } = body;
      if (role && !ROLE_RANK[role]) throw new HttpError(400, 'Unknown role.');
      const willBeAdmin = (role || u.role) === 'admin' && (active === undefined ? !!u.active : !!active);
      if (u.role === 'admin' && !willBeAdmin && Number((await q("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get()).n) <= 1) throw new HttpError(400, 'At least one active Admin is required.');
      if (password !== undefined && password !== null && password !== '') {
        if (String(password).length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
        await auth.updatePassword(u.auth_id, String(password));
      }
      await q('UPDATE users SET display_name = ?, role = ?, active = ? WHERE id = ?').run(String(displayName || u.display_name), role || u.role, active === undefined ? u.active : (active ? 1 : 0), u.id);
      return json({ ok: true });
    }

    // ---- source PDFs (private storage, short-lived links) ----
    if (method === 'GET' && path === '/sources') return json(await storage.list());
    const sm = path.match(/^\/source-url\/(.+)$/);
    if (method === 'GET' && sm) return json({ url: await storage.signedUrl(decodeURIComponent(sm[1])) });
    if (method === 'POST' && path === '/sources') {
      need('admin');
      const name = String(body.name || '').replace(/[\\/]/g, '').trim();
      if (!/\.pdf$/i.test(name)) throw new HttpError(400, 'Only PDF files can be uploaded.');
      const bytes = Uint8Array.from(atob(String(body.base64 || '')), (c) => c.charCodeAt(0));
      if (bytes.length < 5 || String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') throw new HttpError(400, 'That file is not a PDF.');
      await storage.upload(name, bytes);
      return json({ ok: true }, 201);
    }
    return { user };
  }

  return async function handle(req) {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    try {
      const url = new URL(req.url);
      const path = url.pathname.replace(/^(\/functions\/v1)?\/api/, '') || '/';
      let body = {};
      if (req.method !== 'GET' && req.method !== 'DELETE') {
        const text = await req.text();
        if (text) { try { body = JSON.parse(text); } catch { throw new HttpError(400, 'The request was not valid JSON.'); } }
      }
      const s = await special(req.method, path, body, req);
      if (s instanceof Response) return s;
      const r = await routes({ method: req.method, path, query: Object.fromEntries(url.searchParams), body, user: s.user });
      if (!r) return json({ error: 'Not found.' }, 404);
      if (r.text !== undefined) {
        const headers = { ...CORS, 'Content-Type': r.contentType };
        if (r.filename) headers['Content-Disposition'] = `attachment; filename="${r.filename}"`;
        return new Response(r.text, { status: r.status || 200, headers });
      }
      return json(r.json, r.status || 200);
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      return json({ error: status === 500 ? 'Something went wrong on the server. Try again; if it keeps happening, tell your Admin.' : e.message }, status);
    }
  };
}
