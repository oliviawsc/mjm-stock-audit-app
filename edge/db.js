// PostgreSQL access for the Edge Function, with the same small interface as server/db.js.
// Tables are in the private "mjm_audit" schema; queries use ? placeholders.
import postgres from 'npm:postgres@3.4.5';
import { AsyncLocalStorage } from 'node:async_hooks';

const TABLES_WITH_ID = ['users', 'calibration_tables', 'settings_versions', 'audits', 'audit_events'];

export function openDb(url, schema = 'mjm_audit') {
  const sql = postgres(url, {
    prepare: false, // works through Supabase's transaction pooler
    max: 3,
    idle_timeout: 20,
    connection: { application_name: 'mjm-stock-audit-api' },
    types: { bigint: { to: 20, from: [20], serialize: (x) => String(x), parse: (x) => Number(x) } },
  });
  const als = new AsyncLocalStorage();
  const conv = (text) => { let i = 0; return text.replace(/\?/g, () => `$${++i}`); };
  // Every statement runs with the schema on the search path. Inside a transaction it is set once.
  async function exec(text, args) {
    const tx = als.getStore();
    if (tx) return tx.unsafe(conv(text), args);
    return sql.begin(async (t) => { await t.unsafe(`SET LOCAL search_path TO ${schema}`); return t.unsafe(conv(text), args); });
  }
  return {
    kind: 'postgres',
    schema,
    like: 'ILIKE',
    q(text) {
      return {
        get: async (...a) => (await exec(text, a))[0],
        all: async (...a) => [...(await exec(text, a))],
        run: async (...a) => {
          const m = text.match(/^\s*INSERT\s+INTO\s+(\w+)/i);
          const ret = m && TABLES_WITH_ID.includes(m[1]) && !/RETURNING/i.test(text);
          const r = await exec(ret ? `${text} RETURNING id` : text, a);
          return { lastInsertRowid: ret ? r[0].id : undefined, changes: r.count };
        },
      };
    },
    async tx(fn) {
      if (als.getStore()) return fn();
      return sql.begin(async (t) => { await t.unsafe(`SET LOCAL search_path TO ${schema}`); return als.run(t, fn); });
    },
    async columns(table) {
      return (await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = ${schema} AND table_name = ${table}`).map((r) => r.column_name);
    },
    // Lets the audit protection triggers allow the restore's deletes (this transaction only).
    async beforeRestore() { await exec("SELECT set_config('mjm.restoring', 'on', true)", []); },
    async afterRestore() {
      for (const t of TABLES_WITH_ID) await exec(`SELECT setval(pg_get_serial_sequence('${schema}.${t}', 'id'), COALESCE((SELECT MAX(id) FROM ${t}), 0) + 1, false)`, []);
    },
    async close() { await sql.end(); },
  };
}
