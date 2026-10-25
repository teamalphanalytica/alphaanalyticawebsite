// Test-only adapter: runs the tagged-template SQL through psql against a local Postgres.
import { execFileSync } from "node:child_process";
const HOST = process.env.PGHOST || "/tmp";
const PORT = process.env.PGPORT || "5432";
const lit = (v) => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (v instanceof Date) return `'${v.toISOString()}'::timestamptz`;
  if (Array.isArray(v)) return v.length ? `ARRAY[${v.map(lit).join(",")}]` : "'{}'";
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
};
export function run(text) {
  const out = execFileSync("psql", ["-h", HOST, "-p", PORT, "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-Atq", "-c", text], { encoding: "utf8" });
  return out.trim();
}
export function getDatabase() {
  return {
    sql(strings, ...vals) {
      let q = strings[0];
      vals.forEach((v, i) => { q += lit(v) + strings[i + 1]; });
      q = q.trim();
      const returns = /^\s*select/i.test(q) || /\breturning\b/i.test(q);
      const wrapped = returns
        ? `WITH t AS (${q}) SELECT COALESCE(json_agg(t), '[]'::json) FROM t`
        : `WITH t AS (${q}) SELECT '[]'::json`;
      const rows = JSON.parse(run(wrapped) || "[]");
      return Promise.resolve(rows);
    },
  };
}
