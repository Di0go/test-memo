#!/usr/bin/env node
// test-memo [--mode shadow|skip|off] [--cache-dir DIR] [--max-age HOURS] [node --test flags] [files or globs]
// test-memo verify [--mutations N] [--seed S] [--targets a,b] [node --test flags] [files or globs]
//
// Options can also live in package.json under "testMemo" (mode, cacheDir, maxAgeHours,
// ignoreEnv, volatileEnv, allowWrites, pureCommands, services, nativeAddons, timeZones,
// kernelTrace). Flags win over package.json.

import fs from "node:fs";
import path from "node:path";
import { run } from "./run.mjs";
import { verify } from "./verify.mjs";

const DEFAULT_PATTERNS = [
  "**/*.test.{cjs,mjs,js}",
  "**/*-test.{cjs,mjs,js}",
  "**/*_test.{cjs,mjs,js}",
  "**/test-*.{cjs,mjs,js}",
  "**/test.{cjs,mjs,js}",
  "**/test/**/*.{cjs,mjs,js}",
];

const root = process.cwd();
let config = {};
try {
  config = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).testMemo ?? {};
} catch {
  /* no package.json */
}

const argv = process.argv.slice(2);
const command = argv[0] === "verify" ? argv.shift() : "run";
let mutations = 10;
let seed = 1;
let targets;
const nodeArgs = [];
const patterns = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const value = () => (a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i]);
  if (a === "--") continue;
  else if (a.startsWith("--mode")) config.mode = value();
  else if (a.startsWith("--cache-dir")) config.cacheDir = value();
  else if (a.startsWith("--max-age")) config.maxAgeHours = Number(value());
  else if (command === "verify" && a.startsWith("--mutations")) mutations = Number(value());
  else if (command === "verify" && a.startsWith("--seed")) seed = Number(value());
  else if (command === "verify" && a.startsWith("--targets")) targets = value().split(",").filter(Boolean);
  else if (a === "-h" || a === "--help") {
    process.stdout.write(
      fs
        .readFileSync(new URL(import.meta.url), "utf8")
        .split("\n")
        .slice(1, 7)
        .join("\n")
        .replace(/^\/\/ ?/gm, "") + "\n",
    );
    process.exit(0);
  } else if (a.startsWith("-")) nodeArgs.push(a);
  else patterns.push(a);
}

const glob = (p) =>
  fs.globSync(p, {
    cwd: root,
    exclude: (f) => f === "node_modules" || f.endsWith("/node_modules") || f.split(/[\\/]/).includes("node_modules"),
  });
const files = [
  ...new Set(
    (patterns.length ? patterns : DEFAULT_PATTERNS).flatMap((p) =>
      /[*?{]/.test(p)
        ? glob(p)
        : fs.statSync(path.resolve(root, p)).isDirectory()
          ? glob(`${p}/**/*.test.{cjs,mjs,js}`)
          : [p],
    ),
  ),
].sort();

const common = {
  root,
  files,
  nodeArgs,
  cacheDir: config.cacheDir,
  maxAgeMs: config.maxAgeHours ? config.maxAgeHours * 3600_000 : undefined,
  ignoreEnv: config.ignoreEnv,
  volatileEnv: config.volatileEnv,
  allowWrites: config.allowWrites,
  pureCommands: config.pureCommands,
  services: config.services,
  nativeAddons: config.nativeAddons,
  timeZones: config.timeZones,
  kernelTrace: config.kernelTrace,
};
if (command === "verify") {
  const { falseHits } = await verify({ ...common, mutations, seed, targets });
  process.exitCode = falseHits.length ? 1 : 0;
} else {
  const report = await run({ ...common, mode: config.mode ?? process.env.TEST_MEMO_MODE ?? "shadow" });
  if (process.env.TEST_MEMO_REPORT) fs.writeFileSync(process.env.TEST_MEMO_REPORT, JSON.stringify(report, null, 1));
  process.exitCode = report.status;
}
