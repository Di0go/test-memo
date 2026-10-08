// Each test builds a tiny project in a temporary folder, runs it through test-memo twice, changes
// one kind of input, and checks that exactly the test file that depends on it runs again.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tm-proj-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "p", type: "module" }));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "tm-cache-"));
  const run = ({ env = {}, mode = "shadow" } = {}) => {
    const report = path.join(cache, "report.json");
    const r = spawnSync(process.execPath, [CLI, `--mode=${mode}`, "test"], {
      cwd: root,
      env: { ...process.env, ...env, TEST_MEMO_CACHE_DIR: cache, TEST_MEMO_REPORT: report },
      encoding: "utf8",
    });
    const out = JSON.parse(fs.readFileSync(report, "utf8"));
    return {
      ...out,
      status: r.status,
      stdout: r.stdout,
      stderr: r.stderr,
      hits: out.hits.map((h) => path.basename(h)),
    };
  };
  // A file written "now" is not trusted for two seconds (its mtime could still change in the
  // same tick): age every fixture so the first run can remember it.
  const age = () => {
    const old = new Date(Date.now() - 60_000);
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        fs.utimesSync(p, old, old);
      }
    };
    walk(root);
  };
  const write = (name, content) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
    age();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); // past the racy window
  };
  age();
  return { root, cache, run, write, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const passes = (body) => `import { test } from "node:test";\nimport assert from "node:assert/strict";\n${body}\n`;

test("a second run with nothing changed skips everything, and a changed import reruns only its test", () => {
  const p = project({
    "lib/a.mjs": "export const a = 1;",
    "lib/b.mjs": "export const b = 2;",
    "test/a.test.mjs": passes('import { a } from "../lib/a.mjs";\ntest("a", () => assert.equal(a, 1));'),
    "test/b.test.mjs": passes('import { b } from "../lib/b.mjs";\ntest("b", () => assert.equal(b, 2));'),
  });
  try {
    assert.equal(p.run().stored, 2);
    assert.deepEqual(p.run().hits.sort(), ["a.test.mjs", "b.test.mjs"]);
    p.write("lib/a.mjs", "export const a = 1; // touched");
    assert.deepEqual(p.run().hits, ["b.test.mjs"]);
  } finally {
    p.cleanup();
  }
});

test("data files read with fs, directory listings and files that appear later all count", () => {
  const p = project({
    "data/x.txt": "x",
    "test/read.test.mjs": passes(
      'import fs from "node:fs";\ntest("r", () => assert.equal(fs.readFileSync("data/x.txt", "utf8").length > 0, true));',
    ),
    "test/list.test.mjs": passes(
      'import fs from "node:fs";\ntest("l", () => assert.ok(fs.readdirSync("data").length >= 1));',
    ),
    "test/absent.test.mjs": passes(
      'import fs from "node:fs";\ntest("a", () => assert.equal(typeof fs.existsSync("flag"), "boolean"));',
    ),
  });
  try {
    p.run();
    assert.equal(p.run().hits.length, 3);
    p.write("data/x.txt", "changed");
    assert.deepEqual(p.run().hits.sort(), ["absent.test.mjs", "list.test.mjs"]);
    p.run();
    p.write("data/y.txt", "new file in the listed folder");
    assert.deepEqual(p.run().hits.sort(), ["absent.test.mjs", "read.test.mjs"]);
    p.run();
    p.write("flag", "now it exists");
    assert.deepEqual(p.run().hits.sort(), ["list.test.mjs", "read.test.mjs"]);
  } finally {
    p.cleanup();
  }
});

test("an environment variable a test reads is an input; one it does not read is not", () => {
  const p = project({
    "test/env.test.mjs": passes('test("e", () => assert.ok(process.env.TM_FLAVOUR !== "broken"));'),
    "test/other.test.mjs": passes('test("o", () => assert.ok(true));'),
  });
  try {
    p.run({ env: { TM_FLAVOUR: "a" } });
    assert.equal(p.run({ env: { TM_FLAVOUR: "a" } }).hits.length, 2);
    assert.deepEqual(p.run({ env: { TM_FLAVOUR: "b" } }).hits, ["other.test.mjs"]);
    assert.equal(p.run({ env: { TM_FLAVOUR: "b", TM_UNRELATED: "1" } }).hits.length, 2);
  } finally {
    p.cleanup();
  }
});

test("a child Node process started with its own env, and a worker thread, are traced too", () => {
  const p = project({
    "child.mjs": 'import fs from "node:fs"; process.stdout.write(fs.readFileSync("data/child.txt", "utf8"));',
    "worker.mjs":
      'import fs from "node:fs"; import { parentPort } from "node:worker_threads"; parentPort.postMessage(fs.readFileSync("data/worker.txt", "utf8"));',
    "data/child.txt": "c",
    "data/worker.txt": "w",
    "test/child.test.mjs": passes(
      'import { execFile } from "node:child_process"; import { promisify } from "node:util";\n' +
        'test("c", async () => { const { stdout } = await promisify(execFile)(process.execPath, ["child.mjs"], { env: { PATH: process.env.PATH } }); assert.equal(stdout, "c"); });',
    ),
    "test/worker.test.mjs": passes(
      'import { Worker } from "node:worker_threads";\n' +
        'test("w", async () => { const w = new Worker(new URL("../worker.mjs", import.meta.url)); const m = await new Promise((r) => w.once("message", r)); await w.terminate(); assert.equal(m, "w"); });',
    ),
  });
  try {
    p.run();
    assert.equal(p.run().hits.length, 2);
    p.write("data/child.txt", "c");
    // Same content: still a hit. Different content: the child's test reruns.
    assert.equal(p.run().hits.length, 2);
    p.write("data/child.txt", "c2");
    const r = p.run();
    assert.deepEqual(r.hits, ["worker.test.mjs"]);
    assert.equal(r.falseHits.length, 0);
    p.write("data/worker.txt", "w2");
    assert.deepEqual(p.run().hits, []);
  } finally {
    p.cleanup();
  }
});

test("a failing file is never remembered, and skip mode really skips", () => {
  const p = project({
    "test/ok.test.mjs": passes(
      'import fs from "node:fs"; test("ok", () => fs.appendFileSync(process.env.TM_COUNTER, "x"));',
    ),
    "test/bad.test.mjs": passes('test("bad", () => assert.equal(1, 2));'),
  });
  const counter = path.join(os.tmpdir(), `tm-counter-${process.pid}`);
  try {
    fs.rmSync(counter, { force: true });
    const first = p.run({ env: { TM_COUNTER: counter } });
    assert.equal(first.status, 1);
    assert.equal(first.stored, 1);
    const second = p.run({ env: { TM_COUNTER: counter }, mode: "skip" });
    assert.deepEqual(second.hits, ["ok.test.mjs"]);
    assert.equal(second.ran, 1, "only the failing file ran");
    assert.equal(fs.readFileSync(counter, "utf8"), "x", "the passing file did not run again");
  } finally {
    fs.rmSync(counter, { force: true });
    p.cleanup();
  }
});

test("in shadow mode an input the tracer cannot see shows up as a false hit, not as a silent pass", () => {
  // Temporary folders are deliberately not inputs; this test cheats by depending on one.
  const flag = path.join(os.tmpdir(), `tm-hidden-${process.pid}`);
  const p = project({
    "test/hidden.test.mjs": passes(
      `import fs from "node:fs"; test("h", () => assert.equal(fs.existsSync(${JSON.stringify(flag)}), false));`,
    ),
  });
  try {
    fs.rmSync(flag, { force: true });
    p.run();
    fs.writeFileSync(flag, "");
    const r = p.run();
    assert.deepEqual(r.hits, ["hidden.test.mjs"]);
    assert.equal(r.falseHits.length, 1);
    assert.match(r.stderr, /FALSE HIT/);
  } finally {
    fs.rmSync(flag, { force: true });
    p.cleanup();
  }
});

const hasStrace = process.platform === "linux" && spawnSync("strace", ["-V"], { stdio: "ignore" }).status === 0;

// `sh` expands the glob and `cat` opens the file: neither read goes through Node.
const runsShell = passes(
  'import { execFileSync } from "node:child_process";\n' +
    'test("r", () => assert.equal(execFileSync("sh", ["-c", "cat data/*.txt"], { encoding: "utf8" }).length > 0, true));',
);

test("a test that writes into the project, or runs another program with no kernel tracing, is not remembered", () => {
  const p = project({
    "data/x.txt": "x",
    "test/writes.test.mjs": passes('import fs from "node:fs"; test("w", () => fs.writeFileSync("out.txt", "x"));'),
    "test/runs.test.mjs": runsShell,
  });
  try {
    p.run({ env: { TEST_MEMO_KERNEL: "off" } });
    const r = p.run({ env: { TEST_MEMO_KERNEL: "off" } });
    assert.deepEqual(r.hits, []);
    assert.deepEqual(Object.keys(r.uncacheable).sort(), ["runs", "writes"]);
  } finally {
    p.cleanup();
  }
});

test("another program's reads are seen through strace, from the first run", { skip: !hasStrace }, () => {
  const p = project({ "data/x.txt": "x", "test/runs.test.mjs": runsShell, "test/other.test.mjs": passes('test("o", () => {});') });
  try {
    const first = p.run();
    assert.equal(first.stored, 2);
    assert.equal(first.kernelTraced, 0, "no whole-file kernel run: only `sh` is traced");
    assert.deepEqual(p.run().hits.sort(), ["other.test.mjs", "runs.test.mjs"]);
    // Content `cat` read, a file that appears in the folder `sh` listed, and the environment.
    p.write("data/x.txt", "changed");
    assert.deepEqual(p.run().hits, ["other.test.mjs"]);
    p.run();
    p.write("data/y.txt", "new");
    assert.deepEqual(p.run().hits, ["other.test.mjs"]);
    p.run({ env: { TM_ANYTHING: "1" } });
    assert.deepEqual(p.run({ env: { TM_ANYTHING: "2" } }).hits, ["other.test.mjs"]);
  } finally {
    p.cleanup();
  }
});

test("a program that changes folder and writes there by relative path is followed correctly", { skip: !hasStrace }, () => {
  // `mkdir -p /tmp/x/a/b` walks down with chdir("x") and mkdir("a"); strace pads those short
  // lines, and a parser that missed them would place the folder inside the project.
  const p = project({
    "test/mkdir.test.mjs": passes(
      'import { execFileSync } from "node:child_process"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";\n' +
        'test("m", () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "tm-mk-")); execFileSync("mkdir", ["-p", path.join(d, "a", "b", ".partial")]); fs.rmSync(d, { recursive: true }); });',
    ),
  });
  try {
    const r = p.run();
    assert.deepEqual(r.uncacheable, {});
    assert.equal(r.stored, 1);
  } finally {
    p.cleanup();
  }
});

test("a program that only checks a folder exists does not rerun when a file appears in it; one that lists it does", { skip: !hasStrace }, () => {
  const sh = (script) =>
    passes(
      `import { execFileSync } from "node:child_process";\ntest("s", () => execFileSync("sh", ["-c", ${JSON.stringify(script)}]));`,
    );
  const p = project({
    "data/a.txt": "a",
    "test/checks.test.mjs": sh("test -d data"),
    "test/lists.test.mjs": sh("ls data > /dev/null"),
  });
  try {
    p.run();
    assert.deepEqual(p.run().hits.sort(), ["checks.test.mjs", "lists.test.mjs"]);
    p.write("data/b.txt", "new");
    assert.deepEqual(p.run().hits, ["checks.test.mjs"]);
  } finally {
    p.cleanup();
  }
});

test("a program that does not exist still fails with ENOENT, and the test is remembered", { skip: !hasStrace }, () => {
  const p = project({
    "test/missing.test.mjs": passes(
      'import { spawnSync } from "node:child_process";\n' +
        'test("x", () => assert.equal(spawnSync("test-memo-no-such-program", ["a"]).error?.code, "ENOENT"));',
    ),
  });
  try {
    const r = p.run();
    assert.equal(r.status, 0);
    assert.deepEqual(r.uncacheable, {});
    assert.deepEqual(p.run().hits, ["missing.test.mjs"]);
  } finally {
    p.cleanup();
  }
});

test("a native addon makes a test kernel-traced, or not remembered without strace", () => {
  // The load itself is what counts; the addon does not need to exist.
  const p = project({
    "test/native.test.mjs": passes(
      'import path from "node:path";\n' +
        'test("n", () => { try { process.dlopen({ exports: {} }, path.resolve("native/fake.node")); } catch {} });',
    ),
  });
  try {
    p.run({ env: { TEST_MEMO_KERNEL: "off" } });
    const off = p.run({ env: { TEST_MEMO_KERNEL: "off" } });
    assert.deepEqual(off.hits, []);
    assert.match(off.uncacheable.native?.[0] ?? "", /native:fake\.node/);
    if (!hasStrace) return;
    p.run();
    p.run();
    assert.deepEqual(p.run().hits, ["native.test.mjs"]);
    p.write("native/fake.node", "now the file the addon loader looked for exists");
    assert.deepEqual(p.run().hits, []);
  } finally {
    p.cleanup();
  }
});

test("a connection to a server the test started is fine; one to anything else is not, unless declared", async () => {
  // The outside server lives in its own process: this one blocks in spawnSync while the
  // project's tests run.
  const outside = spawn(
    process.execPath,
    ["-e", 'const s = require("node:net").createServer((c) => c.end("hi")).listen(0, "127.0.0.1", () => console.log(s.address().port))'],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const port = await new Promise((r) => outside.stdout.once("data", (d) => r(Number(String(d).trim()))));
  const client = () =>
    `import net from "node:net";\n` +
    `const talk = (port) => new Promise((ok, ko) => { const c = net.connect(port, "127.0.0.1"); let s = ""; c.on("data", (d) => (s += d)); c.on("end", () => ok(s)); c.on("error", ko); });\n`;
  const p = project({
    "test/own.test.mjs": passes(
      `${client()}test("own", async () => { const srv = net.createServer((s) => s.end("hi")).listen(0, "127.0.0.1"); await new Promise((r) => srv.once("listening", r)); assert.equal(await talk(srv.address().port), "hi"); srv.close(); });`,
    ),
    "test/outside.test.mjs": passes(
      `${client()}test("outside", async () => assert.equal(await talk(Number(process.env.TM_PORT)), "hi"));`,
    ),
    "test/lookup.test.mjs": passes(
      'import dns from "node:dns/promises";\ntest("lookup", async () => { await dns.lookup("test-memo.invalid").catch(() => {}); });',
    ),
  });
  try {
    const env = { TM_PORT: String(port) };
    p.run({ env });
    const r = p.run({ env });
    assert.deepEqual(r.hits, ["own.test.mjs"]);
    assert.deepEqual(r.uncacheable.network.sort(), [
      "./test/lookup.test.mjs (network:test-memo.invalid)",
      `./test/outside.test.mjs (network:localhost:${port})`,
    ]);
    // Declared as a service whose state the tests control, it is remembered like the rest.
    p.write("package.json", JSON.stringify({ name: "p", type: "module", testMemo: { services: [`127.0.0.1:${port}`] } }));
    p.run({ env });
    assert.deepEqual(p.run({ env }).hits.sort(), ["outside.test.mjs", "own.test.mjs"]);
  } finally {
    outside.kill();
    p.cleanup();
  }
});

test("a pass from another calendar day is not reused, even within 24 hours", () => {
  const p = project({ "test/a.test.mjs": passes('test("a", () => {});') });
  try {
    p.run();
    assert.deepEqual(p.run().hits, ["a.test.mjs"]);
    // Move the stored pass to one minute before today's midnight, UTC.
    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    const store = path.join(p.cache, "v1");
    for (const dir of fs.readdirSync(store)) {
      for (const name of fs.readdirSync(path.join(store, dir))) {
        const file = path.join(store, dir, name);
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!data.entries) continue; // the list of files to trace at the kernel
        for (const e of data.entries) e.at = midnight.getTime() - 60_000;
        fs.writeFileSync(file, JSON.stringify(data));
      }
    }
    const r = p.run();
    assert.deepEqual(r.hits, []);
    assert.equal(r.misses["./test/a.test.mjs"], "new day");
  } finally {
    p.cleanup();
  }
});
