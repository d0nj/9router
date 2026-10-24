/**
 * GLM Coding Plan usage (international + China regions)
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { U } from "./shared.js";
import { getZaiStartPlan } from "../startPlan.js";

// GLM quota endpoints (region-aware) — url from registry transport.usage
const GLM_QUOTA_URLS = {
  international: U("glm").url,
  china: U("glm-cn").url,
};

/**
 * Parse the GLM quota API response — shared by pasted API keys and
 * OAuth-minted coding-plan keys (both hit the same monitor endpoint).
 * Supports both TOKENS_LIMIT and CREDIT_LIMIT and dynamic intervals (e.g. session 5h, weekly 7d).
 */
export function parseGlmQuotaResponse(json) {
  const data = json?.data && typeof json.data === "object" ? json.data : {};
  const limits = Array.isArray(data.limits) ? data.limits : [];
  const quotas = {};

  for (const limit of limits) {
    // 1. Accept both TOKENS_LIMIT and CREDIT_LIMIT from GLM API
    if (!limit || (limit.type !== "TOKENS_LIMIT" && limit.type !== "CREDIT_LIMIT")) continue;
    const usedPercent = Number(limit.percentage) || 0;
    const resetMs = Number(limit.nextResetTime) || 0;
    const remaining = Math.max(0, 100 - usedPercent);

    // 2. Map key dynamically based on type and period (unit) to avoid overwriting
    let key = "session";
    if (limit.unit === 3) {
      key = `Session (${limit.number}h)`;
    } else if (limit.unit === 6) {
      key = "Weekly (7d)";
    } else if (limit.type === "TOKENS_LIMIT") {
      key = "Tokens";
    } else {
      key = `Limit (${limit.number})`;
    }

    quotas[key] = {
      used: usedPercent,
      total: 100,
      remaining,
      remainingPercentage: remaining,
      resetAt: resetMs > 0 ? new Date(resetMs).toISOString() : null,
      unlimited: false,
    };
  }

  const levelRaw = typeof data.level === "string" ? data.level : "";
  const plan = levelRaw
    ? levelRaw.charAt(0).toUpperCase() + levelRaw.slice(1).toLowerCase()
    : "Unknown";

  return { plan, quotas };
}

/**
 * GLM Coding Plan usage (international + China regions)
 */
export async function getGlmUsage(apiKey, provider, proxyOptions = null, providerSpecificData = {}) {
  if (!apiKey) {
    return { message: "GLM API key not available." };
  }

  const region = provider === "glm-cn" ? "china" : "international";
  const quotaUrl = GLM_QUOTA_URLS[region];

  try {
    const response = await proxyAwareFetch(
      quotaUrl,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
      },
      proxyOptions,
    );

    if (!response.ok) {
      if (response.status === 401) {
        return { message: "GLM API key invalid or expired." };
      }
      return { message: `GLM quota API error (${response.status}).` };
    }

    const json = await response.json();
    const { plan, quotas } = parseGlmQuotaResponse(json);
    // Optional: a missing/expired trial, a dead ZCode JWT or an upstream change
    // must never disturb the coding-plan usage that already succeeded.
    const startPlan = await getZaiStartPlan({
      zcodeJwtToken: providerSpecificData?.zcodeJwtToken,
      deviceMid: providerSpecificData?.deviceMid,
      proxyOptions,
    }).catch(() => null);
    return applyStartPlan({ plan, quotas }, startPlan, provider);
  } catch (error) {
    return { message: `GLM error: ${error.message}` };
  }
}

// Start Plan rides the same connection as the coding plan. While the trial is
// active it becomes one extra quota row; once it is gone (or never existed)
// the coding-plan usage is returned untouched, so nothing has to be unwound.
function applyStartPlan(usage, startPlan, provider) {
  if (provider !== "glm" || !startPlan?.active) return usage;
  const models = startPlan.modelIds.length ? ` — ${startPlan.modelIds.join(", ")}` : "";
  return {
    ...usage,
    plan: `${usage.plan} + Start Plan`,
    startPlan,
    quotas: {
      ...usage.quotas,
      "Start Plan": {
        name: `Start Plan (Active)${models}`,
        used: 0,
        total: 0,
        percentage: 0,
        percentageIsUsed: false,
        emptyMessage: null,
      },
    },
  };
}
