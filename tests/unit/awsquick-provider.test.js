import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetch(...args),
}));

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { AWSQuickExecutor, buildAWSQuickRequestBody, parseAWSQuickResponse } from "../../open-sse/executors/awsquick.js";
import { AWS_QUICK } from "../../open-sse/config/awsQuickConstants.js";
import { encodeEventFrame } from "../../open-sse/utils/awsEventStream.js";
import { parseUpstreamError } from "../../open-sse/utils/error.js";
import { resolveProviderAlias } from "../../open-sse/services/model.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AWS Quick provider", () => {
  const entry = REGISTRY.find((e) => e.id === "awsquick");

  it("is registered with its routing aliases", () => {
    expect(entry).toBeDefined();
    expect(entry.category).toBe("oauth");
    expect(entry.authType).toBe("oauth");
    expect(resolveProviderAlias("awsq")).toBe("awsquick");
    expect(resolveProviderAlias("aws-quick")).toBe("awsquick");
    expect(PROVIDERS.awsquick.format).toBe("openai");
    expect(PROVIDER_MODELS.awsq.length).toBeGreaterThan(0);
  });

  it("uses an executor rather than the generic one", () => {
    expect(getExecutor("awsquick")).toBeInstanceOf(AWSQuickExecutor);
    expect(getExecutor("awsq")).toBeInstanceOf(AWSQuickExecutor);
  });

  it("copies the Quick desktop request headers", () => {
    const executor = getExecutor("awsquick");
    expect(executor.buildHeaders({ apiKey: "TOKEN" }, false)).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer TOKEN",
      "User-Agent": "Amazon Quick/1.2.4660",
      "X-QuickDsk-mdid": "user-conversation",
      "x-amzn-quick-atype": "ufg",
    });
  });

  it("builds the tenant Bedrock proxy URL from provider-specific data", () => {
    const executor = getExecutor("awsquick");
    const credentials = { providerSpecificData: { tenantUrl: "https://qbs-test.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev/" } };
    expect(executor.buildUrl("us.anthropic.claude-sonnet-4-6", false, 0, credentials)).toBe(
      "https://qbs-test.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev/integration/quick-work/bedrock-proxy",
    );
    expect(executor.buildUrl("us.anthropic.claude-sonnet-4-6", true, 0, credentials)).toBe(
      "https://qbs-test.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev/integration/quick-work/bedrock-proxy-stream",
    );
  });

  it("wraps an OpenAI request in the Converse proxy envelope and omits apiType when streaming", () => {
    const input = {
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ],
      max_tokens: 32,
    };
    expect(buildAWSQuickRequestBody("us.anthropic.claude-sonnet-4-6", input)).toEqual({
      modelId: "us.anthropic.claude-sonnet-4-6",
      apiType: "CONVERSE",
      requestBody: {
        system: [{ text: AWS_QUICK.allowedSystemPrefix }, { text: "be brief" }],
        messages: [{ role: "user", content: [{ text: "hi" }] }],
        inferenceConfig: { maxTokens: 32 },
      },
    });
    expect(buildAWSQuickRequestBody("us.anthropic.claude-sonnet-4-6", input, true)).toEqual({
      modelId: "us.anthropic.claude-sonnet-4-6",
      requestBody: {
        system: [{ text: AWS_QUICK.allowedSystemPrefix }, { text: "be brief" }],
        messages: [{ role: "user", content: [{ text: "hi" }] }],
        inferenceConfig: { maxTokens: 32 },
      },
    });
  });

  it("merges parallel tool results into one user turn and strips temperature on adaptive-thinking models", () => {
    const body = buildAWSQuickRequestBody("us.anthropic.claude-opus-5-5", {
      messages: [
        { role: "user", content: "check both" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "c1", type: "function", function: { name: "a", arguments: "{}" } },
            { id: "c2", type: "function", function: { name: "b", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: "one" },
        { role: "tool", tool_call_id: "c2", content: "two" },
      ],
      temperature: 0,
      top_p: 0.9,
      reasoning_effort: "xhigh",
      max_tokens: 512,
    }, true);

    expect(body.requestBody.system).toEqual([{ text: AWS_QUICK.allowedSystemPrefix }]);
    expect(body.requestBody.inferenceConfig).toEqual({ maxTokens: 512 });
    expect(body.requestBody.additionalModelRequestFields).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "max" },
    });
    expect(body.requestBody.messages).toHaveLength(3);
    expect(body.requestBody.messages[2]).toEqual({
      role: "user",
      content: [
        { toolResult: { toolUseId: "c1", content: [{ text: "one" }] } },
        { toolResult: { toolUseId: "c2", content: [{ text: "two" }] } },
      ],
    });
  });

  it("converts a Converse response (direct or responseBody-wrapped) into OpenAI format", () => {
    const payload = {
      output: { message: { role: "assistant", content: [{ text: "hello" }] } },
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      stopReason: "end_turn",
    };
    for (const raw of [payload, { responseBody: payload, usageSummary: {} }]) {
      const result = parseAWSQuickResponse(raw, "us.anthropic.claude-sonnet-4-6");
      expect(result.choices[0].message.content).toBe("hello");
      expect(result.choices[0].finish_reason).toBe("stop");
      expect(result.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
    }
  });

  it("surfaces string responseBody denials on non-streaming responses instead of 0-token completions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      responseBody: "This client is not supported for this request.",
      usageSummary: null,
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    const executor = getExecutor("awsquick");
    const result = await executor.execute({
      model: "us.anthropic.claude-opus-5-5",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: {
        accessToken: "TOK",
        providerSpecificData: { tenantUrl: "https://qbs-test.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev" },
      },
    });
    expect(result.response.status).toBe(403);
    expect(await result.response.json()).toEqual({
      error: { message: "This client is not supported for this request.", type: "api_error" },
    });
  });

  it("decodes AWS binary EventStream frames and surfaces in-band errors", async () => {
    const frames = [
      encodeEventFrame({ ":message-type": "event" }, {
        eventType: "contentBlockDelta",
        payload: { contentBlockIndex: 0, delta: { reasoningContent: { text: "think" } } },
      }),
      encodeEventFrame({ ":message-type": "event" }, {
        eventType: "ContentBlockDelta",
        payload: { contentBlockIndex: 1, delta: { text: "hello" } },
      }),
      encodeEventFrame({ ":message-type": "event" }, {
        eventType: "contentBlockStart",
        payload: { contentBlockIndex: 2, start: { toolUse: { toolUseId: "call_1", name: "read" } } },
      }),
      encodeEventFrame({ ":message-type": "event" }, {
        eventType: "contentBlockDelta",
        payload: { contentBlockIndex: 2, delta: { toolUse: { input: "{\"x\":1}" } } },
      }),
      encodeEventFrame({ ":message-type": "event" }, {
        eventType: "MessageStop",
        payload: { stopReason: "tool_use" },
      }),
      encodeEventFrame({ ":message-type": "event" }, {
        eventType: "metadata",
        payload: { usage: { inputTokens: 120, outputTokens: 45, totalTokens: 165, cacheReadInputTokens: 30 } },
      }),
    ];
    const body = new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(frame);
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/vnd.amazon.eventstream" },
    })));

    const executor = getExecutor("awsquick");
    const result = await executor.execute({
      model: "us.anthropic.claude-opus-5-5",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: {
        accessToken: "TOK",
        providerSpecificData: { tenantUrl: "https://qbs-test.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev" },
      },
    });
    const text = await result.response.text();
    expect(text).toContain('"reasoning_content":"think"');
    expect(text).toContain('"content":"hello"');
    expect(text).toContain('"index":0');
    expect(text).not.toContain('"index":2');
    const dataLines = text
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)));
    const terminal = dataLines.at(-1);
    expect(terminal.choices[0].finish_reason).toBe("tool_calls");
    expect(terminal.usage).toEqual({
      prompt_tokens: 120,
      completion_tokens: 45,
      total_tokens: 165,
      prompt_tokens_details: { cached_tokens: 30 },
    });
    expect(text).toContain("data: [DONE]");

    const errFrame = encodeEventFrame({ ":message-type": "event" }, {
      eventType: "error",
      payload: { error: "This client is not supported for this request.", errorType: "AccessDeniedException" },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(errFrame, {
      status: 200,
      headers: { "Content-Type": "application/vnd.amazon.eventstream" },
    })));
    const errResult = await executor.execute({
      model: "us.anthropic.claude-opus-5-5",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: {
        accessToken: "TOK",
        providerSpecificData: { tenantUrl: "https://qbs-test.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev" },
      },
    });
    expect(errResult.response.status).toBe(403);
    const errText = await errResult.response.text();
    expect(errText).toContain("This client is not supported for this request.");
  });

  it("maps usageLimitExceeded pre-stream and non-stream blocks to 429 with resetsAtMs", async () => {
    const executor = getExecutor("awsquick");
    const credentials = {
      accessToken: "TOK",
      providerSpecificData: { tenantUrl: "https://qbs-test.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev" },
    };
    const resetsAtSec = 1796083200;
    const usageSummary = {
      entitlementStatus: "BLOCKED_MONTHLY",
      monthlyUsage: { availableUnits: 0, provisionedUnits: 600, resetsAt: resetsAtSec, usedPercentage: 100 },
      sessionUsage: { resumeInMinutes: 0, usedPercentage: 0 },
    };

    const limitFrame = encodeEventFrame({ ":message-type": "event" }, {
      eventType: "usageLimitExceeded",
      payload: {},
      usageSummary,
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(limitFrame, {
      status: 200,
      headers: { "Content-Type": "application/vnd.amazon.eventstream" },
    })));
    const streamRes = await executor.execute({
      model: "global.anthropic.claude-opus-5-5",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials,
    });
    expect(streamRes.response.status).toBe(429);
    const parsedStreamErr = await parseUpstreamError(streamRes.response, executor);
    expect(parsedStreamErr.statusCode).toBe(429);
    expect(parsedStreamErr.message).toContain("BLOCKED_MONTHLY");
    expect(parsedStreamErr.message).toContain("0/600");
    expect(parsedStreamErr.resetsAtMs).toBe(resetsAtSec * 1000);

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      responseBody: {},
      usageSummary,
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const nonStreamRes = await executor.execute({
      model: "global.anthropic.claude-opus-5-5",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials,
    });
    expect(nonStreamRes.response.status).toBe(429);
    const parsedNonStreamErr = await parseUpstreamError(nonStreamRes.response, executor);
    expect(parsedNonStreamErr.statusCode).toBe(429);
    expect(parsedNonStreamErr.resetsAtMs).toBe(resetsAtSec * 1000);
  });

  it("rejects empty streams and emits mid-stream errors without fabricating finish_reason", async () => {
    const executor = getExecutor("awsquick");
    const credentials = {
      accessToken: "TOK",
      providerSpecificData: { tenantUrl: "https://qbs-test.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev" },
    };

    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(0), {
      status: 200,
      headers: { "Content-Type": "application/vnd.amazon.eventstream" },
    })));
    const emptyRes = await executor.execute({
      model: "global.anthropic.claude-opus-5-5",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials,
    });
    expect(emptyRes.response.status).toBe(502);

    const midFrames = [
      encodeEventFrame({ ":message-type": "event" }, {
        eventType: "messageStart",
        payload: { role: "assistant" },
      }),
      encodeEventFrame({ ":message-type": "event" }, {
        eventType: "contentBlockDelta",
        payload: { contentBlockIndex: 0, delta: { text: "partial" } },
      }),
      encodeEventFrame({ ":message-type": "event" }, {
        eventType: "modelStreamErrorException",
        payload: { message: "Model stream interrupted" },
      }),
    ];
    const midBody = new ReadableStream({
      start(controller) {
        for (const frame of midFrames) controller.enqueue(frame);
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(midBody, {
      status: 200,
      headers: { "Content-Type": "application/vnd.amazon.eventstream" },
    })));
    const midRes = await executor.execute({
      model: "global.anthropic.claude-opus-5-5",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials,
    });
    expect(midRes.response.status).toBe(200);
    const midText = await midRes.response.text();
    expect(midText).toContain('"content":"partial"');
    expect(midText).toContain("Model stream interrupted");
    expect(midText).not.toContain('"finish_reason":"stop"');
    expect(midText).toContain("data: [DONE]");
  });
});
