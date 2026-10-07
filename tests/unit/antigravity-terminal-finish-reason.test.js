// A client speaking OpenAI (pi, opencode, Claude Code via the compat endpoint)
// requires a terminal chunk carrying finish_reason. Antigravity's stream can end
// without ever setting candidate.finishReason — the model is cut off, the turn is
// cancelled, or the upstream closes the SSE body after usage. gemini-to-openai.js
// only emits a finish chunk inside `if (candidate.finishReason)`
// (open-sse/translator/response/gemini-to-openai.js:138), and neither the pivot's
// terminal null chunk (translateResponse drops it, open-sse/translator/index.js:207)
// nor the stream flush (open-sse/utils/stream.js:494) synthesizes one. The client
// then sees a stream that "ended without finish_reason".
//
// KNOWN BUG = it.fails (per tests/translator/AGENTS.md §6). Flip to `it` when fixed.
import { describe, expect, it } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";

const encoder = new TextEncoder();

// Antigravity streams the Gemini envelope: every line is { response: { … } }.
const ag = (response) => `data: ${JSON.stringify({ response })}\n\n`;

const textChunk = (text) => ag({
  candidates: [{ content: { role: "model", parts: [{ text }] } }],
  modelVersion: "gemini-3.8-flash",
  responseId: "resp-1",
});

// The bug shape: content + usageMetadata, but candidate.finishReason absent.
const truncatedTailChunk = () => ag({
  candidates: [{ content: { role: "model", parts: [] } }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  modelVersion: "gemini-3.8-flash",
  responseId: "resp-1",
});

const cleanFinishChunk = () => ag({
  candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  modelVersion: "gemini-3.8-flash",
  responseId: "resp-1",
});

async function runAntigravityStream(input) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(input));
      controller.close();
    },
  });

  const output = stream.pipeThrough(
    createSSETransformStreamWithLogger(
      FORMATS.ANTIGRAVITY,
      FORMATS.OPENAI,
      "antigravity",
      null,
      null,
      "gemini-3.8-flash",
    ),
  );

  const reader = output.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

const chunks = (sse) => sse
  .split("\n")
  .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
  .map((l) => JSON.parse(l.slice(6)));

const finishReasons = (sse) => chunks(sse)
  .map((c) => c.choices?.[0]?.finish_reason)
  .filter(Boolean);

describe("Antigravity → OpenAI: terminal chunk", () => {
  // Regression guard for the healthy path — this one must stay green.
  it("emits finish_reason when the upstream sets candidate.finishReason", async () => {
    const out = await runAntigravityStream(textChunk("Hello") + cleanFinishChunk());
    expect(finishReasons(out)).toContain("stop");
  });

  // The reported symptom.
  it("emits a terminal finish_reason when the upstream closes after usage without one", async () => {
    const out = await runAntigravityStream(textChunk("Hello") + truncatedTailChunk());
    // "length", not "stop": the stream really did stop early (see the translator).
    expect(finishReasons(out), "stream ended without finish_reason").toEqual(["length"]);
  });

  // Content already streamed must survive whatever the terminal fix does.
  it("keeps the content it already streamed when no finishReason arrives", async () => {
    const out = await runAntigravityStream(textChunk("Hello") + truncatedTailChunk());
    const content = chunks(out).map((c) => c.choices?.[0]?.delta?.content || "").join("");
    expect(content).toBe("Hello");
  });
});
