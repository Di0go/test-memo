// The state of a path, as a short string that is equal iff a test would see the same thing:
//
//   f:<hash>   a file, by content
//   d:<hash>   a directory, by the names and types of its entries
//   t:<hash>   a directory tree, recursively (for recursive listings and copies)
//   -          nothing there
//   o          something else (socket, device)
//
// Hashing is memoised for the life of one run, and file hashes are kept between runs by
// (size, mtime, ctime, inode), the way git's index does. A file modified too recently is always
// re-read: its mtime cannot yet be trusted (see racyMs).

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// A file changed this close to a moment cannot be told apart from one changed after it. On
// filesystems with whole-second timestamps (FAT, ext3, some network mounts) that is up to two
// seconds; with nanosecond timestamps a few milliseconds of clock skew.
const racyMs = (st) => (st.mtimeMs % 1000 === 0 && st.ctimeMs % 1000 === 0 ? 2000 : 20);
const SKIP_IN_TREES = new Set(["node_modules", ".git"]);

const sha = (data) => createHash("sha256").update(data).digest("base64url").slice(0, 27);

export class States {
  constructor({ statCacheFile } = {}) {
    this.statCacheFile = statCacheFile;
    this.memo = new Map();
    this.known = new Map();
    this.dirty = false;
    if (statCacheFile) {
      try {
        this.known = new Map(Object.entries(JSON.parse(fs.readFileSync(statCacheFile, "utf8"))));
      } catch {
        /* first run, or a cache from another version: start empty */
      }
    }
  }

  /** The state of `abs` now. */
  of(abs) {
    let state = this.memo.get(abs);
    if (state === undefined) {
      state = this.compute(abs);
      this.memo.set(abs, state);
    }
    return state;
  }

  compute(abs) {
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      return "-";
    }
    if (st.isDirectory()) return `d:${this.listing(abs)}`;
    if (!st.isFile()) return "o";
    const stamp = `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`;
    const cached = this.known.get(abs);
    if (cached && cached[0] === stamp) return cached[1];
    let content;
    try {
      content = fs.readFileSync(abs);
    } catch {
      return "-";
    }
    const state = `f:${sha(content)}`;
    if (Date.now() - Math.max(st.mtimeMs, st.ctimeMs) > racyMs(st)) {
      this.known.set(abs, [stamp, state]);
      this.dirty = true;
    }
    return state;
  }

  listing(abs) {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return "?";
    }
    const names = entries.map((e) => `${e.name}\0${e.isDirectory() ? "d" : e.isFile() ? "f" : "o"}`).sort();
    return sha(names.join("\n"));
  }

  /** Only what kind of thing is there: "d", "f", "o" or "-". */
  kind(abs) {
    try {
      const st = fs.statSync(abs);
      return st.isDirectory() ? "d" : st.isFile() ? "f" : "o";
    } catch {
      return "-";
    }
  }

  /** A whole tree, recursively: names and types, plus the content of every file if `withContent`. */
  tree(abs, withContent = true) {
    const key = `tree${withContent ? "+" : "-"}\0${abs}`;
    let state = this.memo.get(key);
    if (state !== undefined) return state;
    const lines = [];
    const walk = (dir, rel) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const e of entries) {
        if (SKIP_IN_TREES.has(e.name)) continue;
        const full = path.join(dir, e.name);
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          lines.push(`${r}/`);
          walk(full, r);
        } else lines.push(withContent ? `${r} ${this.of(full)}` : `${r} ${e.isFile() ? "f" : "o"}`);
      }
    };
    try {
      if (!fs.statSync(abs).isDirectory()) state = this.of(abs);
    } catch {
      state = "-";
    }
    if (state === undefined) {
      walk(abs, "");
      state = `t:${sha(lines.join("\n"))}`;
    }
    this.memo.set(key, state);
    return state;
  }

  /** The sorted result of a glob, as the test would see it now. */
  glob({ pattern, cwd, exclude }) {
    const key = `glob\0${JSON.stringify([pattern, cwd, exclude])}`;
    let state = this.memo.get(key);
    if (state === undefined) {
      try {
        state = `g:${sha(fs.globSync(pattern, { cwd, exclude }).sort().join("\n"))}`;
      } catch {
        state = "?";
      }
      this.memo.set(key, state);
    }
    return state;
  }

  /** Was `abs` touched after `since` (or too close to it to tell)? */
  changedSince(abs, since) {
    try {
      const st = fs.statSync(abs);
      return Math.max(st.mtimeMs, st.ctimeMs) >= since - racyMs(st);
    } catch {
      return false;
    }
  }

  save() {
    if (!this.statCacheFile || !this.dirty) return;
    // Keep the file from growing forever: drop paths that no longer exist.
    for (const abs of this.known.keys()) if (!fs.existsSync(abs)) this.known.delete(abs);
    writeAtomic(this.statCacheFile, JSON.stringify(Object.fromEntries(this.known)));
  }
}

export function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export { sha };
