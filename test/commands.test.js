import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  parsePythonCmd,
  pythonCandidates,
  registerCommands,
  runTrellisScript,
} from "../lib/commands.js";
import { nodeFs } from "../lib/node-fs.js";

const root = resolve("C:/trellis-command-test");

function projectFs({ trellis = true } = {}) {
  const paths = new Set([join(root, ".git")]);
  if (trellis) {
    paths.add(join(root, ".trellis", "workflow.md"));
    paths.add(join(root, ".trellis", "scripts", "task.py"));
  }
  return {
    async exists(path) {
      return paths.has(path);
    },
  };
}

function commandHarness() {
  const commands = new Map();
  const disposed = [];
  const ctx = {
    commands: {
      register(command) {
        commands.set(command.name, command);
        return () => disposed.push(command.name);
      },
    },
  };
  return { ctx, commands, disposed };
}

const resolved = {
  pythonCmd: "python-test",
  projectRootMarkers: [".git"],
};

const invocation = {
  agent: { session: { header: { cwd: join(root, "src"), id: "session one" } } },
  rawInput: "",
  attachments: [],
  signal: new AbortController().signal,
};

test("pythonCandidates uses platform-aware defaults and honors an override", () => {
  assert.deepEqual(pythonCandidates({ pythonCmd: "" }, "win32"), [
    { command: "py", prefixArgs: ["-3"] },
    { command: "python", prefixArgs: [] },
    { command: "python3", prefixArgs: [] },
  ]);
  assert.deepEqual(pythonCandidates({ pythonCmd: "" }, "linux"), [
    { command: "python3", prefixArgs: [] },
    { command: "python", prefixArgs: [] },
  ]);
  assert.deepEqual(pythonCandidates({ pythonCmd: "custom-python" }, "win32"), [
    { command: "custom-python", prefixArgs: [] },
  ]);
});

test("runTrellisScript falls back after a missing Windows launcher and exports the session id", async () => {
  const previousOuterContext = process.env.TRELLIS_CONTEXT_ID;
  process.env.TRELLIS_CONTEXT_ID = "claude_outer-session";
  const calls = [];
  try {
    const result = await runTrellisScript(
      { pythonCmd: "" },
      root,
      "abc def",
      ["current", "--source"],
      {
        platform: "win32",
        async execFile(command, args, options) {
          calls.push({ command, args, options });
          if (command === "py")
            throw Object.assign(new Error("missing"), { code: "ENOENT" });
          return { stdout: "Current task: demo\n", stderr: "" };
        },
      },
    );

    assert.equal(result.kind, "success");
    assert.deepEqual(
      calls.map(({ command }) => command),
      ["py", "python"],
    );
    assert.deepEqual(calls[0].args.slice(0, 2), [
      "-3",
      join(root, ".trellis", "scripts", "task.py"),
    ]);
    assert.equal(calls[1].options.env.DSH_SESSION_ID, "abc def");
    assert.equal(calls[1].options.env.DSH_SHELL, "1");
    assert.equal(calls[1].options.env.TRELLIS_CONTEXT_ID, "dsh_abc_def");
    assert.equal(
      calls[1].options.env.DSH_TRELLIS_CONTEXT_ID,
      "dsh_abc_def",
    );
  } finally {
    if (previousOuterContext === undefined) {
      delete process.env.TRELLIS_CONTEXT_ID;
    } else {
      process.env.TRELLIS_CONTEXT_ID = previousOuterContext;
    }
  }
});

test("trellis-finish is read-only and command disposal unregisters both commands", async () => {
  const { ctx, commands, disposed } = commandHarness();
  const calls = [];
  const dispose = registerCommands(ctx, resolved, {
    fs: projectFs(),
    platform: "win32",
    async execFile(command, args, options) {
      calls.push({ command, args, options });
      return { stdout: "Current task: .trellis/tasks/demo\n", stderr: "" };
    },
  });

  const result = await commands.get("trellis-finish").handler(invocation);
  assert.equal(result.kind, "success");
  assert.match(result.text, /did not clear or archive anything/);
  assert.equal(commands.get("trellis-status").recordInput, false);
  assert.equal(commands.get("trellis-finish").recordInput, false);
  assert.deepEqual(calls[0].args.slice(-2), ["current", "--source"]);
  assert.equal(calls[0].options.env.DSH_SESSION_ID, "session one");
  assert.equal(calls[0].options.env.DSH_SHELL, "1");
  assert.equal(calls[0].options.signal, invocation.signal);
  assert.ok(!calls[0].args.includes("finish"));

  dispose();
  assert.deepEqual(disposed.sort(), [
    "trellis-doctor",
    "trellis-finish",
    "trellis-status",
  ]);
});

test("zero-input commands reject rc.8 command envelope payloads before touching the project", async () => {
  const { ctx, commands } = commandHarness();
  let executed = false;
  registerCommands(ctx, resolved, {
    fs: projectFs(),
    async execFile() {
      executed = true;
      return { stdout: "", stderr: "" };
    },
  });

  const withText = await commands.get("trellis-status").handler({
    ...invocation,
    rawInput: " unexpected",
  });
  const withImage = await commands.get("trellis-finish").handler({
    ...invocation,
    attachments: [{ type: "image", mimeType: "image/png", data: "abc" }],
  });

  assert.equal(withText.kind, "error");
  assert.match(withText.text, /does not accept arguments/);
  assert.equal(withImage.kind, "error");
  assert.match(withImage.text, /attachments/);
  assert.equal(executed, false);
});

test("an aborted native command signal cancels execution without Python fallback", async () => {
  const controller = new AbortController();
  controller.abort();
  const calls = [];
  const result = await runTrellisScript(
    { pythonCmd: "" },
    root,
    "session",
    ["current"],
    {
      platform: "win32",
      signal: controller.signal,
      async execFile(command) {
        calls.push(command);
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
    },
  );

  assert.deepEqual(result, {
    kind: "error",
    text: "Trellis command cancelled.",
  });
  assert.deepEqual(calls, ["py"]);
});

test("commands reject a git repository that is not initialized for Trellis", async () => {
  const { ctx, commands } = commandHarness();
  let executed = false;
  registerCommands(ctx, resolved, {
    fs: projectFs({ trellis: false }),
    async execFile() {
      executed = true;
      return { stdout: "", stderr: "" };
    },
  });

  const result = await commands.get("trellis-status").handler(invocation);
  assert.equal(result.kind, "error");
  assert.match(result.text, /No Trellis project found/);
  assert.equal(executed, false);
});

test("runTrellisScript falls back on Windows exit 103/9009/EINVAL/Store stub without retrying real task errors", async () => {
  const calls = [];
  const ok = await runTrellisScript(
    { pythonCmd: "" },
    root,
    "abc",
    ["current", "--source"],
    {
      platform: "win32",
      async execFile(command) {
        calls.push(command);
        if (command === "py") throw Object.assign(new Error("no py3"), { code: 103 });
        if (command === "python") {
          throw Object.assign(new Error("store stub"), {
            code: 9009,
            stderr: "Python was not found; run without arguments to install from the Microsoft Store",
          });
        }
        return { stdout: "Current task: ok\n", stderr: "" };
      },
    },
  );
  assert.equal(ok.kind, "success");
  assert.deepEqual(calls, ["py", "python", "python3"]);

  const realFailCalls = [];
  const failed = await runTrellisScript(
    { pythonCmd: "" },
    root,
    "abc",
    ["current", "--source"],
    {
      platform: "win32",
      async execFile(command) {
        realFailCalls.push(command);
        throw Object.assign(new Error("script failed"), { code: 2, stderr: "traceback" });
      },
    },
  );
  assert.equal(failed.kind, "error");
  assert.deepEqual(realFailCalls, ["py"]);
});

test("command subprocesses scrub secret env vars and drop Trellis identity when session id is invalid", async () => {
  const saved = {
    TRELLIS_CONTEXT_ID: process.env.TRELLIS_CONTEXT_ID,
    DSH_TRELLIS_CONTEXT_ID: process.env.DSH_TRELLIS_CONTEXT_ID,
    DSH_SHELL: process.env.DSH_SHELL,
    DSH_SESSION_ID: process.env.DSH_SESSION_ID,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    CUSTOM_SECRET: process.env.CUSTOM_SECRET,
    DB_PASSWORD: process.env.DB_PASSWORD,
  };
  process.env.TRELLIS_CONTEXT_ID = "outer_host";
  process.env.DSH_TRELLIS_CONTEXT_ID = "outer_dsh";
  process.env.DSH_SHELL = "1";
  process.env.DSH_SESSION_ID = "outer_sid";
  process.env.DEEPSEEK_API_KEY = "sk-secret";
  process.env.GITHUB_TOKEN = "ghp-secret";
  process.env.CUSTOM_SECRET = "my-secret";
  process.env.DB_PASSWORD = "pw";

  try {
    const { ctx, commands } = commandHarness();
    const seenEnvs = [];
    registerCommands(ctx, resolved, {
      fs: projectFs(),
      platform: "win32",
      async execFile(command, _args, options) {
        seenEnvs.push({ command, env: options.env });
        return { stdout: command === "git" ? "## main" : "Current task: (none)\n", stderr: "" };
      },
    });
    const result = await commands.get("trellis-status").handler({
      ...invocation,
      agent: { session: { header: { cwd: root, id: "   " } } },
    });
    assert.equal(result.kind, "success");
    assert.equal(seenEnvs.length, 2);
    for (const { env } of seenEnvs) {
      assert.equal(env.DEEPSEEK_API_KEY, undefined);
      assert.equal(env.GITHUB_TOKEN, undefined);
      assert.equal(env.CUSTOM_SECRET, undefined);
      assert.equal(env.DB_PASSWORD, undefined);
    }
    const taskEnv = seenEnvs[0].env;
    assert.equal(taskEnv.TRELLIS_CONTEXT_ID, undefined);
    assert.equal(taskEnv.DSH_TRELLIS_CONTEXT_ID, undefined);
    assert.equal(taskEnv.DSH_SHELL, undefined);
    assert.equal(taskEnv.DSH_SESSION_ID, undefined);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("trellis-status and trellis-finish treat Current task exit 1 cleanly, suppress checklist on error, and honor aborts", async () => {
  const { ctx, commands } = commandHarness();
  let mode = "none-exit-1";
  const controller = new AbortController();
  registerCommands(ctx, resolved, {
    fs: projectFs(),
    platform: "linux",
    async execFile(command) {
      if (command === "git") {
        if (mode === "git-fail") throw new Error("not a git repo");
        if (mode === "git-abort") {
          controller.abort();
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        }
        return { stdout: "## main\n", stderr: "" };
      }
      if (mode === "none-exit-1" || mode === "git-fail" || mode === "git-abort") {
        throw Object.assign(new Error("exit 1"), {
          code: 1,
          stdout: "Current task: (none)\nSource: none\n",
          stderr: "",
        });
      }
      if (mode === "active-none") {
        return { stdout: "Active task: (none)\n", stderr: "" };
      }
      throw Object.assign(new Error("fatal script crash"), { code: 2, stdout: "", stderr: "boom" });
    },
  });

  const statusNone = await commands.get("trellis-status").handler(invocation);
  assert.equal(statusNone.kind, "success");
  assert.match(statusNone.text, /Current task: \(none\)/);
  assert.match(statusNone.text, /No active task\./);
  assert.match(statusNone.text, /\/trellis-start/);

  mode = "active-none";
  const statusActiveNone = await commands.get("trellis-status").handler(invocation);
  assert.match(statusActiveNone.text, /No active task\./);

  mode = "git-fail";
  const gitUnavailable = await commands.get("trellis-status").handler(invocation);
  assert.equal(gitUnavailable.kind, "success");
  assert.match(gitUnavailable.text, /Git status:\n\(unavailable\)/);

  mode = "none-exit-1";
  const finishNone = await commands.get("trellis-finish").handler(invocation);
  assert.equal(finishNone.kind, "success");
  assert.match(finishNone.text, /Current task: \(none\)/);
  assert.match(finishNone.text, /Wrap-up checklist/);
  assert.match(finishNone.text, /--skip-branch-validation/);

  mode = "crash";
  const finishErr = await commands.get("trellis-finish").handler(invocation);
  assert.equal(finishErr.kind, "error");
  assert.doesNotMatch(finishErr.text, /Wrap-up checklist/);

  mode = "git-abort";
  const aborted = await commands.get("trellis-status").handler({
    ...invocation,
    signal: controller.signal,
  });
  assert.deepEqual(aborted, { kind: "error", text: "Trellis command cancelled." });
});

test("parsePythonCmd and pythonCandidates handle flags, quoted executables, and unquoted paths with spaces", async (t) => {
  assert.deepEqual(parsePythonCmd("uv run --python 3.12 python"), {
    command: "uv",
    prefixArgs: ["run", "--python", "3.12", "python"],
  });
  assert.deepEqual(
    parsePythonCmd('"C:\\Program Files\\Python312\\python.exe" -u'),
    {
      command: "C:\\Program Files\\Python312\\python.exe",
      prefixArgs: ["-u"],
    },
  );
  assert.deepEqual(pythonCandidates({ pythonCmd: "py -3" }, "win32"), [
    { command: "py", prefixArgs: ["-3"] },
  ]);

  const dir = await mkdtemp(join(tmpdir(), "dsh-trellis py cmd "));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const exeWithSpaces = join(dir, "python 3.exe");
  await writeFile(exeWithSpaces, "", "utf8");
  assert.deepEqual(parsePythonCmd(exeWithSpaces), {
    command: exeWithSpaces,
    prefixArgs: [],
  });
});

test("runTrellisScript sets UTF-8 env, scrubs case-insensitive host vars, and reports timeouts/stdout", async () => {
  const saved = {
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    dsh_session_id: process.env.dsh_session_id,
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    TRELLIS_CONTEXT_ID: process.env.TRELLIS_CONTEXT_ID,
  };
  process.env.CODEX_THREAD_ID = "codex-outer";
  process.env.dsh_session_id = "lowercase-outer";
  process.env.AWS_ACCESS_KEY_ID = "akia-secret";
  process.env.TRELLIS_CONTEXT_ID = "outer";

  try {
    const seen = [];
    const okResult = await runTrellisScript(
      { pythonCmd: "" },
      root,
      "   ",
      ["current"],
      {
        platform: "linux",
        async execFile(command, _args, options) {
          seen.push({ command, env: options.env });
          return { stdout: "Current task: (none)\n", stderr: "" };
        },
      },
    );
    assert.equal(okResult.kind, "success");
    assert.deepEqual(
      seen.map((entry) => entry.command),
      ["python3"],
    );
    const childEnv = seen[0].env;
    assert.equal(childEnv.PYTHONIOENCODING, "utf-8");
    assert.equal(childEnv.PYTHONUTF8, "1");
    assert.equal(childEnv.CODEX_THREAD_ID, undefined);
    assert.equal(childEnv.dsh_session_id, undefined);
    assert.equal(childEnv.AWS_ACCESS_KEY_ID, undefined);
    assert.equal(childEnv.TRELLIS_CONTEXT_ID, undefined);

    const timedOut = await runTrellisScript(
      { pythonCmd: "python3" },
      root,
      "s1",
      ["current"],
      {
        async execFile() {
          throw Object.assign(new Error("killed"), { killed: true });
        },
      },
    );
    assert.equal(timedOut.kind, "error");
    assert.match(timedOut.text, /timed out after 15s/);

    const withStdout = await runTrellisScript(
      { pythonCmd: "python3" },
      root,
      "s1",
      ["current"],
      {
        async execFile() {
          throw Object.assign(new Error("exit 2"), {
            code: 2,
            stdout: "Detailed failure on stdout",
            stderr: "",
          });
        },
      },
    );
    assert.equal(withStdout.kind, "error");
    assert.match(withStdout.text, /Detailed failure on stdout/);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("trellis-doctor advertises input hint and runs when .trellis dir exists without task.py, while rejecting stray .trellis files", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-trellis-cmd-doc-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const { ctx, commands } = commandHarness();
  const dispose = registerCommands(
    ctx,
    { pythonCmd: "", projectRootMarkers: [".trellis", ".git"] },
    { fs: nodeFs },
  );
  t.after(dispose);

  const doctorCmd = commands.get("trellis-doctor");
  assert.deepEqual(doctorCmd.input, { hint: "[--check | --fix]" });

  // Stray regular .trellis file with .git parent -> rejected as non-Trellis directory
  const strayRepo = join(dir, "stray");
  await mkdir(join(strayRepo, ".git"), { recursive: true });
  await writeFile(join(strayRepo, ".trellis"), "not a directory", "utf8");
  const strayResult = await doctorCmd.handler({
    agent: { session: { header: { cwd: strayRepo, id: "s1" } } },
    rawInput: "--check",
    attachments: [],
    signal: new AbortController().signal,
  });
  assert.equal(strayResult.kind, "error");
  assert.match(strayResult.text, /No Trellis project found/);

  // Real .trellis directory without workflow.md or task.py -> reaches doctor diagnostics
  const partialRepo = join(dir, "partial");
  await mkdir(join(partialRepo, ".trellis"), { recursive: true });
  const partialResult = await doctorCmd.handler({
    agent: { session: { header: { cwd: partialRepo, id: "s2" } } },
    rawInput: "--check",
    attachments: [],
    signal: new AbortController().signal,
  });
  assert.equal(partialResult.kind, "error");
  assert.match(partialResult.text, /active_task\.py is missing or unreadable/);
});
