// A just-enough stand-in for the supabase-js query builder, backed by the
// throwaway Postgres from pgHarness.ts. It lets tests run the app's real
// server code (lib/server/aiAgent/*) against the real migrations: every
// `.from(table).select/insert/update/upsert/delete` chain becomes one SQL
// statement, `.rpc(fn, args)` calls the real SQL function. It implements only
// what the agent's code uses (eq/neq/gt/gte/lt/lte/like/ilike/in/is/not/or,
// order, limit, single/maybeSingle, count/head); an unsupported call throws, so
// a new query shape fails loudly instead of silently returning nothing.

import type { TestPg } from "./pgHarness.ts";

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { message: string; code?: string } | null; count?: number | null };

const ident = (name: string) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`pgSupabase: unsupported identifier ${name}`);
  return `"${name}"`;
};

/** A select column: a plain name, or PostgREST's `alias:column->key->>key` JSON path (the only path shape the app uses). */
function column(spec: string): string {
  const m = /^([a-z_][a-z0-9_]*):([a-z_][a-z0-9_]*)((?:->>?[A-Za-z_][A-Za-z0-9_]*)+)$/i.exec(spec);
  if (!m) return ident(spec);
  const path = m[3].replace(/->>?([A-Za-z_][A-Za-z0-9_]*)/g, (all, key: string) => `${all.startsWith("->>") ? "->>" : "->"}'${key}'`);
  return `${ident(m[2])}${path} as ${ident(m[1])}`;
}

function lit(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return lit(value.toISOString());
  if (Array.isArray(value) || typeof value === "object") return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** An rpc argument: arrays of scalars become Postgres array literals. */
function rpcLit(value: unknown): string {
  if (Array.isArray(value)) return `'{${value.map((v) => `"${String(v).replace(/(["\\])/g, "\\$1")}"`).join(",")}}'`;
  return lit(value);
}

function json(value: unknown): string {
  return `'${JSON.stringify(value).replace(/'/g, "''")}'::json`;
}

function pgError(message: string): { message: string; code?: string } {
  const text = message.replace(/^ERROR:\s*/m, "").trim();
  if (/duplicate key value/.test(text)) return { message: text, code: "23505" };
  // raise exception 'code' inside a function surfaces as "ERROR:  code" (+ context lines).
  return { message: text.split("\n")[0], code: undefined };
}

class Query implements PromiseLike<Result> {
  private op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  private columns = "*";
  private returning = false;
  private payload: Row | Row[] | null = null;
  private onConflict: string | null = null;
  private ignoreDuplicates = false;
  private where: string[] = [];
  private orderBy: string[] = [];
  private limitN: number | null = null;
  private shape: "many" | "single" | "maybe" = "many";
  private head = false;
  private wantCount = false;

  private readonly pg: TestPg;
  private readonly table: string;

  constructor(pg: TestPg, table: string) {
    this.pg = pg;
    this.table = table;
  }

  select(columns = "*", opts: { count?: string; head?: boolean } = {}): this {
    if (this.op === "select") this.columns = columns;
    else {
      this.returning = true;
      this.columns = columns;
    }
    this.head = Boolean(opts.head);
    this.wantCount = Boolean(opts.count);
    return this;
  }
  insert(payload: Row | Row[]): this {
    this.op = "insert";
    this.payload = payload;
    return this;
  }
  upsert(payload: Row | Row[], opts: { onConflict?: string; ignoreDuplicates?: boolean } = {}): this {
    this.op = "upsert";
    this.payload = payload;
    this.onConflict = opts.onConflict ?? null;
    this.ignoreDuplicates = Boolean(opts.ignoreDuplicates);
    return this;
  }
  update(payload: Row): this {
    this.op = "update";
    this.payload = payload;
    return this;
  }
  delete(): this {
    this.op = "delete";
    return this;
  }

  private cmp(col: string, op: string, value: unknown): this {
    this.where.push(`${ident(col)} ${op} ${lit(value)}`);
    return this;
  }
  eq(col: string, value: unknown) {
    return value === null ? this.is(col, null) : this.cmp(col, "=", value);
  }
  neq(col: string, value: unknown) {
    return this.cmp(col, "<>", value);
  }
  gt(col: string, value: unknown) {
    return this.cmp(col, ">", value);
  }
  gte(col: string, value: unknown) {
    return this.cmp(col, ">=", value);
  }
  lt(col: string, value: unknown) {
    return this.cmp(col, "<", value);
  }
  lte(col: string, value: unknown) {
    return this.cmp(col, "<=", value);
  }
  like(col: string, pattern: string) {
    return this.cmp(col, "like", pattern);
  }
  ilike(col: string, pattern: string) {
    return this.cmp(col, "ilike", pattern);
  }
  in(col: string, values: unknown[]) {
    this.where.push(values.length ? `${ident(col)} in (${values.map(lit).join(", ")})` : "false");
    return this;
  }
  is(col: string, value: null | boolean) {
    this.where.push(`${ident(col)} is ${value === null ? "null" : value ? "true" : "false"}`);
    return this;
  }
  not(col: string, op: string, value: unknown) {
    if (op === "like" || op === "ilike") {
      this.where.push(`${ident(col)} not ${op} ${lit(value)}`);
      return this;
    }
    if (op !== "is") throw new Error(`pgSupabase: .not(${op}) is not supported`);
    this.where.push(`${ident(col)} is not ${value === null ? "null" : lit(value)}`);
    return this;
  }
  or(expr: string) {
    const parts = expr.split(",").map((part) => {
      const [col, op, ...rest] = part.split(".");
      const value = rest.join(".");
      if (op === "is") return `${ident(col)} is ${value}`;
      const sql = { eq: "=", gt: ">", gte: ">=", lt: "<", lte: "<=", like: "like", ilike: "ilike" }[op];
      if (!sql) throw new Error(`pgSupabase: .or(${op}) is not supported`);
      return `${ident(col)} ${sql} ${lit(value)}`;
    });
    this.where.push(`(${parts.join(" or ")})`);
    return this;
  }
  order(col: string, opts: { ascending?: boolean; nullsFirst?: boolean } = {}) {
    const dir = opts.ascending === false ? "desc" : "asc";
    const nulls = opts.nullsFirst === undefined ? "" : opts.nullsFirst ? " nulls first" : " nulls last";
    this.orderBy.push(`${ident(col)} ${dir}${nulls}`);
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }
  single() {
    this.shape = "single";
    return this;
  }
  maybeSingle() {
    this.shape = "maybe";
    return this;
  }

  private whereSql(): string {
    return this.where.length ? ` where ${this.where.join(" and ")}` : "";
  }

  private sql(): string {
    const t = `public.${ident(this.table)}`;
    const cols = this.columns.trim() === "*" ? "*" : this.columns.split(",").map((c) => column(c.trim())).join(", ");
    const wrap = (inner: string) => `select coalesce(json_agg(r), '[]'::json) from (${inner}) r`;
    switch (this.op) {
      case "select": {
        const order = this.orderBy.length ? ` order by ${this.orderBy.join(", ")}` : "";
        const limit = this.limitN !== null ? ` limit ${this.limitN}` : "";
        return wrap(`select ${cols} from ${t}${this.whereSql()}${order}${limit}`);
      }
      case "insert":
      case "upsert": {
        const rows = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
        if (rows.length === 0) return `select '[]'::json`;
        const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
        const keyList = keys.map(ident).join(", ");
        let conflict = "";
        if (this.op === "upsert") {
          const target = (this.onConflict ?? "").split(",").map((c) => ident(c.trim())).join(", ");
          conflict = this.ignoreDuplicates
            ? ` on conflict (${target}) do nothing`
            : ` on conflict (${target}) do update set ${keys.map((k) => `${ident(k)} = excluded.${ident(k)}`).join(", ")}`;
        }
        const insert = `insert into ${t} (${keyList}) select ${keyList} from json_populate_recordset(null::${t}, ${json(rows)})${conflict} returning *`;
        return `with ins as (${insert}) ${wrap(`select ${cols} from ins`)}`;
      }
      case "update": {
        const patch = this.payload as Row;
        const keys = Object.keys(patch);
        const set = `(${keys.map(ident).join(", ")}) = (select ${keys.map((k) => `x.${ident(k)}`).join(", ")} from json_populate_record(null::${t}, ${json(patch)}) x)`;
        const upd = `update ${t} set ${set}${this.whereSql()} returning *`;
        return `with upd as (${upd}) ${wrap(`select ${cols} from upd`)}`;
      }
      case "delete":
        return `with del as (delete from ${t}${this.whereSql()} returning *) ${wrap(`select ${cols} from del`)}`;
    }
  }

  private async exec(): Promise<Result> {
    try {
      if (this.head && this.op === "select") {
        const out = await this.pg.run(`select count(*) from public.${ident(this.table)}${this.whereSql()};`);
        return { data: null, error: null, count: Number(out) };
      }
      const out = await this.pg.run(`${this.sql()};`);
      const rows = JSON.parse(out || "[]") as Row[];
      const writes = this.op !== "select";
      if (writes && !this.returning) return { data: null, error: null };
      const count = this.wantCount ? rows.length : null;
      if (this.shape === "many") return { data: rows, error: null, count };
      if (this.shape === "maybe") {
        if (rows.length > 1) return { data: null, error: { message: "multiple rows returned", code: "PGRST116" } };
        return { data: rows[0] ?? null, error: null };
      }
      if (rows.length !== 1) return { data: null, error: { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" } };
      return { data: rows[0], error: null };
    } catch (err) {
      return { data: null, error: pgError(err instanceof Error ? err.message : String(err)) };
    }
  }

  then<A = Result, B = never>(onfulfilled?: ((v: Result) => A | PromiseLike<A>) | null, onrejected?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return this.exec().then(onfulfilled, onrejected);
  }
}

/** The stand-in client: pass it to setAgentDbForTests(). */
export function pgSupabase(pg: TestPg) {
  return {
    from: (table: string) => new Query(pg, table),
    async rpc(fn: string, args: Record<string, unknown> = {}): Promise<Result> {
      try {
        const named = Object.entries(args).map(([k, v]) => `${ident(k)} => ${rpcLit(v)}`).join(", ");
        const out = await pg.run(`select coalesce(json_agg(r), '[]'::json) from (select * from public.${ident(fn)}(${named})) r;`);
        const rows = JSON.parse(out || "[]") as Row[];
        // A scalar-returning function comes back as its value, like PostgREST.
        if (rows.length === 1 && Object.keys(rows[0]).length === 1 && fn in rows[0]) return { data: rows[0][fn], error: null };
        return { data: rows, error: null };
      } catch (err) {
        return { data: null, error: pgError(err instanceof Error ? err.message : String(err)) };
      }
    },
  };
}
