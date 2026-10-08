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
       connections, servers, name lookups    net, dgram, dns
       child processes started               child_process: Node children get the tracer,
                                             other programs run under strace (Linux)
       native addons loaded                  process.dlopen: the file runs under strace
                                             next time (Linux)
```

After the run, each test file that passed is stored with the content hash of every path it
read (or "absent", for paths it looked for and did not find), the names of the folders it
listed, and the values of the variables it read. Inputs inside the project are stored relative
to the root, so every git worktree and CI workspace of the same project shares one cache.

A stored pass is reused only when all of that still matches, and:

- the Node version, platform, time zone, locale, `package.json`, lockfiles and `node --test`
  flags are the same;
- it was proven **on the same calendar day**, in UTC, in the local time zone and in any zone you
  add, and less than 24 hours ago. The clock is the input nobody declares: a test that compares
  a fixture with "today" breaks at midnight with no file changing, and this is what reruns it;
- no input was modified while the run was in progress.

### Programs other than Node, and native addons

What `bash`, `pdftotext` or `php` read, and what a native addon opens by itself, never passes
through Node. On Linux, with `strace` installed, `test-memo` reads it from the kernel instead:

- a program other than Node that a test starts runs under `strace -f`, put in front of it by the
  tracer at the moment it is spawned. Every file it and its children opened, stat'ed, listed or
  executed becomes an input, its executable too, and so does the whole environment it was given;
- a test file that loads a native addon runs whole under `strace -f` from its second run on, in
  a second `node --test` next to the first.

The cost stays small because only those processes are traced, and `--seccomp-bpf` stops them only
on the calls that matter. Without strace (macOS, Windows, a container without it) those files are
simply never cached.

### The network

A test that connects to a server one of its own processes started is self-contained. A
connection to anything else, a name lookup, or a UDP socket depends on state no file holds, and
the file is not cached. When a service's state does come from files, such as a database cloned
per test from your migrations, declare it in `services`, and those connections count as part of
the test. A refused connection to this machine (a probe for "nothing listens there") does not
count.

### What is never cached

- **A file that failed.** Only passes are remembered.
- **A file that wrote inside the project** (outside the paths you allow).
- **A file that talked to the network** or to a local service it did not start, unless declared.
- **A file that ran a program other than Node or git, or loaded a native addon, without strace
  to see it**, unless you declare the program's output depends only on its arguments
  (`pureCommands`) or accept the addon (`nativeAddons`).
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
| `pureCommands` | programs whose output depends only on their arguments (not traced) |
| `services` | addresses (`host:port`, `unix:/path`, `*` allowed) whose state comes only from files the tests read or from what each test put there |
| `nativeAddons` | native addons (path fragments) accepted without kernel tracing |
| `timeZones` | extra zones whose calendar day a pass is bound to |
| `kernelTrace` | `auto` (default: strace when available) or `off`; also `TEST_MEMO_KERNEL` |

`report.misses` explains every rerun (`file ./src/db.js`, `env DATABASE_URL`, `git state`),
which is also the fastest way to see which inputs your tests really depend on.

## How we know it is right

Two real suites, measured on 2026-10-08 (Node 26, Linux):

**A project with 377 `node:test` files** that start servers, talk to PostgreSQL, run git and
spawn child processes:

- **Kernel audit.** The whole suite ran under `strace -f`, and every `open`, `stat`, `access`
  and `readlink` the kernel saw inside the project was checked against what `test-memo`
  recorded for that test file: 35 929 accesses, none missing. (The only leftover was a native
  OCR library probing a font folder by relative path, which does not exist.)
- **Mutation.** One input at a time was broken (a `throw` at the top of a module, a type
  error, an emptied document) and the whole suite was run: 22 mutations on 0.1.0 and 19 on
  0.2.0, 689 failing test files in total, **every one of them among the files `test-memo`
  would have rerun**. Zero false hits. Nine of the 0.2.0 mutations were aimed at files only
  another program reads (shell scripts run by `bash`, a PHP plugin run by `php`, an image put
  into a PDF), which only the kernel tracing can see.
- **Selection.** With nothing changed, all but 6 of its 378 files are skipped: those talk to
  GitHub, to Docker or to a host on the internet, or write into the project, and always run.
  A one-file change reran a median of 29 files; breaking the 10 000-line `server.js` reran 104
  (59 of them failed), where a static import-graph selector chose 158.
- **The network rule found real dependencies** the first version missed: a test reaching a
  live media server, a deploy script calling GitHub. They are no longer cached.

**[Fastify](https://github.com/fastify/fastify)**, 196 test files and 2 350 tests, unchanged:
all of them pass under the tracer and all of them are cacheable (one loads a native addon and is
kernel-traced). `test-memo verify` with ten mutations on 0.2.0: 1 293 failing test files, every
one of them rerun (1 of 196 for a helper read by one test, 186 for the error module), and
nothing it skipped failed.

Run the same proof on your own suite, at random or on the files you worry about:

```sh
npx test-memo verify --mutations=10 test/
npx test-memo verify --targets=scripts/deploy.sh,fixtures/logo.png test/
```

It breaks one committed, unmodified input at a time, runs everything, checks that every failing
file would have rerun, and puts each file back byte for byte, even on Ctrl-C.

## How much faster

Time to run the tests, before and with `test-memo`, on a laptop (2026-10-08).

**Fastify** (196 test files):

| What changed | Before | With test-memo |
|---|---:|---:|
| Nothing | 27 s | 0.2 s |
| The logger, read by 27 files | 27 s | 13 s |
| The error module, read by 185 files | 27 s | 28 s |

**A larger project** (442 test files, its whole pre-push check):

| What changed | Before | With test-memo |
|---|---:|---:|
| Nothing | 72 s | 28 s |
| One script | 72 s | 26 s |
| One server module | 72 s | 67 s |

The saving follows how far a change reaches. The project never drops below about 25 s: its
check also type-checks, lints and builds, and 12 of its test files always run (they talk to
the network or write into the project). The first run of each day runs everything again, and
costs about 10 % more than without `test-memo`, because everything is traced.

## Limits

- **Luck and the hour.** A test whose verdict depends on randomness, or on the time of day,
  passes or fails without any input changing. `test-memo` does not roll the dice again until an
  input changes or the day ends, so such a test shows its failure later than it would have.
  It was flaky already; the day boundary bounds the delay.
- **Declared services are a promise.** A service listed in `services` is trusted to hold
  nothing a file does not. If it does, that state is invisible.
- **Kernel tracing is Linux with `strace`.** Elsewhere, files that run other programs or load
  native addons always run. Under strace, `child.pid` is strace's, and killing the child kills
  strace, which kills the program (`--kill-on-exit`).
- Needs Node 22.15 or later (`module.registerHooks`). Tested on Node 24 and 26, Linux.
  Windows should work but is not proven yet.

## License

MIT
