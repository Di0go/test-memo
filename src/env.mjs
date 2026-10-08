// Which environment variables count as inputs, and how their values are compared.
//
// A variable read by a test is an input. Values are compared after replacing the project
// root with a placeholder, so two checkouts of the same project (git worktrees, CI
// workspaces) share results. Terminal, desktop and agent-session noise never counts: it
// changes between shells and says nothing about the code under test. `GIT_*` counts only
// for tests that start git, which is the only thing that reads it.

import { sha } from "./state.mjs";

export const NOISE = [
  /^TEST_MEMO_/,
  /^NODE_TEST_CONTEXT$/,
  /^(PWD|OLDPWD|SHLVL|_)$/,
  /^TERM($|_)/,
  /^COLORTERM$/,
  /^(SSH|GPG|XDG|DBUS|WAYLAND|KDE|GNOME|KONSOLE|TMUX|VSCODE|ITERM|OTEL|CLAUDE|ANTHROPIC|CODEX)_/,
  /^(CLAUDECODE|TMUX|STY|WINDOWID|DISPLAY|XAUTHORITY|DESKTOP_SESSION|SESSION_MANAGER|WT_SESSION)$/,
  /^(MAIL|LOGNAME|HOSTNAME|MOTD_SHOWN|LS_COLORS|LESS|LESSOPEN|LESSCLOSE|PAGER|EDITOR|VISUAL|HISTFILE)$/,
  /^(ZSH|PS1|PS2|PROMPT|INVOCATION_ID|JOURNAL_STREAM|MANAGERPID|MANAGERPIDFDID|SYSTEMD_EXEC_PID)$/,
  /^(DEBUGINFOD_URLS|GIT_ASKPASS|SSH_ASKPASS|npm_config_user_agent|INIT_CWD)$/,
];

export function envRules({ root, ignore = [], volatile = [], ownImport = "" }) {
  const extra = ignore.map((p) => (p instanceof RegExp ? p : new RegExp(`^${p.replace(/\*/g, ".*")}$`)));
  const volatileSet = new Set(volatile);
  const isNoise = (name) => NOISE.some((r) => r.test(name)) || extra.some((r) => r.test(name));
  const normalise = (name, value) => {
    if (value === undefined) return undefined;
    if (volatileSet.has(name)) return "<set>";
    let v = String(value);
    if (name === "NODE_OPTIONS") {
      v = v.replace(ownImport, "").replace("--permission-audit", "").replace(/\s+/g, " ").trim();
    }
    return root ? v.split(root).join("<root>") : v;
  };
  return {
    isNoise,
    /** The comparable value of one variable: a hash, or "-" when unset. */
    value(env, name) {
      const v = normalise(name, env[name]);
      return v === undefined ? "-" : sha(v);
    },
    /** One hash for the whole environment, for tests that enumerate it. */
    whole(env, { withGit }) {
      const names = Object.keys(env)
        .filter((n) => !isNoise(n) && (withGit || !n.startsWith("GIT_")))
        .sort();
      return sha(names.map((n) => `${n}=${normalise(n, env[n])}`).join("\0"));
    },
  };
}
