# test-memo

**Skip the `node:test` files whose inputs have not changed since they last passed.**

`test-memo` runs your suite with `node --test`, and while it runs it writes down what every
test file actually touched: the modules it loaded, the files and folders it read, the
environment variables it looked at, and the same for every child process and worker thread it
started. Next time, a test file whose recorded inputs are all byte-for-byte the same is not run
again: it already passed with exactly this.

```
$ test-memo --mode=skip test/*.test.js
...
test-memo: 377 files, 348 skipped (same inputs already passed), 29 ran, 10 remembered, 19 not cacheable
```

It is the idea behind `ccache`'s direct mode and Bazel's test cache, applied to `node:test`,
without a build system, a daemon or a config file. Zero dependencies.

## Why

Most CI time is spent proving again what was already proven. A pull request that touches two
files reruns the whole suite before the push, again in CI, and again in every other checkout.
Test selection from a static import graph (`jest --changedSince`, `vitest --changed`) helps,
but it cannot see what a test reads with `fs`, what a child process loads, or which
environment variable decides a branch, so it is not safe to *skip* on; it is only safe to
*start* with.

Tracing what really happened is. A test file is a program; if every input it read is
unchanged, it reads the same inputs again and reaches the same verdict.

## How it works

```
node --test --import test-memo/tracer   (through NODE_OPTIONS, so children inherit it)
  └─ every test file, child process and worker records, as it runs:
       modules resolved and loaded           module.registerHooks
       files read, stat'ed, listed, copied   fs and fs/promises (or --permission-audit)
       globs, and what they matched          fs.glob / fs.globSync
       environment variables read            a Proxy on process.env
       child processes started               child_process (and the tracer is injected
                                             into children that get their own env)
```

After the run, each test file that passed is stored with the content hash of every path it
read (or "absent", for paths it looked for and did not find), the names of the folders it
listed, and the values of the variables it read. Inputs inside the project are stored relative
to the root, so every git worktree and CI workspace of the same project shares one cache.

A stored pass is reused only when all of that still matches, and:

- the Node version, platform, `package.json`, lockfiles and `node --test` flags are the same;
- it is less than 24 hours old (dates leak into tests more than anyone admits);
- no input was modified while the run was in progress.

### What is never cached

- **A file that failed.** Only passes are remembered.
- **A file that wrote inside the project** (outside the paths you allow).
- **A file that ran a program other than Node or git** (`sh`, `docker`, `curl`...), unless you
  declare that program's output depends only on its arguments. Its reads are invisible.
- **A file whose own trace is incomplete**, such as a child Node process that never reported
  back.

Git is understood: a test that runs `git` inside the project depends on `HEAD`, every ref and
`git status`.

### Shadow mode first

The default mode is `shadow`: everything runs as usual, and `test-memo` only computes what it
*would* have skipped. If a file it would have skipped fails, it says so loudly
(`FALSE HIT`) and logs it. Run it like this for a while, then switch to `--mode=skip`.

## Usage

```sh
npm install --save-dev github:Di0go/test-memo

npx test-memo                                   # default node:test patterns, shadow mode
npx test-memo --mode=skip --test-timeout=60000 test/
TEST_MEMO_MODE=off npx test-memo                # plain node --test, no tracing
```

Any `--flag` that is not test-memo's own goes to `node --test`. From code:

```js
import { run } from "test-memo";
const report = await run({ root, files, nodeArgs: ["--test-timeout=60000"], mode: "skip" });
// report.hits, report.misses (with the first input that changed), report.falseHits, report.failed
```

Options (also in `package.json` under `"testMemo"`):

| option | meaning |
|---|---|
| `mode` | `shadow` (default), `skip`, or `off` |
| `cacheDir` | where results live; default `node_modules/.cache/test-memo`, or `TEST_MEMO_CACHE_DIR` |
| `maxAgeHours` | how long a pass stays reusable (24) |
| `ignoreEnv` | variables that never count (globs); terminal and session noise is already ignored |
| `volatileEnv` | variables whose value changes every run but does not matter, such as a database URL with a random name |
| `allowWrites` | project paths a test may write to and stay cacheable |
| `pureCommands` | programs whose output depends only on their arguments |

`report.misses` explains every rerun (`file ./src/db.js`, `env DATABASE_URL`, `git state`),
which is also the fastest way to see which inputs your tests really depend on.

## How we know it is right

Two real suites, measured on 2026-10-08 (Node 26, Linux):

**A CRM with 377 `node:test` files** that start servers, talk to PostgreSQL, run git and spawn
child processes:

- **Kernel audit.** The whole suite ran under `strace -f`, and every `open`, `stat`, `access`
  and `readlink` the kernel saw inside the project was checked against what `test-memo`
  recorded for that test file: 35 929 accesses, none missing. (The only leftover was a native
  OCR library probing a font folder by relative path, which does not exist.)
- **Mutation.** One input at a time was broken (a `throw` at the top of a module, a type
  error, an emptied document) and the whole suite was run: 22 mutations, 439 failing test
  files in total, **every one of them among the files `test-memo` would have rerun**. Zero
  false hits.
- **Selection.** With nothing changed, 358 of the 377 files are skipped; the other 19 run
  programs whose reads cannot be seen (`bash`, `docker`) and always run. A one-file change
  reran a median of 29 files; breaking the 10 000-line `server.js` reran 104 (59 of them
  failed), where a static import-graph selector chose 158.

**[Fastify](https://github.com/fastify/fastify)**, 196 test files and 2 350 tests, unchanged:
all of them pass under the tracer and all of them are cacheable. `test-memo verify` with ten
mutations reran exactly the files that broke (1 of 196 for a helper read by one test, 27 for
the logger, 185 for the error module), and nothing it skipped failed.

Run the same proof on your own suite:

```sh
npx test-memo verify --mutations=10 test/
```

It breaks one committed, unmodified input at a time, runs everything, checks that every failing
file would have rerun, and puts each file back byte for byte, even on Ctrl-C.

Overhead while tracing is 7-10 % of the traced run (25.9 s to 27.9 s on Fastify); only the
files that actually run pay it.

## Limits

- Inputs that are not files, variables or processes are not seen: the clock, the network, a
  database's state, randomness. A test that depends on them is flaky already; the 24-hour
  limit and shadow mode are the safety nets.
- Reads made by native addons straight through libc are not traced (an image library opening a
  file by path). If the test does not also read that file itself, declare it or keep the test
  uncacheable.
- Needs Node 22.15 or later (`module.registerHooks`). Tested on Node 24 and 26, Linux.
  Windows should work but is not proven yet.

## License

MIT
