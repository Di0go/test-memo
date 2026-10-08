// `test-memo verify`: prove the cache on your own suite.
//
// It breaks one input at a time (a `throw` at the top of a module, invalid JSON, an emptied
// document), runs the whole suite in shadow mode against a copy of a warm cache, and checks
// that every test file that fails is one the cache would have rerun. A failing file the cache
// would have skipped is a false hit: the thing this tool must never do.
//
// Every file is put back byte for byte, with its timestamps, even on Ctrl-C. Files with
// uncommitted changes are never touched.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "./run.mjs";

const SCRIPT = /\.(c|m)?(j|t)sx?$/;
const TEXT = /\.(json|md|txt|sql|ya?ml|css|html|sh|toml|csv|svg)$/;

function mutated(file, content) {
  if (SCRIPT.test(file)) return `throw new Error("test-memo verify: mutated");\n${content}`;
  if (file.endsWith(".json")) return '{"test-memo verify": ';
  return "";
}

export async function verify({
  root,
  files,
  nodeArgs = [],
  mutations = 10,
  seed = 1,
  cacheDir,
  log = (l) => process.stderr.write(`${l}\n`),
  ...options
}) {
  root = fs.realpathSync(root);
  const warmDir = path.resolve(root, cacheDir ?? process.env.TEST_MEMO_CACHE_DIR ?? "node_modules/.cache/test-memo");
  const quiet = () => {};

  log("test-memo verify: warming the cache (two runs)...");
  await run({ ...options, root, files, nodeArgs, mode: "shadow", cacheDir: warmDir, log: quiet, stdio: "ignore" });
  const warm = await run({
    ...options,
    root,
    files,
    nodeArgs,
    mode: "shadow",
    cacheDir: warmDir,
    log: quiet,
    stdio: "ignore",
  });
  if (warm.status !== 0)
    throw new Error(`the suite does not pass as it is (${(warm.failed ?? []).join(", ")}): fix that first`);

  // Candidates: files the tests read, by how many test files read them.
  const readers = new Map();
  for (const f of fs.globSync("v1/*/*.json", { cwd: warmDir })) {
    const entry = JSON.parse(fs.readFileSync(path.join(warmDir, f), "utf8")).entries[0];
    for (const k of Object.keys(entry?.files ?? {}))
      if (k.startsWith("./")) readers.set(k.slice(2), (readers.get(k.slice(2)) ?? 0) + 1);
  }
  const clean = cleanFiles(root);
  const tests = new Set(files.map((f) => path.relative(root, path.resolve(root, f))));
  const candidates = [...readers.keys()]
    .filter((f) => (SCRIPT.test(f) || TEXT.test(f)) && !tests.has(f) && !/(^|\/)(package\.json|.*lock.*)$/.test(f))
    .filter((f) => (clean ? clean.has(f) : true))
    .filter((f) => {
      try {
        return fs.statSync(path.join(root, f)).size < 2 << 20;
      } catch {
        return false;
      }
    })
    .sort((a, b) => readers.get(a) - readers.get(b) || (a < b ? -1 : 1));
  if (!candidates.length) throw new Error("no committed, unmodified input files to mutate");

  // Spread the picks over the four quartiles of "how many tests read it".
  let state = seed;
  const random = () => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state / 2 ** 31;
  };
  const picks = new Set();
  for (let i = 0; picks.size < Math.min(mutations, candidates.length) && i < 10_000; i++) {
    const q = picks.size % 4;
    const slice = candidates.slice(
      Math.floor((q * candidates.length) / 4),
      Math.floor(((q + 1) * candidates.length) / 4) || 1,
    );
    picks.add(slice[Math.floor(random() * slice.length)]);
  }

  let current = null;
  const restore = () => {
    if (!current) return;
    fs.writeFileSync(current.abs, current.bytes);
    fs.utimesSync(current.abs, current.st.atime, current.st.mtime);
    current = null;
  };
  const onSignal = (signal) => {
    restore();
    process.kill(process.pid, signal);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  const results = [];
  try {
    for (const file of picks) {
      const abs = path.join(root, file);
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "test-memo-verify-"));
      fs.cpSync(warmDir, scratch, { recursive: true });
      current = { abs, bytes: fs.readFileSync(abs), st: fs.statSync(abs) };
      let report;
      try {
        fs.writeFileSync(abs, mutated(file, current.bytes.toString("utf8")));
        report = await run({
          ...options,
          root,
          files,
          nodeArgs,
          mode: "shadow",
          cacheDir: scratch,
          log: quiet,
          stdio: "ignore",
        });
      } finally {
        restore();
        fs.rmSync(scratch, { recursive: true, force: true });
      }
      const failed = report.failed ?? [];
      const rerun = files.length - report.hits.length;
      results.push({ file, readers: readers.get(file), failed: failed.length, rerun, falseHits: report.falseHits });
      log(
        `  ${file}: read by ${readers.get(file)}, ${failed.length} failed, ${rerun}/${files.length} would rerun` +
          (report.falseHits.length ? `, FALSE HITS: ${report.falseHits.map((h) => h.test).join(", ")}` : ""),
      );
    }
  } finally {
    restore();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
  const falseHits = results.flatMap((r) => r.falseHits);
  const failedTotal = results.reduce((s, r) => s + r.failed, 0);
  log(
    `test-memo verify: ${results.length} mutations, ${failedTotal} failing test files in total, ` +
      (falseHits.length ? `${falseHits.length} FALSE HIT(S)` : "every one of them would have rerun (0 false hits)"),
  );
  return { results, falseHits, failedTotal };
}

/** The files git considers committed and unmodified, or null outside a git repository. */
function cleanFiles(root) {
  try {
    const opts = { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 28 };
    const prefix = execFileSync("git", ["rev-parse", "--show-prefix"], opts).trim();
    const strip = (f) => (prefix && f.startsWith(prefix) ? f.slice(prefix.length) : f);
    const tracked = execFileSync("git", ["ls-files", "-z"], opts).split("\0").filter(Boolean);
    const dirty = new Set(
      execFileSync("git", ["status", "--porcelain=v1", "-z"], opts)
        .split("\0")
        .filter(Boolean)
        .map((l) => strip(l.slice(3))),
    );
    return new Set(tracked.map(strip).filter((f) => !dirty.has(f)));
  } catch {
    return null;
  }
}
