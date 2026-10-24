import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
  default: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { buildZCodeHeaders, resolveZCodeDeviceMid, ZCODE_APP_VERSION } from "../../open-sse/shared/zcodeFingerprint.js";
import { getZaiStartPlan } from "../../open-sse/services/startPlan.js";
import { getGlmUsage } from "../../open-sse/services/usage/glm.js";

const BALANCE_URL = "https://zcode.z.ai/api/v1/zcode-plan/billing/balance";
const QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const PLAN_KEY = "key123.secret456";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const CODING_PLAN_QUOTA = {
  data: {
    level: "pro",
    limits: [{ type: "TOKENS_LIMIT", percentage: 25, nextResetTime: 0, unit: 3, number: 5 }],
  },
};

describe("ZCode fingerprint headers", () => {
  it("matches the desktop client identity", () => {
    const headers = buildZCodeHeaders({ deviceMid: "mid-1" });
    expect(headers["User-Agent"]).toBe(`ZCode/${ZCODE_APP_VERSION}`);
    expect(headers["HTTP-Referer"]).toBe("https://zcode.z.ai");
    expect(headers["X-Title"]).toBe("Z Code@electron");
    expect(headers["X-ZCode-App-Version"]).toBe(ZCODE_APP_VERSION);
    expect(headers["X-Device-Mid"]).toBe("mid-1");
    expect(["macos", "windows", "linux"]).toContain(headers["X-Os-Category"]);
  });

  it("omits the device id when none is stored", () => {
    expect(buildZCodeHeaders()["X-Device-Mid"]).toBeUndefined();
  });

  it("keeps the device mid stable across calls", async () => {
    expect(await resolveZCodeDeviceMid()).toBe(await resolveZCodeDeviceMid());
  });
});

describe("Start Plan balance", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns null without a ZCode JWT (pasted API key never reaches the trial)", async () => {
    expect(await getZaiStartPlan({ zcodeJwtToken: "" })).toBeNull();
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("sends the ZCode fingerprint and reads the active trial", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({
        code: 0,
        data: {
          plans: [{ plan_id: "start-plan-5d", name: "Start Plan", status: "active" }],
          balances: [{ capabilities: ["model:glm-5.3"] }],
        },
      })
    );

    const snapshot = await getZaiStartPlan({ zcodeJwtToken: "jwt", deviceMid: "mid-1" });

    expect(snapshot.active).toBe(true);
    expect(snapshot.modelIds).toEqual(["glm-5.3"]);
    const [url, init] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe(BALANCE_URL);
    expect(init.headers.authorization).toBe("Bearer jwt");
    expect(init.headers["X-Device-Mid"]).toBe("mid-1");
    expect(init.headers["User-Agent"]).toBe(`ZCode/${ZCODE_APP_VERSION}`);
  });

  it("does not mistake a paid coding plan for the trial", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({ code: 0, data: { plans: [{ name: "GLM Coding Pro", status: "active" }], balances: [] } })
    );
    expect((await getZaiStartPlan({ zcodeJwtToken: "jwt" })).active).toBe(false);
  });

  it("reports an inactive trial when nothing is active", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({ code: 0, data: { plans: [{ plan_id: "start-plan", status: "expired" }], balances: [] } })
    );
    const snapshot = await getZaiStartPlan({ zcodeJwtToken: "jwt" });
    expect(snapshot.active).toBe(false);
    expect(snapshot.expired).toBe(true);
  });
});

describe("glm usage with the optional Start Plan", () => {
  beforeEach(() => vi.clearAllMocks());

  it("adds the trial row while it is active", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(CODING_PLAN_QUOTA))
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: {
            plans: [{ plan_id: "start-plan", status: "active" }],
            balances: [{ capabilities: ["model:glm-5.3"] }],
          },
        })
      );

    const usage = await getGlmUsage(PLAN_KEY, "glm", null, { zcodeJwtToken: "jwt" });

    expect(usage.plan).toBe("Pro + Start Plan");
    expect(usage.quotas["Start Plan"].name).toContain("glm-5.3");
    expect(usage.quotas["Session (5h)"]).toBeDefined();
  });

  it("falls back to the plain coding-plan usage once the trial is gone", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(CODING_PLAN_QUOTA))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { plans: [{ plan_id: "start-plan", status: "expired" }] } }));

    const usage = await getGlmUsage(PLAN_KEY, "glm", null, { zcodeJwtToken: "jwt" });

    expect(usage.plan).toBe("Pro");
    expect(usage.quotas["Start Plan"]).toBeUndefined();
    expect(usage.quotas["Session (5h)"]).toBeDefined();
  });

  it("keeps the coding-plan usage when the trial endpoint fails", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(CODING_PLAN_QUOTA))
      .mockRejectedValueOnce(new Error("trial endpoint down"));

    const usage = await getGlmUsage(PLAN_KEY, "glm", null, { zcodeJwtToken: "jwt" });

    expect(usage.plan).toBe("Pro");
    expect(usage.message).toBeUndefined();
  });

  it("never probes the trial for pasted API keys", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(CODING_PLAN_QUOTA));

    const usage = await getGlmUsage(PLAN_KEY, "glm");

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(usage.plan).toBe("Pro");
  });
});
