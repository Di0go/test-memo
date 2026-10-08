// Preloaded into every process of a traced test run (through NODE_OPTIONS=--import).
//
// It records what a test file -- and every process and worker thread it starts -- reads
// from the outside world, so that the orchestrator can tell, next time, whether that test
// file would see exactly the same inputs:
//
//   R <path>   a file or directory was read, stat'ed, listed or loaded as a module
//   T <path>   a directory was listed recursively (names and types)
//   C <path>   a directory was copied (names, types and contents)
//   G <json>   a glob was expanded ({ pattern, cwd, exclude })
//   W <path>   something was written, created, renamed or removed
//   E <name>   an environment variable was read
//   N          the whole environment was enumerated ({...process.env}, Object.keys, ...)
//   S <json>   a child process was started
//   X <code>   the process exited with this code
//
// Each process/thread appends to its own file, one line per new fact, with a plain
// write(2). Nothing is buffered, so a process killed with SIGKILL still leaves its reads
// behind. The orchestrator never trusts a test whose own trace is incomplete.

import cp from "node:child_process";
import dc from "node:diagnostics_channel";
import fs from "node:fs";
import module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isMainThread, threadId } from "node:worker_threads";

const realEnv = process.env;
const ROOT = realEnv.TEST_MEMO_ROOT;
const OUT = realEnv.TEST_MEMO_TRACE_DIR;

// The orchestrator (`node --test` itself) has neither variable set: nothing to trace there.
const active = Boolean(ROOT && OUT && (realEnv.TEST_MEMO_TEST || realEnv.NODE_TEST_CONTEXT));

if (active) start();

function start() {
  const IMPORT = realEnv.TEST_MEMO_IMPORT || "";
  const AUDIT = realEnv.TEST_MEMO_AUDIT === "1";
  const IGNORE = JSON.parse(realEnv.TEST_MEMO_IGNORE || "[]");
  const NODE_MODULES = `${path.sep}node_modules${path.sep}`;

  const isRoot = !realEnv.TEST_MEMO_TEST && isMainThread;
  if (isRoot) realEnv.TEST_MEMO_TEST = path.resolve(process.argv[1] || "");
  const test = realEnv.TEST_MEMO_TEST;

  const writeSync = fs.writeSync;
  let fd = -1;
  try {
    fd = fs.openSync(path.join(OUT, `${process.pid}-${threadId}.trace`), "a");
  } catch {
    return; // the run is over (a detached child outliving it); nothing left to report to
  }
  const done = new Set();
  const emit = (line) => {
    try {
      writeSync(fd, `${line}\n`);
    } catch {
      /* the trace directory is gone: the run already finished */
    }
  };
  emit(
    `T ${JSON.stringify({
      test,
      root: isRoot,
      pid: process.pid,
      ppid: process.ppid,
      thread: threadId,
      argv: process.argv.slice(1, 6),
      cwd: process.cwd(),
    })}`,
  );

  // Inside the project everything counts except installed packages (the lockfile covers
  // those). Outside it, system and scratch locations do not: they are where tests make
  // their temporary files, and where the runtime itself lives.
  try {
    const keep = (abs) => {
      if (abs.includes(NODE_MODULES)) return false;
      if (abs === ROOT || abs.startsWith(ROOT + path.sep)) return true;
      for (const prefix of IGNORE) if (abs === prefix || abs.startsWith(prefix + path.sep)) return false;
      return true;
    };
    const record = (kind, p) => {
      let abs;
      try {
        abs = path.resolve(p);
      } catch {
        return;
      }
      if (!keep(abs)) return;
      const key = kind + abs;
      if (done.has(key)) return;
      done.add(key);
      emit(`${kind} ${JSON.stringify(abs)}`);
    };
    const recordUrl = (url) => {
      if (typeof url !== "string" || !url.startsWith("file:")) return;
      try {
        record("R", fileURLToPath(url));
      } catch {
        /* not a path we can name */
      }
    };

    // 1. Modules: every file resolved or loaded, ESM and CommonJS alike.
    if (typeof module.registerHooks === "function") {
      module.registerHooks({
        resolve(specifier, context, next) {
          const result = next(specifier, context);
          recordUrl(result?.url);
          return result;
        },
        load(url, context, next) {
          recordUrl(url);
          return next(url, context);
        },
      });
    } else {
      emit("U no-module-hooks");
    }

    // 2. The file system. With --permission-audit every check that the permission model makes
    //    is published here, including the ones made by Node's own internals; nothing is denied.
    if (AUDIT) {
      dc.subscribe("node:permission-model:fs", (message) => {
        const resource = message?.resource;
        if (typeof resource !== "string" || !resource) return;
        record(message.permission === "FileSystemWrite" ? "W" : "R", resource);
      });
    } else {
      patchFs(record, (kind, value) => {
        const line = `${kind} ${JSON.stringify(value)}`;
        if (done.has(line)) return;
        done.add(line);
        emit(line);
      });
    }

    // 3. The environment.
    const ownVar = /^(TEST_MEMO_|NODE_TEST_CONTEXT$)/;
    const readVars = new Set();
    let enumerated = false;
    const noteVar = (name) => {
      if (typeof name !== "string" || readVars.has(name)) return;
      readVars.add(name);
      if (!ownVar.test(name)) emit(`E ${JSON.stringify(name)}`);
    };
    process.env = new Proxy(realEnv, {
      get(target, name) {
        noteVar(name);
        return Reflect.get(target, name);
      },
      has(target, name) {
        noteVar(name);
        return Reflect.has(target, name);
      },
      getOwnPropertyDescriptor(target, name) {
        noteVar(name);
        return Reflect.getOwnPropertyDescriptor(target, name);
      },
      ownKeys(target) {
        if (!enumerated) {
          enumerated = true;
          emit("N");
        }
        return Reflect.ownKeys(target);
      },
      set: (target, name, value) => Reflect.set(target, name, value),
      deleteProperty: (target, name) => Reflect.deleteProperty(target, name),
      defineProperty: (target, name, descriptor) => Reflect.defineProperty(target, name, descriptor),
    });

    // 4. Child processes: every one is written down, and a child given its own `env` still
    //    gets the tracer, or its reads would be invisible.
    const withTracer = (env) => {
      const out = { ...env };
      for (const name of Object.keys(realEnv)) if (name.startsWith("TEST_MEMO_")) out[name] ??= realEnv[name];
      let options = out.NODE_OPTIONS || "";
      if (IMPORT && !options.includes(IMPORT)) options = `${options} ${IMPORT}`;
      if (AUDIT && !options.includes("--permission-audit")) options = `${options} --permission-audit`;
      out.NODE_OPTIONS = options.trim();
      return out;
    };
    const isNode = (file) => {
      if (typeof file !== "string") return false;
      if (file === process.execPath) return true;
      const base = path.basename(file).toLowerCase();
      return base === "node" || base === "node.exe";
    };
    const looksLikePath = (s) => typeof s === "string" && s.length < 4096 && /[\\/.]/.test(s) && !s.startsWith("-");
    // Arguments that look like paths are inputs whether or not they exist: the orchestrator
    // records an absent one as absent, so a file appearing there later counts as a change.
    const notePathArgs = (cwd, list) => {
      for (const arg of list) {
        if (!looksLikePath(arg)) continue;
        try {
          record("R", path.resolve(cwd, arg));
        } catch {
          /* not a path */
        }
      }
    };
    const adjust = (name, shell, args) => {
      try {
        const file = name === "fork" ? process.execPath : args[0];
        let argv = [];
        let at = 1;
        // spawn(cmd, args?, options?): the args slot may be an array, or undefined/null with
        // the options after it.
        if (!shell && (Array.isArray(args[1]) || (args[1] == null && args.length > 2))) {
          argv = args[1] ?? [];
          at = 2;
        }
        let options = args[at];
        if (options === null || typeof options !== "object" || Array.isArray(options)) {
          options = {};
          args.splice(at, 0, options);
        } else {
          options = { ...options };
          args[at] = options;
        }
        options.env = withTracer(options.env ?? realEnv);
        const cwd = options.cwd ? path.resolve(String(options.cwd)) : process.cwd();
        const words = shell ? String(file).split(/\s+/) : [String(file), ...argv.map(String)];
        emit(
          `S ${JSON.stringify({
            via: name,
            cmd: words[0],
            node: name === "fork" || isNode(words[0]),
            args: words.slice(1, 9).map((w) => w.slice(0, 300)),
            cwd,
            gitDir: Boolean(options.env.GIT_DIR),
          })}`,
        );
        notePathArgs(cwd, words.slice(1));
      } catch {
        /* never break the test because of the tracer */
      }
      return args;
    };
    const patchSpawn = (name, shell) => {
      if (typeof cp[name] === "function") cp[name] = wrapFunction(cp[name], (args) => adjust(name, shell, args));
    };
    for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "fork"]) patchSpawn(name, false);
    for (const name of ["exec", "execSync"]) patchSpawn(name, true);

    // ESM named imports of builtins (`import { readFileSync } from "node:fs"`) are copies made
    // when the facade was first created; this refreshes them with the patched functions.
    module.syncBuiltinESMExports();
  } catch (error) {
    // A half-installed tracer means an incomplete trace: say so, and let the test run.
    emit(`U tracer-error:${String(error?.message ?? error).slice(0, 200)}`);
  }
  process.on("exit", (code) => emit(`X ${code}`));
}

// `util.promisify(execFile)` does not call execFile: it calls the function stored under
// `util.promisify.custom`, which resolves to { stdout, stderr }. Both are wrapped, and the
// wrapper keeps every other property of the original.
function wrapFunction(original, before) {
  const wrapper = function (...args) {
    return original.apply(this, before(args));
  };
  for (const k of Reflect.ownKeys(original)) {
    if (k === "prototype" || k === "arguments" || k === "caller" || k === promisify.custom) continue;
    Object.defineProperty(wrapper, k, Object.getOwnPropertyDescriptor(original, k));
  }
  const custom = original[promisify.custom];
  if (typeof custom === "function") {
    Object.defineProperty(wrapper, promisify.custom, {
      value: (...args) => custom(...before(args)),
      configurable: true,
      writable: true,
    });
  }
  return wrapper;
}

// Without --permission-audit (older Node), the public fs API is wrapped instead. Node's own
// internals bypass it, which is why the audit channel is preferred when it exists.
function patchFs(record, emitRaw) {
  const reads = [
    "readFileSync",
    "readFile",
    "existsSync",
    "exists",
    "statSync",
    "stat",
    "lstatSync",
    "lstat",
    "accessSync",
    "access",
    "opendirSync",
    "opendir",
    "realpathSync",
    "realpath",
    "readlinkSync",
    "readlink",
    "createReadStream",
    "statfsSync",
    "statfs",
  ];
  const writes = [
    "writeFileSync",
    "writeFile",
    "appendFileSync",
    "appendFile",
    "mkdirSync",
    "mkdir",
    "rmSync",
    "rm",
    "rmdirSync",
    "rmdir",
    "unlinkSync",
    "unlink",
    "createWriteStream",
    "truncateSync",
    "truncate",
    "utimesSync",
    "utimes",
    "lutimesSync",
    "lutimes",
    "chmodSync",
    "chmod",
    "lchmodSync",
    "lchmod",
    "chownSync",
    "chown",
    "lchownSync",
    "lchown",
    "symlinkSync",
    "symlink",
    "mkdtempSync",
    "mkdtemp",
  ];
  const wrap = (object, name, fn) => {
    if (typeof object?.[name] !== "function") return;
    object[name] = wrapFunction(object[name], (args) => {
      try {
        fn(args);
      } catch {
        /* never break the test because of the tracer */
      }
      return args;
    });
  };
  const asPath = (p) => (p instanceof URL ? fileURLToPath(p) : Buffer.isBuffer(p) ? p.toString() : p);
  const str = (p) => typeof asPath(p) === "string";
  const WRITE_BITS =
    fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND;
  for (const object of [fs, fs.promises]) {
    for (const name of reads) wrap(object, name, (a) => str(a[0]) && record("R", asPath(a[0])));
    for (const name of writes) wrap(object, name, (a) => str(a[0]) && record("W", asPath(a[0])));
    for (const name of ["readdirSync", "readdir"])
      wrap(object, name, (a) => str(a[0]) && record(a[1]?.recursive ? "T" : "R", asPath(a[0])));
    for (const name of ["cpSync", "cp"])
      wrap(object, name, (a) => {
        if (str(a[0])) record("C", asPath(a[0]));
        if (str(a[1])) record("W", asPath(a[1]));
      });
    for (const name of ["renameSync", "rename"])
      wrap(object, name, (a) => {
        if (str(a[0])) record("W", asPath(a[0]));
        if (str(a[1])) record("W", asPath(a[1]));
      });
    for (const name of ["copyFileSync", "copyFile", "linkSync", "link"])
      wrap(object, name, (a) => {
        if (str(a[0])) record("R", asPath(a[0]));
        if (str(a[1])) record("W", asPath(a[1]));
      });
    for (const name of ["openSync", "open"])
      wrap(object, name, (a) => {
        if (!str(a[0])) return;
        const flags = a[1] ?? "r";
        const writes = typeof flags === "number" ? (flags & WRITE_BITS) !== 0 : !/^(r|rs|sr)$/.test(String(flags));
        const readsToo = typeof flags === "number" ? (flags & fs.constants.O_WRONLY) === 0 : /r|\+/.test(String(flags));
        if (readsToo) record("R", asPath(a[0]));
        if (writes) record("W", asPath(a[0]));
      });
    // A glob is re-run when the cache is checked: its result is the input, not the directory.
    for (const name of ["globSync", "glob"])
      wrap(object, name, (a) => {
        const options = typeof a[1] === "object" && a[1] ? a[1] : {};
        const cwd = path.resolve(options.cwd ? String(asPath(options.cwd)) : process.cwd());
        if (typeof options.exclude === "function") return record("T", cwd);
        emitRaw("G", { pattern: a[0], cwd, exclude: options.exclude });
      });
  }
  wrap(process, "loadEnvFile", (a) => record("R", a[0] === undefined ? ".env" : asPath(a[0])));
}
