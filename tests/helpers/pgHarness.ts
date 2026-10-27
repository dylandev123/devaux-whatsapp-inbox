// Throwaway local Postgres for tests that exercise the real SQL in
// supabase/migrations (batching claim/enqueue, customer deletion). Starts a
// private cluster in a temp dir on a free loopback port, applies the migrations
// the agent depends on over a minimal Supabase stand-in (roles, is_admin(),
// two analysis tables), and tears everything down. Tests skip themselves when
// no Postgres binaries are installed, so `npm test` still passes on a bare CI.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MIGRATIONS = [
  "20261022000000_ai_agent.sql",
  "20261023000000_ai_agent_multi_business.sql",
  "20261024000000_ai_agent_observe_staff_notices.sql",
  "20260901000400_customer_ai_profile.sql",
  "20261008000000_customer_orders.sql",
  "20261025000000_ai_agent_batching_memory.sql",
  "20261026000000_ai_agent_staff_answers.sql",
  "20261027000000_ai_agent_staff_authorization.sql",
  "20261028000000_ai_agent_customer_modes_escalation_updates.sql",
  "20261029000000_ai_agent_evaluation.sql",
  "20261030000000_ai_agent_approval_pilot.sql",
  "20261031000000_ai_agent_pilot_refinements.sql",
  "20261101000000_ai_agent_daily_orders.sql",
  "20261102000000_ai_agent_order_monitoring.sql",
  "20261103000000_ai_agent_order_field_conflicts.sql",
  "20261104000000_ai_agent_auto_learning.sql",
  "20261105000000_ai_agent_learning_refinements.sql",
  "20261106000000_ai_agent_customer_staff_memory.sql",
  "20261107000000_ai_agent_staff_memory_clear_expiry.sql",
];

const BOOTSTRAP = `
do $$ begin create role anon; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
do $$ begin create role service_role; exception when duplicate_object then null; end $$;
create function public.is_admin() returns boolean language sql as $$ select false $$;
create table public.whatsapp_businesses (business_slug text primary key, is_active boolean default true);
create table public.conversation_analysis (business_slug text, chat_id text, order_status text);
insert into public.whatsapp_businesses (business_slug) values ('dog_food'), ('by_sea');
`;

function findBinDir(): string | null {
  const candidates = [process.env.PG_BIN ?? ""];
  for (const root of ["/opt/homebrew/opt", "/usr/local/opt", "/usr/lib/postgresql"]) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      if (/^postgresql/.test(entry) || /^\d+$/.test(entry)) {
        candidates.push(join(root, entry, "bin"), join(root, entry, "bin"));
      }
    }
  }
  try {
    candidates.push(execFileSync("which", ["initdb"], { encoding: "utf8" }).trim().replace(/\/initdb$/, ""));
  } catch {
    // not on PATH
  }
  return candidates.find((dir) => dir && existsSync(join(dir, "initdb")) && existsSync(join(dir, "psql"))) ?? null;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

export const pgAvailable = findBinDir() !== null;

export class TestPg {
  private readonly bin: string;
  private readonly dir: string;
  readonly port: number;

  private constructor(bin: string, dir: string, port: number) {
    this.bin = bin;
    this.dir = dir;
    this.port = port;
  }

  static async start(): Promise<TestPg> {
    const bin = findBinDir();
    if (!bin) throw new Error("PostgreSQL binaries not found");
    const dir = mkdtempSync(join(tmpdir(), "agentpg-"));
    const port = await freePort();
    execFileSync(join(bin, "initdb"), ["-D", join(dir, "data"), "-A", "trust", "-U", "postgres"], { stdio: "ignore" });
    execFileSync(
      join(bin, "pg_ctl"),
      ["-D", join(dir, "data"), "-o", `-c listen_addresses=127.0.0.1 -p ${port} -c fsync=off`, "-l", join(dir, "log"), "-w", "start"],
      { stdio: "ignore" }
    );
    const pg = new TestPg(bin, dir, port);
    await pg.run(BOOTSTRAP);
    for (const file of MIGRATIONS) {
      await pg.run(readFileSync(join(process.cwd(), "supabase", "migrations", file), "utf8"));
    }
    return pg;
  }

  /** Runs SQL in its own session; resolves with trimmed stdout (-At), rejects on any error. */
  run(sql: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        join(this.bin, "psql"),
        ["-h", "127.0.0.1", "-p", String(this.port), "-U", "postgres", "-d", "postgres", "-At", "-q", "-v", "ON_ERROR_STOP=1", "-f", "-"],
        { stdio: ["pipe", "pipe", "pipe"] }
      );
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => {
        if (code === 0) resolve(out.trim());
        else reject(new Error(err.trim() || `psql exited ${code}`));
      });
      child.stdin.end(sql);
    });
  }

  /** Several independent sessions at once (genuinely concurrent). */
  parallel(statements: string[]): Promise<string[]> {
    return Promise.all(statements.map((s) => this.run(s)));
  }

  stop(): void {
    try {
      execFileSync(join(this.bin, "pg_ctl"), ["-D", join(this.dir, "data"), "-m", "immediate", "stop"], { stdio: "ignore" });
    } catch {
      // already stopped
    }
    rmSync(this.dir, { recursive: true, force: true });
  }
}
