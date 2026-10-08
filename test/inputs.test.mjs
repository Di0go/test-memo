// Each test builds a tiny project in a temporary folder, runs it through test-memo twice, changes
// one kind of input, and checks that exactly the test file that depends on it runs again.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  return { root, run, write, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
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

test("a test that writes into the project or runs an unknown program is not remembered", () => {
  const p = project({
    "test/writes.test.mjs": passes('import fs from "node:fs"; test("w", () => fs.writeFileSync("out.txt", "x"));'),
    "test/runs.test.mjs": passes(
      'import { execFileSync } from "node:child_process"; test("r", () => execFileSync("ls", ["."]));',
    ),
  });
  try {
    p.run();
    const r = p.run();
    assert.deepEqual(r.hits, []);
    assert.deepEqual(Object.keys(r.uncacheable).sort(), ["runs", "writes"]);
  } finally {
    p.cleanup();
  }
});
