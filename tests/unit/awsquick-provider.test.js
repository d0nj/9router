import { describe, expect, it } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { AWSQuickExecutor, buildAWSQuickRequestBody, parseAWSQuickResponse } from "../../open-sse/executors/awsquick.js";
import { resolveProviderAlias } from "../../open-sse/services/model.js";

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

  it("wraps an OpenAI request in the Converse proxy envelope", () => {
    expect(buildAWSQuickRequestBody("us.anthropic.claude-sonnet-4-6", {
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ],
      max_tokens: 32,
    })).toEqual({
      modelId: "us.anthropic.claude-sonnet-4-6",
      apiType: "CONVERSE",
      requestBody: {
        system: [{ text: "be brief" }],
        messages: [{ role: "user", content: [{ text: "hi" }] }],
        inferenceConfig: { maxTokens: 32 },
      },
    });
  });

  it("converts a Converse response into an OpenAI response", () => {
    const result = parseAWSQuickResponse({
      output: { message: { role: "assistant", content: [{ text: "hello" }] } },
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      stopReason: "end_turn",
    }, "us.anthropic.claude-sonnet-4-6");
    expect(result.choices[0].message.content).toBe("hello");
    expect(result.choices[0].finish_reason).toBe("stop");
    expect(result.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
  });
});
