import { describe, expect, it } from "vitest";

import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";

// The OpenCode free lane (/inference/v1, the surface the v2 CLI drives through
// @ai-sdk/openai-compatible) is served by backends that reject the z.ai `thinking`
// object with 400 `json: unknown field "thinking"`, while the CLI's variant table
// for these ids sends reasoning_effort only — low|high|max, no way to disable.

const models = ["glm-5.3-flash-free", "glm-5.3-flash"];

describe("OpenCode free-lane GLM-5.3 is effort-only", () => {
  it.each(models)("%s resolves to the effort-only wire", (id) => {
    const caps = getCapabilitiesForModel("opencode", id);
    expect(caps.thinkingFormat).toBe("zai-effort");
    expect(caps.thinkingCanDisable).toBe(false);
    expect(getThinkingLevels("opencode", id)).toEqual(["low", "high", "max"]);
  });

  it.each([
    ["reasoning_effort: high", { reasoning_effort: "high" }, "high"],
    ["reasoning_effort: max", { reasoning_effort: "max" }, "max"],
    ["reasoning_effort: xhigh", { reasoning_effort: "xhigh" }, "max"],
    ["reasoning_effort: none", { reasoning_effort: "none" }, "low"],
    ["claude thinking enabled", { thinking: { type: "enabled", budget_tokens: 8192 } }, "high"],
  ])("%s lands on the model's own effort set without `thinking`", (_label, seed, effort) => {
    for (const id of models) {
      const body = applyThinking("openai", id, { model: id, messages: [], ...structuredClone(seed) }, "opencode");
      expect(body.thinking, id).toBeUndefined();
      expect(body.reasoning_effort, id).toBe(effort);
    }
  });

  it("leaves z.ai's own lanes on the zai object", () => {
    const body = applyThinking("openai", "glm-5.3-flash", { messages: [], reasoning_effort: "high" }, "glm");
    expect(body.thinking).toEqual({ type: "enabled" });
  });
});
