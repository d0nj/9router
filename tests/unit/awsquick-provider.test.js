import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetch(...args),
}));

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { AWSQuickExecutor, buildAWSQuickRequestBody, parseAWSQuickResponse } from "../../open-sse/executors/awsquick.js";
import { encodeEventFrame } from "../../open-sse/utils/awsEventStream.js";
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
        system: [{ text: "be brief" }],
        messages: [{ role: "user", content: [{ text: "hi" }] }],
        inferenceConfig: { maxTokens: 32 },
      },
    });
    expect(buildAWSQuickRequestBody("us.anthropic.claude-sonnet-4-6", input, true)).toEqual({
      modelId: "us.anthropic.claude-sonnet-4-6",
      requestBody: {
        system: [{ text: "be brief" }],
        messages: [{ role: "user", content: [{ text: "hi" }] }],
        inferenceConfig: { maxTokens: 32 },
      },
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
        eventType: "ContentBlockDelta",
        payload: { contentBlockIndex: 0, delta: { text: "hello" } },
      }),
      encodeEventFrame({ ":message-type": "event" }, {
        eventType: "MessageStop",
        payload: { stopReason: "end_turn" },
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
    expect(text).toContain('"content":"hello"');
    expect(text).toContain('"finish_reason":"stop"');
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
    const errText = await errResult.response.text();
    expect(errText).toContain("This client is not supported for this request.");
  });
});
