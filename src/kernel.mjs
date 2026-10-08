// What the in-process tracer cannot see, read through the kernel instead:
//
// - a program other than Node (`bash`, `pdftotext`, `php`...) that a test starts runs under
//   `strace -f`, put in front of it by the tracer at the moment it is spawned;
// - a test file that loads a native addon runs, whole, under `strace -f` the next time.
//
// Every path those processes opened, stat'ed, listed or executed becomes an input like any
// other. Linux only, and only when `strace` is installed; without it those files are simply
// not remembered.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const TRACE = "%file,%process,fchdir,getdents64,connect,bind";

/** The `strace` command line to put in front of a command (before `-o`), or null. */
export function kernelTracer() {
  if (process.platform !== "linux") return null;
  // --seccomp-bpf stops the traced process only on the syscalls asked for, which keeps the
  // cost close to nothing; --kill-on-exit makes killing strace kill what it traces, as killing
  // the program would have. Older strace builds without them still work.
  for (const extra of [["--seccomp-bpf", "--kill-on-exit"], ["--seccomp-bpf"], []]) {
    const r = spawnSync("strace", ["-f", "-qq", ...extra, "-e", `trace=${TRACE}`, "-o", "/dev/null", "--", "true"], {
      stdio: "ignore",
      timeout: 10_000,
    });
    if (r.status === 0) return ["strace", "-f", "-ff", "-qq", "-y", ...extra, "-e", "signal=none", "-e", `trace=${TRACE}`];
  }
  return null;
}

// Sockets the C library talks to on its own (user and host lookups, logging): not inputs.
const SYSTEM_SOCKETS = /^\/(var\/)?run\/(nscd\/|systemd\/userdb\/|systemd\/journal\/)|^\/dev\/log$/;

const WRITE_FLAGS = /O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_APPEND/;
const WRITES = new Set([
  "creat",
  "mkdir",
  "mkdirat",
  "rmdir",
  "unlink",
  "unlinkat",
  "rename",
  "renameat",
  "renameat2",
  "link",
  "linkat",
  "symlink",
  "symlinkat",
  "truncate",
  "chmod",
  "fchmodat",
  "fchmodat2",
  "chown",
  "lchown",
  "fchownat",
  "utime",
  "utimes",
  "utimensat",
  "futimesat",
  "mknod",
  "mknodat",
  "setxattr",
  "lsetxattr",
  "removexattr",
  "lremovexattr",
]);
const CLONES = new Set(["clone", "clone3", "fork", "vfork"]);

// `reads`: files opened and folders listed, whose content counts. `stats`: paths only checked
// (stat, access, a folder opened to work inside it), where for a folder only its existence does;
// a home folder that changes all day long must not make every shell script a miss.
const empty = () => ({ reads: new Set(), stats: new Set(), writes: new Set(), execs: new Set(), connects: [], listens: [] });

/**
 * A whole `node --test` that ran under `strace -ff -o <dir>/k`: what each test file's processes
 * did, attributed through the process ids the tracer wrote in its headers.
 * @param {string} dir
 * @param {Map<number, string>} pidTest  process id -> test file
 * @param {(abs: string) => boolean} keep
 */
export function readKernelTraces(dir, pidTest, keep) {
  const { procs, parent, threads } = parseDir(dir);
  const testOf = (tid) => {
    for (let t = tid, hops = 0; t !== undefined && hops < 1000; t = parent.get(t), hops++) {
      const test = pidTest.get(t);
      if (test) return test;
    }
    return null;
  };
  const byTest = new Map();
  for (const [tid, p] of procs) {
    const test = testOf(tid);
    if (!test) continue;
    if (!byTest.has(test)) byTest.set(test, empty());
    merge(byTest.get(test), p, keep, isNode(tid, pidTest, parent, threads));
  }
  return byTest;
}

/**
 * One program a test started, traced on its own (`<dir>/k.<tid>`): everything in it is the
 * test's. Null when strace left nothing behind.
 */
export function readSpawnTrace(dir, pidTest, keep) {
  const { procs, parent, threads } = parseDir(dir);
  if (!procs.size) return null;
  const out = empty();
  for (const [tid, p] of procs) merge(out, p, keep, isNode(tid, pidTest, parent, threads));
  return out;
}

// A Node process (or one of its threads) has its connections from the tracer already, which
// knows whether they succeeded; the kernel only sees an attempt in progress.
function isNode(tid, pidTest, parent, threads) {
  for (let t = tid, hops = 0; t !== undefined && hops < 1000; t = threads.has(t) ? parent.get(t) : undefined, hops++)
    if (pidTest.has(t)) return true;
  return false;
}

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+|0\.0\.0\.0|::)$/;

function merge(into, p, keep, node) {
  for (const r of p.reads) if (keep(r)) into.reads.add(r);
  for (const r of p.stats) if (keep(r)) into.stats.add(r);
  for (const w of p.writes) if (keep(w)) into.writes.add(w);
  for (const e of p.execs) into.execs.add(e);
  for (const c of p.connects) {
    if (c.path && SYSTEM_SOCKETS.test(c.path)) continue;
    if (node && c.host && LOOPBACK.test(c.host)) continue;
    into.connects.push(c);
  }
  if (!node) into.listens.push(...p.listens);
}

function parseDir(dir) {
  const procs = new Map();
  const parent = new Map();
  const threads = new Set();
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { procs, parent, threads };
  }
  for (const name of names) {
    const tid = Number(name.slice(name.lastIndexOf(".") + 1));
    if (!Number.isInteger(tid)) continue;
    const p = empty();
    procs.set(tid, p);
    let cwd = null;
    for (const line of fs.readFileSync(path.join(dir, name), "utf8").split("\n")) {
      const call = parseLine(line);
      if (!call) continue;
      const { name: sys, args, ret, errno } = call;
      const ok = ret !== null && ret >= 0;
      if (CLONES.has(sys)) {
        if (ok && ret > 0) {
          parent.set(ret, tid);
          if (args.some((a) => a.includes("CLONE_THREAD"))) threads.add(ret);
        }
        continue;
      }
      for (const a of args) {
        const dirfd = /^AT_FDCWD<(.*)>$/.exec(a);
        if (dirfd) cwd = unescape(dirfd[1]);
      }
      const at = (i) => resolveAt(args[i], args[i + 1], cwd);
      const plain = (i) => resolvePlain(args[i], cwd);
      if (sys === "getdents64") {
        const fd = fdPath(args[0]);
        if (fd) p.reads.add(fd);
      } else if (sys === "connect" || sys === "bind") {
        if (!ok && !(sys === "connect" && errno === "EINPROGRESS")) continue;
        const target = sockaddr(args[1]);
        if (target) (sys === "connect" ? p.connects : p.listens).push(target);
      } else if (sys === "chdir") {
        const d = plain(0);
        if (d) p.stats.add(d);
        if (ok && d) cwd = d;
      } else if (sys === "fchdir") {
        const d = fdPath(args[0]);
        if (ok && d) cwd = d;
      } else if (sys === "execve" || sys === "execveat") {
        const file = sys === "execve" ? plain(0) : at(0);
        if (!file) continue;
        if (ok) p.execs.add(file);
        else p.reads.add(file);
      } else if (sys === "open" || sys === "openat" || sys === "openat2") {
        const file = sys === "open" ? plain(0) : at(0);
        const flags = (sys === "open" ? args[1] : args[2]) ?? "";
        if (!file) continue;
        if (WRITE_FLAGS.test(flags)) {
          if (ok) p.writes.add(file);
          if (/O_RDWR/.test(flags)) p.reads.add(file);
        } else if (/O_DIRECTORY|O_PATH/.test(flags)) p.stats.add(file);
        else p.reads.add(file);
      } else if (sys === "inotify_add_watch") {
        const file = plain(1);
        if (file) p.stats.add(file);
      } else if (WRITES.has(sys)) {
        if (!ok) continue;
        for (const file of writtenPaths(sys, args, cwd)) p.writes.add(file);
      } else {
        // stat, access, readlink, statfs, getxattr...: the path is an input whether or not it
        // exists.
        const file = sys.endsWith("at") || sys.endsWith("at2") || sys === "statx" ? at(0) : plain(0);
        if (file) p.stats.add(file);
      }
    }
  }

  return { procs, parent, threads };
}

function writtenPaths(sys, args, cwd) {
  const at = (i) => resolveAt(args[i], args[i + 1], cwd);
  const plain = (i) => resolvePlain(args[i], cwd);
  switch (sys) {
    case "rename":
    case "link":
      return [plain(0), plain(1)].filter(Boolean);
    case "symlink":
      return [plain(1)].filter(Boolean);
    case "renameat":
    case "renameat2":
    case "linkat":
      return [at(0), at(2)].filter(Boolean);
    case "symlinkat":
      return [at(1)].filter(Boolean);
    default:
      return [sys.endsWith("at") || sys.endsWith("at2") ? at(0) : plain(0)].filter(Boolean);
  }
}

// `openat(AT_FDCWD</home/x>, "a.txt", O_RDONLY) = 3</home/x/a.txt>`
// `openat(AT_FDCWD</home/x>, "nope", O_RDONLY) = -1 ENOENT (No such file or directory)`
function parseLine(line) {
  const open = line.indexOf("(");
  if (open <= 0) return null;
  const name = line.slice(0, open);
  if (!/^\w+$/.test(name)) return null;
  // strace pads short calls so that the ` = ` lines up in a column: `chdir("/tmp")    = 0`.
  const eq = line.lastIndexOf(" = ");
  let close = eq;
  while (close > open && line[close - 1] === " ") close--;
  close--;
  if (eq < 0 || close <= open || line[close] !== ")") return null;
  const tail = /^(-?\d+|\?)(?:<[^>]*>)?(?:\s+(E\w+))?/.exec(line.slice(eq + 3));
  if (!tail) return null;
  return {
    name,
    args: splitArgs(line.slice(open + 1, close)),
    ret: tail[1] === "?" ? null : Number(tail[1]),
    errno: tail[2] ?? null,
  };
}

/** Top-level arguments, keeping strings, structures and arrays whole. */
function splitArgs(s) {
  const out = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === "\\") i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{" || c === "[" || c === "(" || c === "<") depth++;
    else if (c === "}" || c === "]" || c === ")" || c === ">") depth--;
    else if (c === "," && depth === 0) {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(s.slice(start).trim());
  return out;
}

function quotedString(arg) {
  const m = /^"((?:[^"\\]|\\.)*)"(\.\.\.)?$/.exec(arg ?? "");
  if (!m || m[2]) return null; // truncated: not a path we can name
  return unescape(m[1]);
}

function unescape(s) {
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== "\\") {
      bytes.push(...Buffer.from(c, "utf8"));
      continue;
    }
    const n = s[++i];
    if (n === "x") {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (/[0-7]/.test(n)) {
      let j = i;
      while (j < i + 3 && /[0-7]/.test(s[j])) j++;
      bytes.push(parseInt(s.slice(i, j), 8));
      i = j - 1;
    } else bytes.push({ n: 10, t: 9, r: 13, v: 11, f: 12 }[n] ?? n.charCodeAt(0));
  }
  return Buffer.from(bytes).toString("utf8");
}

function fdPath(arg) {
  const m = /^-?\d+<(.*)>$/.exec(arg ?? "");
  if (!m || m[1].startsWith("socket:") || m[1].startsWith("pipe:") || m[1].startsWith("anon_inode:")) return null;
  return unescape(m[1]);
}

function resolveAt(dirArg, fileArg, cwd) {
  const file = quotedString(fileArg);
  if (file === null || file === "") return null;
  if (path.isAbsolute(file)) return path.normalize(file);
  const dir = /^AT_FDCWD<(.*)>$/.exec(dirArg ?? "")?.[1] ?? fdPath(dirArg) ?? cwd;
  return dir ? path.resolve(unescape(dir), file) : null;
}

function resolvePlain(fileArg, cwd) {
  const file = quotedString(fileArg);
  if (file === null || file === "") return null;
  if (path.isAbsolute(file)) return path.normalize(file);
  return cwd ? path.resolve(cwd, file) : null;
}

// {sa_family=AF_INET, sin_port=htons(5432), sin_addr=inet_addr("127.0.0.1")}
// {sa_family=AF_INET6, sin6_port=htons(5432), ..., inet_pton(AF_INET6, "::1", &sin6_addr), ...}
// {sa_family=AF_UNIX, sun_path="/run/docker.sock"}
function sockaddr(arg) {
  if (!arg) return null;
  const family = /sa_family=(AF_\w+)/.exec(arg)?.[1];
  if (family === "AF_UNIX") {
    const p = /sun_path=(@?)"((?:[^"\\]|\\.)*)"/.exec(arg);
    if (!p) return null;
    return { path: p[1] ? `@${unescape(p[2])}` : unescape(p[2]) };
  }
  if (family === "AF_INET" || family === "AF_INET6") {
    const port = Number(/sin6?_port=htons\((\d+)\)/.exec(arg)?.[1]);
    const host = /inet_addr\("([^"]+)"\)/.exec(arg)?.[1] ?? /inet_pton\(AF_INET6, "([^"]+)"/.exec(arg)?.[1];
    if (!host) return null;
    return { host, port };
  }
  return null; // netlink and friends: the machine's own configuration
}
