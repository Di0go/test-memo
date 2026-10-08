// The orchestrator: decide which test files already passed with exactly these inputs, run
// `node --test` with the tracer on the rest (or on everything, in shadow mode), and write
// down what each passing file depended on.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { envRules } from "./env.mjs";
import { kernelTracer, readKernelTraces, readSpawnTrace } from "./kernel.mjs";
import { sha, States, writeAtomic } from "./state.mjs";

export const VERSION = "0.2.1";
const TRACER = fileURLToPath(new URL("./tracer.mjs", import.meta.url));
const LOCKFILES = [
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
];
const PURE = new Set([
  "true",
  "false",
  "echo",
  "printf",
  "sleep",
  "kill",
  "id",
  "whoami",
  "uname",
  "date",
  "hostname",
  "nproc",
]);
const MAX_ENTRIES = 12;
const HOUR = 3600_000;

/**
 * @param {object} o
 * @param {string} o.root           project root
 * @param {string[]} o.files        test files (absolute or relative to root)
 * @param {string[]} [o.nodeArgs]   extra `node --test` flags (`--test-timeout=...`)
 * @param {"shadow"|"skip"|"off"} [o.mode]
 * @param {Record<string,string|undefined>} [o.env]
 * @param {string} [o.cacheDir]
 * @param {number} [o.maxAgeMs]     a stored pass older than this is not reused
 * @param {string[]} [o.ignoreEnv]  extra variables that never count (globs allowed)
 * @param {string[]} [o.volatileEnv] variables whose value changes every run but does not matter
 * @param {string[]} [o.allowWrites] project paths (prefixes) a test may write to and stay cacheable
 * @param {string[]} [o.pureCommands] non-Node commands whose output depends only on their arguments
 * @param {string[]} [o.services]   addresses ("host:port", "unix:/path", globs allowed) of services
 *                                  whose state comes only from files the tests read, or from what
 *                                  each test itself put there (a database cloned per test)
 * @param {string[]} [o.nativeAddons] native addons (path fragments) accepted without kernel tracing
 * @param {string[]} [o.timeZones]  zones whose calendar day a pass is bound to (UTC and the local
 *                                  zone always are)
 * @param {"auto"|"off"} [o.kernelTrace] trace files that run other programs or load native addons
 *                                  with strace (Linux), so they can be remembered too
 * @param {string} [o.key]          anything else the results depend on
 * @param {(line: string) => void} [o.log]
 */
export async function run(o) {
  const t0 = Date.now();
  const root = fs.realpathSync(o.root);
  // `node --test` started from inside a test inherits NODE_TEST_CONTEXT and would think it is
  // a child of the outer runner; it is not.
  const env = { ...(o.env ?? process.env) };
  delete env.NODE_TEST_CONTEXT;
  // Inside a test that is itself being traced, a second tracer would hide this run's reads from
  // the outer one: run plainly, and let the outer tracer see everything.
  const mode = env.TEST_MEMO_TEST ? "off" : (o.mode ?? "shadow");
  const log = o.log ?? ((line) => process.stderr.write(`${line}\n`));
  const files = o.files.map((f) => path.resolve(root, f));
  const nodeArgs = o.nodeArgs ?? [];

  if (mode === "off") {
    const { status } = await nodeTest({ root, files, nodeArgs, env, stdio: o.stdio });
    return { status, mode, files: files.length, ran: files.length, hits: [], stored: 0 };
  }

  const cacheDir = path.resolve(root, o.cacheDir ?? env.TEST_MEMO_CACHE_DIR ?? "node_modules/.cache/test-memo");
  const importFlag = `--import=${pathToFileURL(TRACER).href}`;
  const rules = envRules({ root, ignore: o.ignoreEnv, volatile: o.volatileEnv, ownImport: importFlag });
  const states = new States({ statCacheFile: path.join(cacheDir, `stat-${sha(root)}.json`) });
  // The clock is an input nobody declares. A pass counts only on the calendar day it was
  // proven, in every zone that could decide what "today" is for the code under test.
  const zones = [...new Set(["UTC", Intl.DateTimeFormat().resolvedOptions().timeZone, env.TZ, ...(o.timeZones ?? [])])]
    .filter(Boolean)
    .filter((zone) => {
      try {
        new Intl.DateTimeFormat("en-CA", { timeZone: zone });
        return true;
      } catch {
        return false;
      }
    });
  const dayFormats = zones.map(
    (zone) => new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }),
  );
  const dayOf = (ms) => dayFormats.map((f) => f.format(ms)).join(" ");
  const today = dayOf(t0);
  const key = sha(
    JSON.stringify({
      // The tracer itself decides what is recorded: a different tracer is a different cache.
      tool: [VERSION, sha(fs.readFileSync(TRACER))],
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      zones,
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      nodeArgs,
      deps: LOCKFILES.map((f) => [f, states.of(path.join(root, f))]),
      key: o.key ?? "",
    }),
  );
  const storeDir = path.join(cacheDir, "v1", key);
  const relKey = (abs) =>
    abs === root || abs.startsWith(root + path.sep) ? `./${path.relative(root, abs).split(path.sep).join("/")}` : abs;
  const fromKey = (k) => (k.startsWith("./") ? path.join(root, k.slice(2)) : k);
  const testKey = (abs) => relKey(abs);
  const entryFile = (abs) => path.join(storeDir, `${sha(testKey(abs))}.json`);

  let gitState;
  const git = () => {
    gitState ??= computeGitState(root);
    return gitState;
  };
  const maxAgeMs = o.maxAgeMs ?? 24 * HOUR;

  // 1. Which files already passed with what they would see now?
  const hits = new Map();
  const misses = new Map();
  for (const file of files) {
    const entries = readJson(entryFile(file))?.entries ?? [];
    const ctx = { states, fromKey, rules, env, git };
    const fresh = (e) => t0 - e.at < maxAgeMs && dayOf(e.at) === today;
    const match = entries.find((e) => fresh(e) && matches(e, ctx));
    if (match) hits.set(file, match);
    else if (entries.length) {
      const newest = entries[0];
      misses.set(
        file,
        t0 - newest.at >= maxAgeMs ? "expired" : dayOf(newest.at) !== today ? "new day" : mismatch(newest, ctx),
      );
    } else misses.set(file, "never ran");
  }
  const toRun = mode === "skip" ? files.filter((f) => !hits.has(f)) : files;
  const tLookup = Date.now();

  // 2. Run them, traced.
  cleanStaleTraceDirs();
  const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), `test-memo-${process.pid}-`));
  const ignore = [
    os.tmpdir(),
    "/tmp",
    "/var/tmp",
    "/dev",
    "/proc",
    "/sys",
    "/run",
    "/usr",
    "/etc",
    "/lib",
    "/lib64",
    "/bin",
    "/sbin",
    path.dirname(path.dirname(process.execPath)),
    cacheDir,
    path.dirname(TRACER),
    path.join(os.homedir(), ".cache"),
    ...(o.ignorePaths ?? []),
  ].map((p) => path.resolve(p));
  // --permission-audit sees reads made by Node internals too, but costs ~9% on its own; opt-in.
  const audit =
    (o.audit ?? env.TEST_MEMO_AUDIT_FS === "1") && process.allowedNodeEnvironmentFlags.has("--permission-audit");
  const childEnv = {
    ...env,
    NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} ${importFlag}${audit ? " --permission-audit" : ""}`.trim(),
    TEST_MEMO_ROOT: root,
    TEST_MEMO_TRACE_DIR: traceDir,
    TEST_MEMO_IMPORT: importFlag,
    TEST_MEMO_AUDIT: audit ? "1" : "0",
    TEST_MEMO_IGNORE: JSON.stringify(ignore),
  };
  delete childEnv.TEST_MEMO_TEST;

  let status = 0;
  const report = {
    mode,
    files: files.length,
    hits: [...hits.keys()].map(relKey),
    misses: Object.fromEntries([...misses].map(([f, why]) => [relKey(f), why])),
    ran: toRun.length,
    stored: 0,
    uncacheable: {},
    falseHits: [],
  };
  // Programs other than Node run under strace, put in front of them by the tracer as they are
  // spawned. Test files that, last time, loaded a native addon run whole under strace, in a
  // second `node --test` next to the first; their output is printed after. The list of those
  // is relative and lives next to the results, shared by every checkout of the project.
  const kernelFile = path.join(storeDir, "kernel.json");
  const kernelSet = new Set(readJson(kernelFile)?.tests ?? []);
  const kernelArgv = (o.kernelTrace ?? env.TEST_MEMO_KERNEL ?? "auto") === "off" ? null : kernelTracer();
  if (kernelArgv) {
    childEnv.TEST_MEMO_STRACE = JSON.stringify(kernelArgv);
    childEnv.TEST_MEMO_UNTRACED = JSON.stringify(["git", ...PURE, ...(o.pureCommands ?? [])]);
  }
  const kernelRun = kernelArgv ? toRun.filter((f) => kernelSet.has(testKey(f))) : [];
  const plainRun = toRun.filter((f) => !kernelRun.includes(f));
  const kernelDir = path.join(traceDir, "kernel");
  report.kernelTraced = kernelRun.length;
  const NODE_MODULES = `${path.sep}node_modules${path.sep}`;
  const keep = (abs) => {
    if (abs.includes(NODE_MODULES)) return false;
    if (abs === root || abs.startsWith(root + path.sep)) return true;
    for (const prefix of ignore) if (abs === prefix || abs.startsWith(prefix + path.sep)) return false;
    return true;
  };

  try {
    const stdio = o.stdio ?? "inherit";
    const runs = [];
    if (plainRun.length) runs.push(nodeTest({ root, files: plainRun, nodeArgs, env: childEnv, stdio }));
    if (kernelRun.length) {
      fs.mkdirSync(kernelDir);
      const held = stdio === "inherit";
      runs.push(
        nodeTest({
          root,
          files: kernelRun,
          nodeArgs,
          // Already under strace: a second one inside could not attach.
          env: { ...childEnv, TEST_MEMO_STRACE: "null" },
          stdio: held ? ["inherit", "pipe", "pipe"] : stdio,
          wrap: [...kernelArgv, "-o", path.join(kernelDir, "k")],
          held,
        }),
      );
    }
    const done = await Promise.all(runs);
    status = Math.max(0, ...done.map((d) => d.status));
    for (const d of done) {
      if (d.out) process.stdout.write(d.out);
      if (d.err) process.stderr.write(d.err);
    }
    report.timings = { lookupMs: tLookup - t0, runMs: Date.now() - tLookup };
    const tRecord = Date.now();

    // 3. Read what happened, and write down every file that passed.
    const { byTest: traces, pidTest } = readTraces(traceDir);
    // Git's own files are covered by the git state (HEAD, refs, status), not one by one.
    const keepKernel = (abs) => !/[\\/]\.git([\\/]|$)/.test(abs) && keep(abs);
    const absorb = (t, k) => {
      for (const r of k.reads) t.reads.add(r);
      for (const r of k.stats) t.stats.add(r);
      for (const w of k.writes) t.writes.add(w);
      for (const e of k.execs) t.execs.add(e);
      t.connects.push(...k.connects);
      t.listens.push(...k.listens);
    };
    if (kernelRun.length) {
      for (const [test, k] of readKernelTraces(kernelDir, pidTest, keepKernel)) {
        const t = traces.get(test);
        if (!t || !kernelRun.includes(test)) continue;
        t.kernel = true;
        absorb(t, k);
      }
    }
    for (const t of traces.values()) {
      for (const s of t.spawns) {
        if (!s.kernel) continue;
        const k = readSpawnTrace(s.kernel, pidTest, keepKernel);
        if (!k) continue;
        s.traced = true;
        absorb(t, k);
      }
    }
    for (const file of toRun) {
      const t = traces.get(file);
      const outcome = t?.exit;
      if (outcome !== 0) {
        report.failed ??= [];
        report.failed.push(relKey(file));
      }
      if (hits.has(file) && outcome !== 0) {
        report.falseHits.push({ test: relKey(file), exit: outcome ?? null, entryAt: hits.get(file).at });
      }
      if (t) {
        const needs = needsKernel(t, { addons: o.nativeAddons ?? [] });
        if (needs) kernelSet.add(testKey(file));
        else if (t.kernel) kernelSet.delete(testKey(file));
      }
      if (outcome !== 0) continue;
      const why = [];
      const entry = buildEntry(t, {
        root,
        relKey,
        states,
        rules,
        env,
        git,
        since: t0,
        pure: o.pureCommands ?? [],
        allowWrites: o.allowWrites ?? [],
        services: o.services ?? [],
        addons: o.nativeAddons ?? [],
        kernelAvailable: Boolean(kernelArgv),
        // A program a test wrote to a scratch folder and ran is part of the test, not an input.
        scratch: [os.tmpdir(), "/tmp", "/var/tmp", "/dev/shm", cacheDir].map((p) => path.resolve(p)),
        why,
      });
      if (!entry) {
        const reason = why[0] ?? "unknown";
        const group = reason.split(":")[0];
        report.uncacheable[group] ??= [];
        report.uncacheable[group].push(`${relKey(file)} (${reason})`);
        continue;
      }
      const stored = readJson(entryFile(file))?.entries ?? [];
      const same = JSON.stringify({ ...entry, at: 0 });
      const kept = stored.filter((e) => JSON.stringify({ ...e, at: 0 }) !== same);
      writeAtomic(
        entryFile(file),
        JSON.stringify({ test: testKey(file), entries: [entry, ...kept].slice(0, MAX_ENTRIES) }),
      );
      report.stored++;
    }
    states.save();
    if (kernelArgv) writeAtomic(kernelFile, JSON.stringify({ tests: [...kernelSet].sort() }));
    report.timings.recordMs = Date.now() - tRecord;
  } finally {
    if (env.TEST_MEMO_KEEP_TRACES) fs.cpSync(traceDir, env.TEST_MEMO_KEEP_TRACES, { recursive: true });
    fs.rmSync(traceDir, { recursive: true, force: true });
  }

  report.status = status;
  report.ms = Date.now() - t0;
  try {
    fs.appendFileSync(
      path.join(cacheDir, "runs.jsonl"),
      `${JSON.stringify({ at: t0, root: relKey(root), ...report, hits: report.hits.length })}\n`,
    );
  } catch {
    /* the log is a convenience */
  }
  const unc = Object.values(report.uncacheable).reduce((s, l) => s + l.length, 0);
  const verb = mode === "skip" ? "skipped" : "would skip";
  log(
    `test-memo: ${files.length} files, ${hits.size} ${verb} (same inputs already passed), ${toRun.length} ran, ` +
      `${report.stored} remembered, ${unc} not cacheable` +
      (report.falseHits.length
        ? `, ${report.falseHits.length} FALSE HIT(S): ${report.falseHits.map((h) => h.test).join(", ")}`
        : ""),
  );
  return report;
}

const fromGlob = (g, fromKey) => ({ ...g, cwd: fromKey(g.cwd) });

function matches(entry, ctx) {
  return mismatch(entry, ctx) === null;
}

/** Why an entry no longer applies: the first input that differs, or null when it all matches. */
function mismatch(entry, { states, fromKey, rules, env, git }) {
  for (const [k, state] of Object.entries(entry.files)) if (states.of(fromKey(k)) !== state) return `file ${k}`;
  for (const [k, kind] of Object.entries(entry.exist ?? {})) if (states.kind(fromKey(k)) !== kind) return `exists ${k}`;
  for (const [k, state] of Object.entries(entry.trees ?? {}))
    if (states.tree(fromKey(k), false) !== state) return `listing ${k}`;
  for (const [k, state] of Object.entries(entry.copies ?? {}))
    if (states.tree(fromKey(k), true) !== state) return `tree ${k}`;
  for (const g of entry.globs ?? []) if (states.glob(fromGlob(g, fromKey)) !== g.state) return `glob ${g.pattern}`;
  for (const [name, value] of Object.entries(entry.env)) if (rules.value(env, name) !== value) return `env ${name}`;
  if (entry.envAll && rules.whole(env, { withGit: Boolean(entry.git) }) !== entry.envAll) return "env (whole)";
  if (entry.git && git() !== entry.git) return "git state";
  return null;
}

function buildEntry(
  t,
  { root, relKey, states, rules, env, git, since, pure, allowWrites, services, addons, kernelAvailable, scratch, why },
) {
  if (!t?.rootSeen) return void why.push("no-trace");
  if (t.flags.size) return void why.push([...t.flags][0]);

  const inRoot = (abs) => abs === root || abs.startsWith(root + path.sep);
  for (const w of t.writes) {
    if (inRoot(w) && !allowWrites.some((p) => relKey(w).startsWith(p.startsWith("./") ? p : `./${p}`)))
      return void why.push(`writes:${relKey(w)}`);
  }

  // A program other than Node, or a native addon, reads past the tracer: fine only when the
  // kernel saw this run.
  const later = (reason) => (kernelAvailable ? `kernel-next-run:${reason}` : reason);
  let needsGit = false;
  let foreign = false;
  for (const s of t.spawns) {
    if (s.node) continue;
    const base = commandName(s.cmd);
    if (base === "git") {
      if (inRoot(s.cwd) || s.gitDir) needsGit = true;
      continue;
    }
    if (PURE.has(base) || pure.includes(base) || s.missing) continue;
    if (!t.kernel && !s.traced) return void why.push(s.kernel ? `kernel-trace-missing:${base}` : `runs:${base}`);
    foreign = true;
  }
  for (const a of t.addons) {
    if (t.kernel || addons.some((x) => a.includes(x))) continue;
    return void why.push(later(`native:${addonName(a)}`));
  }
  if (t.lostChildren) return void why.push(`lost-child:${t.lostChildren}`);
  const outside = outsider(t, services);
  if (outside) return void why.push(`network:${outside}`);

  const files = {};
  const add = (abs) => {
    if (files[relKey(abs)] !== undefined) return true;
    if (states.changedSince(abs, since)) return false;
    files[relKey(abs)] = states.of(abs);
    return true;
  };
  // A module's format and exports depend on the package.json files above it.
  const scopes = new Set();
  for (const abs of t.reads) {
    if (!inRoot(abs) || !/\.(c|m)?(j|t)sx?$|\.json$/.test(abs)) continue;
    for (let dir = path.dirname(abs); inRoot(dir); dir = path.dirname(dir)) {
      if (scopes.has(dir)) break;
      scopes.add(dir);
    }
  }
  // ...and where a bare import would be looked up: a node_modules appearing in a folder above
  // a module changes what `import "x"` finds.
  const exist = {};
  for (const dir of scopes) {
    t.reads.add(path.join(dir, "package.json"));
    // Only whether it is there: its contents are the lockfile's business, and tools write
    // scratch folders into it (Vite's .vite) that would otherwise look like a change.
    exist[relKey(path.join(dir, "node_modules"))] = states.kind(path.join(dir, "node_modules"));
  }
  t.reads.add(t.test);
  for (const abs of t.reads) {
    if (t.writes.has(abs)) continue; // made by the test itself
    if (!add(abs)) return void why.push(`changed-during-run:${relKey(abs)}`);
  }
  // What the kernel saw only checked: a folder by whether it is there, anything else by content.
  for (const abs of t.stats) {
    if (t.reads.has(abs) || t.writes.has(abs) || files[relKey(abs)] !== undefined) continue;
    if (states.kind(abs) === "d") exist[relKey(abs)] = "d";
    else if (!add(abs)) return void why.push(`changed-during-run:${relKey(abs)}`);
  }
  // A program that was executed is an input like its script: an upgrade can change the answer.
  for (const abs of t.execs) {
    if (abs === process.execPath || t.writes.has(abs) || abs.includes(`${path.sep}node_modules${path.sep}`)) continue;
    if (scratch.some((p) => abs === p || abs.startsWith(p + path.sep))) continue;
    if (!add(abs)) return void why.push(`changed-during-run:${relKey(abs)}`);
  }

  const trees = {};
  for (const abs of t.trees) trees[relKey(abs)] = states.tree(abs, false);
  const copies = {};
  for (const abs of t.copies) copies[relKey(abs)] = states.tree(abs, true);
  const globs = [...t.globs.values()].map((g) => ({ ...g, cwd: relKey(g.cwd), state: states.glob(g) }));
  const envEntry = {};
  for (const name of t.envReads) {
    if (rules.isNoise(name) || (name.startsWith("GIT_") && !needsGit)) continue;
    envEntry[name] = rules.value(env, name);
  }
  const entry = { at: since, files, exist, env: envEntry };
  if (Object.keys(trees).length) entry.trees = trees;
  if (Object.keys(copies).length) entry.copies = copies;
  if (globs.length) entry.globs = globs;
  // What a program other than Node reads from its environment is invisible: all of it counts.
  if (t.enumeratedEnv || foreign) entry.envAll = rules.whole(env, { withGit: needsGit });
  if (needsGit) entry.git = git();
  return entry;
}

function needsKernel(t, { addons }) {
  return [...t.addons].some((a) => !addons.some((x) => a.includes(x)));
}

const commandName = (cmd) => path.basename(String(cmd)).replace(/\.exe$/i, "");

function addonName(file) {
  const parts = file.split(/[\\/]/);
  const at = parts.lastIndexOf("node_modules");
  if (at === -1) return path.basename(file);
  return parts[at + 1]?.startsWith("@") ? `${parts[at + 1]}/${parts[at + 2]}` : parts[at + 1];
}

const LOCAL = /^(localhost|.+\.localhost|127\.\d+\.\d+\.\d+|::1|0\.0\.0\.0|::|::ffff:127\.\d+\.\d+\.\d+)$/i;
const hostOf = (host) => (LOCAL.test(String(host ?? "localhost").replace(/^\[|\]$/g, "")) ? "localhost" : String(host).toLowerCase());

function addressOf(k) {
  if (k.udp) return "udp";
  if (k.path) return `unix:${k.path}`;
  return k.port == null ? hostOf(k.host) : `${hostOf(k.host)}:${k.port}`;
}

function servicePattern(p) {
  let address = String(p);
  if (!address.startsWith("unix:") && address !== "udp") {
    const colon = address.lastIndexOf(":");
    address = colon > 0 ? `${hostOf(address.slice(0, colon))}:${address.slice(colon + 1)}` : hostOf(address);
  }
  return new RegExp(`^${address.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
}

/** The first connection to something the test's own processes did not start, if any. */
function outsider(t, services) {
  const ports = new Set(t.listens.filter((l) => l.port).map((l) => l.port));
  const paths = new Set(t.listens.filter((l) => l.path).map((l) => l.path));
  const declared = services.map(servicePattern);
  for (const k of t.connects) {
    const address = addressOf(k);
    if (address === "localhost") continue; // a lookup of this machine's own name
    if (k.path && paths.has(k.path)) continue;
    if (k.port != null && address === `localhost:${k.port}` && ports.has(k.port)) continue;
    // A name lookup is declared when some service on that host is.
    if (declared.some((re) => re.test(address) || (k.port == null && re.test(`${address}:0`)))) continue;
    if (k.port == null && services.some((p) => String(p).startsWith(`${k.host}:`))) continue;
    return address;
  }
  return null;
}

function readTraces(dir) {
  const procs = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".trace")) continue;
    const lines = fs.readFileSync(path.join(dir, name), "utf8").split("\n");
    const head = lines[0]?.startsWith("T ") ? JSON.parse(lines[0].slice(2)) : null;
    if (!head) continue;
    const p = {
      ...head,
      reads: [],
      writes: [],
      trees: [],
      copies: [],
      globs: [],
      env: [],
      enumerated: false,
      spawns: [],
      addons: [],
      connects: [],
      listens: [],
      exit: undefined,
      flags: [],
    };
    for (const line of lines.slice(1)) {
      if (!line) continue;
      const kind = line[0];
      const rest = line.slice(2);
      try {
        if (kind === "R") p.reads.push(JSON.parse(rest));
        else if (kind === "W") p.writes.push(JSON.parse(rest));
        else if (kind === "T") p.trees.push(JSON.parse(rest));
        else if (kind === "C") p.copies.push(JSON.parse(rest));
        else if (kind === "G") p.globs.push(JSON.parse(rest));
        else if (kind === "E") p.env.push(JSON.parse(rest));
        else if (kind === "N") p.enumerated = true;
        else if (kind === "S") p.spawns.push(JSON.parse(rest));
        else if (kind === "A") p.addons.push(JSON.parse(rest));
        else if (kind === "K") p.connects.push(JSON.parse(rest));
        else if (kind === "L") p.listens.push(JSON.parse(rest));
        else if (kind === "X") p.exit = Number(rest);
        else if (kind === "U") p.flags.push(rest);
      } catch {
        p.flags.push("bad-trace");
      }
    }
    procs.push(p);
  }
  const byTest = new Map();
  const childrenOf = new Map();
  for (const p of procs) if (p.thread === 0) childrenOf.set(p.ppid, (childrenOf.get(p.ppid) ?? 0) + 1);
  for (const p of procs) {
    let t = byTest.get(p.test);
    if (!t) {
      t = {
        test: p.test,
        rootSeen: false,
        exit: undefined,
        reads: new Set(),
        writes: new Set(),
        trees: new Set(),
        copies: new Set(),
        globs: new Map(),
        envReads: new Set(),
        enumeratedEnv: false,
        spawns: [],
        addons: new Set(),
        connects: [],
        listens: [],
        execs: new Set(),
        stats: new Set(),
        kernel: false,
        flags: new Set(),
        lostChildren: 0,
      };
      byTest.set(p.test, t);
    }
    if (p.root) {
      t.rootSeen = true;
      t.exit = p.exit;
    }
    for (const r of p.reads) t.reads.add(r);
    for (const w of p.writes) t.writes.add(w);
    for (const d of p.trees) t.trees.add(d);
    for (const d of p.copies) t.copies.add(d);
    for (const g of p.globs) t.globs.set(JSON.stringify(g), g);
    for (const e of p.env) t.envReads.add(e);
    if (p.enumerated) t.enumeratedEnv = true;
    for (const f of p.flags) t.flags.add(f);
    t.spawns.push(...p.spawns.map((s) => ({ ...s, from: p.pid })));
    for (const a of p.addons) t.addons.add(a);
    t.connects.push(...p.connects);
    t.listens.push(...p.listens);
    if (p.thread === 0) {
      const direct = p.spawns.filter((s) => s.node && s.via !== "exec" && s.via !== "execSync").length;
      const seen = childrenOf.get(p.pid) ?? 0;
      if (seen < direct) t.lostChildren += direct - seen;
    }
  }
  const pidTest = new Map();
  for (const p of procs) if (p.thread === 0) pidTest.set(p.pid, p.test);
  return { byTest, pidTest };
}

function computeGitState(root) {
  try {
    const g = (args) =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 1 << 28,
      });
    return sha(
      [
        g(["rev-parse", "HEAD"]),
        g(["for-each-ref", "--format=%(refname) %(objectname)"]),
        g(["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      ].join("\0"),
    );
  } catch {
    return "no-git";
  }
}

function nodeTest({ root, files, nodeArgs, env, stdio = "inherit", wrap, held }) {
  return new Promise((resolve, reject) => {
    const argv = [process.execPath, "--test", ...nodeArgs, ...files];
    const [command, ...args] = wrap ? [...wrap, "--", ...argv] : argv;
    const child = spawn(command, args, { cwd: root, env, stdio });
    let out = "";
    let err = "";
    if (held) {
      child.stdout.setEncoding("utf8").on("data", (d) => (out += d));
      child.stderr.setEncoding("utf8").on("data", (d) => (err += d));
    }
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ status: code ?? (signal ? 1 : 0), out, err }));
  });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function cleanStaleTraceDirs() {
  const tmp = os.tmpdir();
  let names = [];
  try {
    names = fs.readdirSync(tmp).filter((n) => n.startsWith("test-memo-"));
  } catch {
    return;
  }
  for (const name of names) {
    const pid = Number(name.split("-")[2]);
    try {
      process.kill(pid, 0);
    } catch {
      fs.rmSync(path.join(tmp, name), { recursive: true, force: true });
    }
  }
}
