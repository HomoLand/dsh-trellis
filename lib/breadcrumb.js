/**
 * Per-turn workflow-state breadcrumb: composition, dedupe, and visibility.
 *
 * @module dsh-trellis/breadcrumb
 */
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { resolveTrellisState } from "./workflow.js";
import { nodeFs } from "./node-fs.js";
import { dshContextKey } from "./session-env.js";
import { resolveWorkingDirectory } from "./working-directory.js";

export const SOURCE_KIND = "dsh-trellis";
export const SOURCE_FORM = "breadcrumb";

const OPEN_TAG = "<system-reminder>\n";
const CLOSE_TAG = "\n</system-reminder>";
const MIN_TAGGED_BYTES = Buffer.byteLength(`${OPEN_TAG}${CLOSE_TAG}`, "utf8");

function escapeSystemReminderTag(value) {
  return value.replace(/<\/system-reminder\b/gi, "<\\/system-reminder");
}

/**
 * Truncate UTF-8 text to a byte budget without splitting a code point.
 * @param {string} value
 * @param {number} maxBytes
 * @returns {string}
 */
export function truncateUtf8(value, maxBytes) {
  const limit = Number.isFinite(maxBytes)
    ? Math.max(0, Math.trunc(maxBytes))
    : maxBytes === Infinity
      ? Infinity
      : 0;
  if (limit === 0) return "";
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= limit) return value;
  let end = limit;
  while (end > 0 && (bytes.readUInt8(end) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

/**
 * Compose the model-visible breadcrumb message for a resolved state.
 * @param {{status: string, taskPath: string | null, body: string, digest: string}} state
 * @param {number} maxBytes
 * @returns {ReturnType<typeof createUserMessage>}
 */
export function breadcrumbMessage(state, maxBytes) {
  const safeStatus = escapeSystemReminderTag(String(state.status ?? ""));
  const taskLine =
    state.taskPath === null
      ? ""
      : `\nActive task: ${escapeSystemReminderTag(String(state.taskPath))}`;
  const safeBody = escapeSystemReminderTag(String(state.body ?? ""));
  const header = `Trellis workflow state: ${safeStatus}${taskLine}\n\n`;
  const prefix = `${OPEN_TAG}${header}`;
  const prefixBytes = Buffer.byteLength(prefix, "utf8");
  const closeBytes = Buffer.byteLength(CLOSE_TAG, "utf8");
  const limit = Number.isFinite(maxBytes)
    ? Math.max(0, Math.trunc(maxBytes))
    : maxBytes === Infinity
      ? Infinity
      : 0;

  let text = "";
  if (limit >= prefixBytes + closeBytes) {
    text = `${prefix}${truncateUtf8(safeBody, limit - prefixBytes - closeBytes)}${CLOSE_TAG}`;
  } else if (limit > 0) {
    text =
      limit >= MIN_TAGGED_BYTES
        ? `${OPEN_TAG}${truncateUtf8(`${header}${safeBody}`, limit - MIN_TAGGED_BYTES)}${CLOSE_TAG}`
        : truncateUtf8(`${prefix}${safeBody}${CLOSE_TAG}`, limit);
  }

  return createUserMessage({
    content: [{ type: "text", text }],
    source: {
      kind: SOURCE_KIND,
      form: SOURCE_FORM,
      status: state.status,
      task: state.taskPath,
      digest: state.digest,
    },
  });
}

/** Whether a user message carries our breadcrumb source. */
export function isBreadcrumbMessage(message) {
  const source = message?.source;
  return (
    typeof source === "object" &&
    source !== null &&
    source.kind === SOURCE_KIND &&
    source.form === SOURCE_FORM
  );
}

/**
 * Does the claimed prompt batch contain the skip keyword as a standalone word?
 * @param {Array<{content?: unknown}>} messages
 * @param {string} keyword
 */
export function hasSkipKeyword(messages, keyword) {
  if (typeof keyword !== "string") return false;
  const trimmed = keyword.trim();
  if (trimmed === "") return false;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_-])${escaped}(?![\\p{L}\\p{N}_-])`,
    "iu",
  );
  for (const message of messages ?? []) {
    if (message?.role !== undefined && message.role !== "user") continue;
    const content = message?.content;
    const parts = Array.isArray(content)
      ? content
      : [{ type: "text", text: String(content ?? "") }];
    for (const part of parts) {
      if (
        (part?.type === undefined || part.type === "text") &&
        typeof part?.text === "string" &&
        pattern.test(part.text)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Build the plugin-owned pre-step composer.
 * @param {object} resolved - normalized plugin config.
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @returns {{ compose(agent: any, messages: any[], signal: AbortSignal): Promise<any> }}
 */
export function createBreadcrumbComposer(resolved, ctx, dependencies = {}) {
  const fs = dependencies.fs ?? nodeFs;
  const cache = new Map();

  const compose = async (agent, messages, signal) => {
    if (resolved.maxBytes <= 0 || !Number.isFinite(resolved.maxBytes))
      return undefined;
    if (hasSkipKeyword(messages, resolved.skipKeyword)) return undefined;
    const cwd = await resolveWorkingDirectory(ctx, agent, signal);
    const contextKey = dshContextKey(agent?.session?.header?.id ?? "");
    signal?.throwIfAborted();
    const state = await resolveTrellisState({
      cwd,
      markers: resolved.projectRootMarkers,
      contextKey,
      fs,
      cache,
    });
    signal?.throwIfAborted();
    if (state === null) return undefined;
    const isSubagent = agent?.session?.header?.origin === "subagent";
    if (isSubagent && state.status === "no_task") return undefined;
    return breadcrumbMessage(state, resolved.maxBytes);
  };

  return { compose };
}
