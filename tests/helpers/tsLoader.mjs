// Node module-loader hooks that let a test import the app's SERVER modules as
// they are written: the "@/…" path alias, and TypeScript where types and values
// share one import list (which --experimental-strip-types alone rejects).
// Used only by tests that run the real server code against a throwaway
// Postgres (tests/helpers/pgSupabase.ts); the pure-function tests don't need it.
//
//   import { register } from "node:module";
//   register("./helpers/tsLoader.mjs", import.meta.url, { data: { root: process.cwd() } });
//   const mod = await import("../lib/server/aiAgent/staffGroup.ts");

import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

let root = process.cwd();

export function initialize(data) {
  if (data?.root) root = data.root;
}

function firstFile(base) {
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), base]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

export async function resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) {
    const file = firstFile(join(root, specifier.slice(2)));
    if (file) return { url: pathToFileURL(file).href, shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.startsWith("file:") && url.endsWith(".ts") && !url.includes("/node_modules/")) {
    const file = fileURLToPath(url);
    const source = await readFile(file, "utf8");
    const out = ts.transpileModule(source, {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, isolatedModules: true },
    });
    return { format: "module", source: out.outputText, shortCircuit: true };
  }
  return next(url, context);
}
