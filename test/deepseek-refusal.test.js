import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import llmPackage from "@deepseek-ai/dsh-llm/package.json" with { type: "json" };
import { SubagentRuntime } from "@deepseek-ai/dsh-subagent";
import { SessionQueryEngine } from "@deepseek-ai/dsh-session-query";
import { agentRuntime } from "./helpers/agent-runtime.js";
import { registerWaitTool } from "../lib/wait-tool.js";

test("RC.4 DeepSeek Messages refusal records usage and fails the Trellis child gate", {
  skip: llmPackage.version !== "0.2.2-rc.4" && "requires the RC.4 DeepSeek Messages adapter",
  timeout: 15_000,
}, async (t) => {
  const { DeepSeekAdapter, resolveAdapterOptions } = await import("@deepseek-ai/dsh-llm-deepseek");
  const model = "deepseek-v4-flash";
  const partialText = "partial response";
  const received = Promise.withResolvers();
  const release = Promise.withResolvers();
  const requests = [];
  const server = createServer((req, res) => {
    requests.push([req.method, req.url]);
    req.resume();
    req.on("end", () => {
      received.resolve();
      void release.promise.then(() => {
        if (res.destroyed) return;
        const events = [
          { type: "message_start", message: { id: "refused", model, usage: { input_tokens: 12, output_tokens: 0 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: partialText } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "refusal" }, usage: { output_tokens: 5 } },
          { type: "message_stop" },
        ];
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
      });
    });
  });
  t.after(async () => {
    release.resolve();
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const ctx = await agentRuntime(t);
  await ctx.plugin(SubagentRuntime).await();
  await ctx.plugin(SessionQueryEngine).await();
  const options = resolveAdapterOptions({ baseURL: `http://127.0.0.1:${server.address().port}/anthropic` });
  ctx.llm.registerAdapter(["deepseek-local"], new DeepSeekAdapter({
    options: () => options,
    resolveAuth: async () => ({ headers: { "x-api-key": "loopback-only" } }),
    resolveUserId: () => "trellis-test",
    prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
  }));
  const parent = await ctx.agentLoop.create("refusal-parent", { provider: "deepseek-local", model }, { cwd: tmpdir() });
  ctx.subagents.registerProvider({
    name: "refusal-test", inheritsParentContext: false, capabilities: { depthLimit: true },
    async prepareContinuable() { return {}; },
  });
  const activation = await ctx.subagents.startActivation({
    provider: "refusal-test", name: "reviewer", label: "Review", delivery: "caller",
    signal: t.signal, parent, prompt: [{ type: "text", text: "Review the change" }], maxDepth: 1,
  });
  t.after(() => activation.dispose());
  await received.promise;
  const child = ctx.agents.get(activation.childId);
  assert.ok(child, "the provider request belongs to a live child");
  let tool;
  t.after(registerWaitTool({
    tools: { register(value) { tool = value; return ctx.tools.register(value); } },
    subagents: ctx.subagents, get: ctx.get.bind(ctx),
  }));
  const waiting = tool.execute({ subagent_id: activation.name }, { agent: parent, signal: t.signal });
  release.resolve();
  const result = await waiting;
  const terminal = await activation.result;
  assert.equal(result.subagentId, activation.childId);
  assert.equal(result.state, "settled");
  assert.equal(result.outcome, "failed");
  assert.equal(result.stopReason, terminal.stopReason);
  assert.equal(result.settlementNoticeQueued, false);
  assert.match(tool.output.render({}, result)[0].text, /do not treat this gate as passed/);
  assert.deepEqual(requests, [["POST", "/anthropic/v1/messages"]], "the refusal isn't retried");

  const events = child.session.snapshotEvents();
  const end = events.findLast((event) => event.type === "turn/end");
  assert.equal(end?.data.reason.kind, "error");
  assert.equal(end.data.reason.error.code, "CONTENT_REFUSED");
  const attempt = events.findLast((event) => event.type === "assistant/attempt");
  assert.ok(attempt, "the refused stream is persisted as an attempt");
  assert.ok(
    attempt.data.stream.some((record) => record.type === "chunk" &&
      record.chunk.type === "block-end" && record.chunk.block.type === "text" &&
      record.chunk.block.text === partialText),
    "the attempt received partial text before the refusal",
  );
  const usage = attempt.data.stream.find((record) => record.type === "chunk" && record.chunk.type === "usage");
  assert.deepEqual(usage?.chunk.usage, { inputTokens: 12, outputTokens: 5, totalTokens: 17 });
  assert.ok(
    !child.session.deriveMessages().some((message) =>
      message.role === "assistant" && message.content.some((block) => block.text === partialText)),
    "the refused text does not enter model history",
  );
});
