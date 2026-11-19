/**
 * Trellis project state resolution: project root, workflow-state blocks,
 * active task pointer, and status mapping.
 *
 * Pure logic with an injectable filesystem shim so unit tests run without
 * touching a real Trellis project.
 *
 * @module dsh-trellis/workflow
 */
import { join, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";

/** Workflow-state block and workflow id charset, mirrored from Trellis's workflow.md contract. */
const WORKFLOW_SLUG_RE = /^[A-Za-z0-9_-]+$/;
const CONTEXT_KEY_RE = /^[A-Za-z0-9._-]+$/;
const OPEN_STATE_RE = /^[ \t]*\[workflow-state:([A-Za-z0-9_-]+)\][ \t]*$/;
const CLOSE_STATE_RE = /^[ \t]*\[\/workflow-state:([A-Za-z0-9_-]+)\][ \t]*$/;
const FENCE_RE = /^[ \t]*(`{3,}|~{3,})(.*)$/;
const MAX_CACHE_ENTRIES = 64;

function stripBom(text) {
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

function isWithinDirectory(candidate, baseDir) {
  const rel = relative(baseDir, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Same sanitization Trellis task.py applies to context keys. */
export function sanitizeContextKey(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 160)
    .replace(/^[._-]+|[._-]+$/g, "");
}

/** The degrading fallback when workflow.md lacks a block for the resolved status. */
export const FALLBACK_BREADCRUMB =
  "Refer to `.trellis/workflow.md` for the current workflow step (no matching [workflow-state] block found).";

/** Old workflows may not yet define task_error; never turn a bad record into no_task. */
export const TASK_ERROR_BREADCRUMB =
  "The active task record could not be read. Do not create or activate another task. " +
  "Inspect the active task directory and repair its task.json (a JSON object with a non-empty status). " +
  "Preserve existing fields and artifacts; ask the user if the correct status is uncertain.";

/**
 * Parse every `[workflow-state:STATUS] ... [/workflow-state:STATUS]` block.
 * Ignores HTML comments and Markdown fenced code blocks outside active state blocks.
 * @param {string} content - workflow.md content.
 * @returns {Map<string, string>} status → trimmed body.
 */
export function parseWorkflowStateBlocks(content) {
  const blocks = new Map();
  const lines = stripBom(String(content ?? "")).split(/\r?\n/);
  let activeStatus = null;
  let bodyLines = [];
  let inComment = false;
  let fenceChar = "";
  let fenceLen = 0;

  for (const rawLine of lines) {
    if (activeStatus !== null) {
      const closeMatch = CLOSE_STATE_RE.exec(rawLine);
      if (closeMatch && closeMatch[1] === activeStatus) {
        const body = bodyLines.join("\n").trim();
        if (body !== "") blocks.set(activeStatus, body);
        activeStatus = null;
        bodyLines = [];
      } else {
        bodyLines.push(rawLine);
      }
      continue;
    }

    let line = rawLine;
    if (inComment) {
      const endIdx = line.indexOf("-->");
      if (endIdx === -1) continue;
      inComment = false;
      line = line.slice(endIdx + 3);
    }

    if (fenceChar !== "") {
      const trimmed = line.trim();
      if (
        trimmed.length >= fenceLen &&
        trimmed.startsWith(fenceChar.repeat(fenceLen)) &&
        [...trimmed].every((ch) => ch === fenceChar)
      ) {
        fenceChar = "";
        fenceLen = 0;
      }
      continue;
    }

    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      const rest = fenceMatch[2];
      // CommonMark backtick info strings cannot contain backticks; treat inline ```code``` as non-fence.
      if (!(marker[0] === "`" && rest.includes("`"))) {
        fenceChar = marker[0];
        fenceLen = marker.length;
        continue;
      }
    }

    // Strip single-line HTML comments; enter comment mode if unclosed <!-- remains.
    line = line.replace(/<!--[\s\S]*?-->/g, "");
    const openComment = line.indexOf("<!--");
    if (openComment !== -1) {
      line = line.slice(0, openComment);
      inComment = true;
    }

    const openMatch = OPEN_STATE_RE.exec(line);
    if (openMatch) {
      activeStatus = openMatch[1];
      bodyLines = [];
    }
  }
  return blocks;
}

async function markerMatches(targetPath, marker, fs) {
  if (marker === ".trellis" && typeof fs.stat === "function") {
    try {
      const info = await fs.stat(targetPath);
      if (info === null || info === undefined) return false;
      if (typeof info.isDirectory === "boolean") return info.isDirectory;
      if (typeof info.isDirectory === "function") return Boolean(info.isDirectory());
      return true;
    } catch {
      return false;
    }
  }
  return fs.exists(targetPath);
}

/**
 * Walk upward from cwd to the first directory containing one of the markers.
 * @param {string} cwd - absolute starting directory.
 * @param {string[]} markers - child names that identify a project root.
 * @param {{exists(path: string): Promise<boolean>, stat?(path: string): Promise<{isDirectory?: boolean | (() => boolean)} | null>}} fs - filesystem shim.
 * @returns {Promise<string | null>}
 */
export async function findProjectRoot(cwd, markers, fs) {
  let current = resolve(cwd);
  for (;;) {
    for (const marker of markers) {
      if (await markerMatches(join(current, marker), marker, fs)) return current;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Read a file, returning null when absent. Cache by (path, mtimeMs, size) so the
 * per-turn hot path does not re-read workflow.md on every step.
 * @param {string} path
 * @param {{readFile(path: string): Promise<string | null>, stat(path: string): Promise<{mtimeMs: number, size?: number} | null>}} fs
 * @param {Map<string, {mtimeMs: number, size?: number, content: string | null}>} cache
 * @returns {Promise<string | null>}
 */
export async function readCached(path, fs, cache) {
  try {
    const info = await fs.stat(path);
    if (info === null || info === undefined) {
      cache.delete(path);
      return null;
    }
    const size = typeof info.size === "number" ? info.size : undefined;
    const hit = cache.get(path);
    if (
      hit !== undefined &&
      hit.mtimeMs === info.mtimeMs &&
      (size === undefined || hit.size === undefined || hit.size === size)
    ) {
      return hit.content;
    }
    const content = await fs.readFile(path);
    if (content === null || content === undefined) {
      cache.delete(path);
      return null;
    }
    if (!cache.has(path) && cache.size >= MAX_CACHE_ENTRIES) {
      cache.delete(cache.keys().next().value);
    }
    cache.set(path, { mtimeMs: info.mtimeMs, size, content, blocks: undefined });
    return content;
  } catch {
    cache.delete(path);
    return null;
  }
}

async function readWorkflowBlocks(path, fs, cache) {
  const content = await readCached(path, fs, cache);
  if (content === null || content === undefined) return null;
  const entry = cache?.get?.(path);
  if (entry !== undefined && entry.content === content) {
    if (entry.blocks === undefined) {
      entry.blocks = parseWorkflowStateBlocks(content);
    }
    return entry.blocks;
  }
  return parseWorkflowStateBlocks(content);
}

function parseScalarValue(raw, { yamlNull = false } = {}) {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  let value;
  if (trimmed.startsWith('"')) {
    const quoted = /^"((?:\\.|[^"\\])*)"(?:\s*(?:#.*)?)?$/.exec(trimmed);
    value = quoted ? quoted[1] : trimmed;
  } else if (trimmed.startsWith("'")) {
    const quoted = /^'([^']*)'(?:\s*(?:#.*)?)?$/.exec(trimmed);
    value = quoted ? quoted[1] : trimmed;
  } else {
    value = trimmed.replace(/\s+#.*$/, "");
  }
  value = value.trim();
  if (!value) return null;
  if (yamlNull && (value === "null" || value === "~")) return null;
  return value;
}

function parseDeveloperWorkflow(content) {
  for (const rawLine of stripBom(String(content)).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^workflow\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = parseScalarValue(match[1]);
    if (value !== null) return value;
  }
  return null;
}

function parseConfigDefaultWorkflow(content) {
  for (const rawLine of stripBom(String(content)).split(/\r?\n/)) {
    if (/^\s*(?:#|$)/.test(rawLine)) continue;
    const match = /^default_workflow\s*:\s*(.*)$/.exec(rawLine);
    if (!match) continue;
    const value = parseScalarValue(match[1], { yamlNull: true });
    if (value !== null) return value;
  }
  return null;
}

async function resolveWorkflowBlocks(root, taskWorkflow, fs, cache) {
  let selectedId = taskWorkflow;
  if (selectedId === null) {
    const devContent = await readCached(
      join(root, ".trellis", ".developer"),
      fs,
      cache,
    );
    if (devContent !== null && devContent !== undefined) {
      selectedId = parseDeveloperWorkflow(devContent);
    }
  }
  if (selectedId === null) {
    const configContent = await readCached(
      join(root, ".trellis", "config.yaml"),
      fs,
      cache,
    );
    if (configContent !== null && configContent !== undefined) {
      selectedId = parseConfigDefaultWorkflow(configContent);
    }
  }
  if (
    selectedId !== null &&
    selectedId !== "default" &&
    WORKFLOW_SLUG_RE.test(selectedId)
  ) {
    const customBlocks = await readWorkflowBlocks(
      join(root, ".trellis", "workflows", `${selectedId}.md`),
      fs,
      cache,
    );
    if (customBlocks !== null) return customBlocks;
  }
  return readWorkflowBlocks(join(root, ".trellis", "workflow.md"), fs, cache);
}

function normalizeTaskRef(rawRef) {
  const trimmed = rawRef.trim();
  if (!trimmed || /[\r\n\0]/.test(trimmed) || /^[A-Za-z]:/.test(trimmed)) {
    return null;
  }
  let normalized = trimmed.replaceAll("\\", "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  if (normalized.split("/").includes("..")) return null;
  if (normalized.startsWith("tasks/")) normalized = `.trellis/${normalized}`;
  return normalized;
}

async function passesRealpathContainment(absRoot, absCandidate, fs) {
  if (typeof fs.realpath !== "function") return true;
  let realRoot;
  try {
    realRoot = await fs.realpath(absRoot);
  } catch {
    return true;
  }
  let realTrellis = null;
  try {
    realTrellis = await fs.realpath(join(absRoot, ".trellis"));
  } catch {
    realTrellis = null;
  }
  for (const probe of [join(absCandidate, "task.json"), absCandidate]) {
    try {
      const realTarget = await fs.realpath(probe);
      if (isWithinDirectory(realTarget, realRoot)) return true;
      if (realTrellis !== null && isWithinDirectory(realTarget, realTrellis)) {
        return true;
      }
      return false;
    } catch {
      // Probe may not exist yet; continue to parent directory.
    }
  }
  return true;
}

async function resolveContainedTaskPath(root, rawRef, fs) {
  const normalized = normalizeTaskRef(rawRef);
  if (normalized === null) return null;
  const absRoot = resolve(root);
  const absCandidate = resolve(absRoot, normalized);
  if (!isWithinDirectory(absCandidate, absRoot)) return null;
  if (!(await passesRealpathContainment(absRoot, absCandidate, fs))) return null;
  const rel = relative(absRoot, absCandidate);
  return {
    absPath: absCandidate,
    posixPath: rel.split(sep).join("/"),
  };
}

/**
 * Resolve the active task for a dsh session.
 *
 * Read only this session's pointer. A sole foreign session is not proof of
 * ownership (Trellis #608). Child agents receive an explicit Active task:
 * dispatch prompt; they must not borrow arbitrary session bindings here.
 * Once bound, an unreadable or out-of-root task record is task_error, not an absent task.
 *
 * @param {string} root - project root.
 * @param {string} contextKey - sanitized `dsh_<session-id>` key for this agent.
 * @param {{readFile(path: string): Promise<string | null>, realpath?(path: string): Promise<string>}} fs
 * @returns {Promise<{path: string | null, status: string, workflow: string | null} | null>} task dir-relative path, status, and optional workflow id.
 */
export async function resolveActiveTask(root, contextKey, fs) {
  if (
    typeof contextKey !== "string" ||
    contextKey === "" ||
    contextKey === "." ||
    contextKey === ".." ||
    !CONTEXT_KEY_RE.test(contextKey)
  ) {
    return null;
  }
  const pointer = join(
    root, ".trellis", ".runtime", "sessions", `${contextKey}.json`,
  );
  let data = null;
  try {
    const rawPointer = await fs.readFile(pointer);
    data = JSON.parse(rawPointer === null ? "null" : stripBom(rawPointer));
  } catch {
    return null;
  }
  if (
    data === null ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    typeof data.current_task !== "string" ||
    data.current_task.trim() === ""
  ) {
    return null;
  }
  const contained = await resolveContainedTaskPath(root, data.current_task, fs);
  if (contained === null) {
    return {
      path: null,
      status: "task_error",
      workflow: null,
    };
  }
  const { status, workflow } = await readTaskRecord(contained.absPath, fs);
  return {
    path: contained.posixPath,
    status: status ?? "task_error",
    workflow,
  };
}

async function readTaskRecord(absTaskDir, fs) {
  try {
    const raw = await fs.readFile(join(absTaskDir, "task.json"));
    const data = JSON.parse(raw === null ? "null" : stripBom(raw));
    if (
      data !== null &&
      typeof data === "object" &&
      !Array.isArray(data)
    ) {
      const status =
        typeof data.status === "string" && data.status.trim() !== ""
          ? data.status
          : null;
      const workflow =
        typeof data.workflow === "string" && data.workflow.trim() !== ""
          ? data.workflow.trim()
          : null;
      return { status, workflow };
    }
    return { status: null, workflow: null };
  } catch {
    return { status: null, workflow: null };
  }
}

/**
 * Read a non-empty task.json status, or null for an unreadable/invalid record.
 * @param {string} root
 * @param {string} taskPath - repo-root relative task dir (e.g. `.trellis/tasks/04-17-foo`).
 * @param {{readFile(path: string): Promise<string | null>, realpath?(path: string): Promise<string>}} fs
 * @returns {Promise<string | null>}
 */
export async function readTaskStatus(root, taskPath, fs) {
  const contained = await resolveContainedTaskPath(root, taskPath, fs);
  if (contained === null) return null;
  const { status } = await readTaskRecord(contained.absPath, fs);
  return status;
}

/**
 * Map a task.json status to a workflow-state breadcrumb status.
 * @param {unknown} status
 * @returns {string}
 */
export function mapStatus(status) {
  if (status === null || status === undefined) return "no_task";
  if (typeof status !== "string") return "task_error";
  const trimmed = status.trim();
  if (trimmed === "") return "no_task";
  return WORKFLOW_SLUG_RE.test(trimmed) ? trimmed : "task_error";
}

/**
 * Resolve the full Trellis state for one session step.
 * @param {object} options
 * @param {string} options.cwd
 * @param {string[]} options.markers
 * @param {string} options.contextKey - sanitized session context key.
 * @param {object} options.fs - filesystem shim ({exists, readFile, stat}).
 * @param {Map<string, {mtimeMs: number, content: string | null, blocks?: Map<string, string>}>} options.cache
 * @returns {Promise<{root: string, status: string, taskPath: string | null, body: string, digest: string} | null>}
 */
export async function resolveTrellisState({
  cwd,
  markers,
  contextKey,
  fs,
  cache,
}) {
  const root = await findProjectRoot(cwd, markers, fs);
  if (root === null) return null;
  const task = await resolveActiveTask(root, contextKey, fs);
  const blocks = await resolveWorkflowBlocks(
    root,
    task?.workflow ?? null,
    fs,
    cache,
  );
  if (blocks === null || blocks.size === 0) return null;
  const status = mapStatus(task?.status ?? null);
  const body =
    status === "task_error"
      ? blocks.get(status) || TASK_ERROR_BREADCRUMB
      : blocks.get(status) ?? FALLBACK_BREADCRUMB;
  const digest = createHash("sha1")
    .update(`${status}\n${task?.path ?? ""}\n${body}`)
    .digest("hex");
  return { root, status, taskPath: task?.path ?? null, body, digest };
}
