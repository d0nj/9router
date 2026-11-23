import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetch(...args),
}));

import { USAGE_APIKEY_PROVIDERS, USAGE_SUPPORTED_PROVIDERS } from "../../src/shared/constants/providers.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import { parseAwsQuickUsage } from "../../open-sse/services/usage/awsquick.js";
import { parseQuotaData, getRemainingPercentage } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AWS Quick usage & quota tracker", () => {
  it("enables usage and usageApikey feature flags in the provider registry", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("awsquick");
    expect(USAGE_APIKEY_PROVIDERS).toContain("awsquick");
  });

  it("parses DataPlane user-info usageSummary into Monthly, Session, and optional Overage quotas", () => {
    const result = parseAwsQuickUsage({
      usageSummary: {
        entitlementStatus: "BLOCKED_MONTHLY",
        monthlyUsage: {
          availableUnits: 0,
          provisionedUnits: 600,
          resetsAt: 1796083200,
          usedPercentage: 100,
        },
        sessionUsage: {
          resumeInMinutes: 0,
          usedPercentage: 0,
        },
        overageEnabled: true,
        overageCapMinutes: 120,
        overageConsumedMinutes: 30,
        subscription: {
          subscriptionType: "QUICK_LITE_FREE_TRIAL",
        },
      },
    });

    expect(result.plan).toBe("Free Trial");
    expect(result.quotas.Monthly).toEqual({
      name: "Monthly",
      used: 600,
      total: 600,
      unit: "units",
      percentage: 0,
      percentageIsUsed: false,
      resetAt: "2026-12-01T00:00:00.000Z",
      emptyMessage: null,
    });
    expect(result.quotas.Session).toEqual({
      name: "Session",
      used: 0,
      total: 100,
      percentage: 100,
      percentageIsUsed: false,
      resetAt: null,
      emptyMessage: "No usage in this window",
    });
    expect(result.quotas.Overage).toEqual({
      name: "Overage",
      used: 30,
      total: 120,
      unit: "min",
      percentage: 75,
      percentageIsUsed: false,
      resetAt: "2026-12-01T00:00:00.000Z",
    });

    const rows = parseQuotaData("awsquick", result);
    expect(rows.map((r) => r.name)).toEqual(["Monthly", "Session", "Overage"]);
    expect(rows[0].unit).toBe("units");
    expect(getRemainingPercentage(rows[0])).toBe(0);
    expect(getRemainingPercentage(rows[1])).toBe(100);
    expect(getRemainingPercentage(rows[2])).toBe(75);
  });

  it("parses Gateway entitlements responses into Monthly and Session quotas", () => {
    const result = parseAwsQuickUsage({
      entitlements: [
        {
          unitType: "AUTOMATION_AGENT_HOUR_UNIT",
          numMinsAvailable: 180,
          numMinsProvisioned: 720,
          rateLimitStatus: {
            isThrottled: true,
            consumptionPercentage: 100,
            estimatedMinutesToResume: 15,
          },
        },
      ],
      subscriptionMetadata: {
        subscriptionType: "QUICK_LITE_TEAM",
      },
    });

    expect(result.plan).toBe("Team");
    expect(result.quotas.Monthly.used).toBe(540);
    expect(result.quotas.Monthly.total).toBe(720);
    expect(result.quotas.Monthly.percentage).toBe(25);
    expect(result.quotas.Session.used).toBe(100);
    expect(result.quotas.Session.percentage).toBe(0);
    expect(result.quotas.Session.resetAt).toBeTruthy();
  });

  it("fetches /integration/quick-work/user-info and falls back to entitlements on 404", async () => {
    const tenantUrl = "https://qbs-test.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev";
    const fetchMock = vi.fn(async (url, init) => {
      if (url.endsWith("/integration/quick-work/user-info")) {
        expect(init.method).toBe("POST");
        expect(init.headers.Authorization).toBe("Bearer TOK");
        expect(JSON.parse(init.body)).toEqual({ excludeUserInfo: true });
        return new Response("Not Found", { status: 404 });
      }
      expect(url).toBe(`${tenantUrl}/agenticmetering/v1/get-available-entitlement-units`);
      expect(init.method).toBe("GET");
      return new Response(JSON.stringify({
        entitlements: [{ unitType: "AUTOMATION_AGENT_HOUR_UNIT", numMinsAvailable: 600, numMinsProvisioned: 600 }],
        subscriptionMetadata: { subscriptionType: "QUICK_MAX_TEAM" },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const usage = await getUsageForProvider({
      id: "conn-1",
      provider: "awsquick",
      authType: "oauth",
      accessToken: "TOK",
      providerSpecificData: { tenantUrl },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(usage.plan).toBe("Max Team");
    expect(usage.quotas.Monthly.used).toBe(0);
    expect(usage.quotas.Monthly.total).toBe(600);
  });

  it("returns auth-expired message on 401 and rejects non-AWS tenant URLs", async () => {
    const tenantUrl = "https://qbs-test.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Unauthorized", { status: 401 })));

    const authErr = await getUsageForProvider({
      id: "conn-1",
      provider: "awsquick",
      authType: "oauth",
      accessToken: "EXPIRED",
      providerSpecificData: { tenantUrl },
    });
    expect(authErr.message.toLowerCase()).toContain("expired");

    const ssrfErr = await getUsageForProvider({
      id: "conn-2",
      provider: "awsquick",
      authType: "apikey",
      apiKey: "TOK",
      providerSpecificData: { tenantUrl: "https://evil.example.com" },
    });
    expect(ssrfErr.message).toContain("not an AWS Quick DataPlane host");
  });
});
