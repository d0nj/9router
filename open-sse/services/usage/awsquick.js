import { AWS_QUICK } from "../../config/awsQuickConstants.js";
import { resolveAwsQuickTenantUrl } from "../../executors/awsquick.js";
import { fetchWithTimeout, parseResetTime, toFiniteNumber } from "./shared.js";

const PLAN_LABELS = {
  QUICK_LITE_FREE_TRIAL: "Free Trial",
  QUICK_LITE_FREE_TIER: "Free Tier",
  QUICK_LITE_INDIVIDUAL: "Lite",
  QUICK_LITE_INDIVIDUAL_ANNUAL: "Lite Annual",
  QUICK_LITE_TEAM: "Team",
  QUICK_LITE_TEAM_ANNUAL: "Team Annual",
  QUICK_LITE_PARTNER: "Partner",
  QUICK_MAX_TEAM: "Max Team",
  QUICK_MAX_TEAM_ANNUAL: "Max Team Annual",
};

function formatPlanName(subscriptionType) {
  if (typeof subscriptionType !== "string" || !subscriptionType.trim()) return "AWS Quick";
  const key = subscriptionType.trim().toUpperCase();
  if (PLAN_LABELS[key]) return PLAN_LABELS[key];
  return key
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function nextUtcMonthStartSec() {
  const now = new Date();
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) / 1000);
}

function adaptEntitlementsToUsageSummary(data) {
  const list = Array.isArray(data?.entitlements) ? data.entitlements : [];
  if (!list.length) return null;
  const entry = list.find((item) => item?.unitType === "AUTOMATION_AGENT_HOUR_UNIT") || list[0];
  if (!entry || typeof entry !== "object") return null;

  const available = toFiniteNumber(entry.numMinsAvailable, null);
  const provisioned = toFiniteNumber(entry.numMinsProvisioned, null);
  const usedPercentage = provisioned && provisioned > 0 && available !== null
    ? Math.max(0, Math.min(100, Math.round(((provisioned - available) / provisioned) * 100)))
    : 0;
  const rateLimit = entry.rateLimitStatus && typeof entry.rateLimitStatus === "object"
    ? entry.rateLimitStatus
    : null;

  return {
    monthlyUsage: {
      availableUnits: available,
      provisionedUnits: provisioned,
      resetsAt: nextUtcMonthStartSec(),
      usedPercentage,
    },
    ...(rateLimit
      ? {
          sessionUsage: {
            usedPercentage: toFiniteNumber(rateLimit.consumptionPercentage, 0),
            resumeInMinutes: toFiniteNumber(rateLimit.estimatedMinutesToResume, 0),
          },
        }
      : {}),
    subscription: data?.subscriptionMetadata || null,
  };
}

function buildWindowQuota(name, win, { resetAt = null, includeUnit = true } = {}) {
  if (!win || typeof win !== "object") return null;
  const provisioned = toFiniteNumber(win.provisionedUnits, null);
  const available = toFiniteNumber(win.availableUnits, null);
  const usedPct = toFiniteNumber(win.usedPercentage, null);

  if (provisioned !== null && provisioned > 0) {
    const used = available !== null
      ? Math.max(0, provisioned - available)
      : Math.round((provisioned * (usedPct ?? 0)) / 100);
    const remaining = available !== null ? Math.max(0, available) : Math.max(0, provisioned - used);
    const remainingPct = Math.max(0, Math.min(100, (remaining / provisioned) * 100));
    return {
      name,
      used,
      total: provisioned,
      ...(includeUnit ? { unit: "units" } : {}),
      percentage: remainingPct,
      percentageIsUsed: false,
      resetAt,
      emptyMessage: !resetAt && used === 0 ? "No usage in this window" : null,
    };
  }

  if (usedPct !== null) {
    const clampedUsed = Math.max(0, Math.min(100, usedPct));
    return {
      name,
      used: clampedUsed,
      total: 100,
      percentage: 100 - clampedUsed,
      percentageIsUsed: false,
      resetAt,
      emptyMessage: !resetAt && clampedUsed === 0 ? "No usage in this window" : null,
    };
  }

  return null;
}

export function parseAwsQuickUsage(data) {
  if (!data || typeof data !== "object") {
    return { message: "AWS Quick usage response was empty." };
  }

  const summary = data.usageSummary && typeof data.usageSummary === "object"
    ? data.usageSummary
    : Array.isArray(data.entitlements)
      ? adaptEntitlementsToUsageSummary(data)
      : null;

  if (!summary) {
    return { message: "AWS Quick usage summary not present in response." };
  }

  const plan = formatPlanName(summary.subscription?.subscriptionType);
  const quotas = {};

  const monthlyResetAt = parseResetTime(summary.monthlyUsage?.resetsAt);
  const monthlyQuota = buildWindowQuota("Monthly", summary.monthlyUsage, {
    resetAt: monthlyResetAt,
    includeUnit: true,
  });
  if (monthlyQuota) quotas.Monthly = monthlyQuota;

  const resumeMinutes = toFiniteNumber(summary.sessionUsage?.resumeInMinutes, 0);
  const sessionResetAt = resumeMinutes > 0
    ? new Date(Date.now() + resumeMinutes * 60_000).toISOString()
    : null;
  const sessionQuota = buildWindowQuota("Session", summary.sessionUsage, {
    resetAt: sessionResetAt,
    includeUnit: true,
  });
  if (sessionQuota) quotas.Session = sessionQuota;

  const overageCap = toFiniteNumber(summary.overageCapMinutes, 0);
  if (summary.overageEnabled === true && overageCap > 0) {
    const consumed = Math.max(0, toFiniteNumber(summary.overageConsumedMinutes, 0));
    const remainingPct = Math.max(0, Math.min(100, ((overageCap - consumed) / overageCap) * 100));
    quotas.Overage = {
      name: "Overage",
      used: consumed,
      total: overageCap,
      unit: "min",
      percentage: remainingPct,
      percentageIsUsed: false,
      resetAt: monthlyResetAt,
    };
  }

  if (Object.keys(quotas).length === 0) {
    return {
      plan,
      message: "AWS Quick connected. No usage quotas reported for this account.",
      quotas: {},
    };
  }

  return { plan, quotas };
}

export async function getAwsQuickUsage(connection, proxyOptions = null) {
  const token = (connection?.apiKey || connection?.accessToken || "").trim();
  if (!token) {
    return { message: "AWS Quick access token not available." };
  }

  let tenantUrl = null;
  try {
    tenantUrl = resolveAwsQuickTenantUrl(connection);
  } catch (err) {
    return { message: err.message };
  }
  if (!tenantUrl) {
    return { message: "AWS Quick tenant URL not available. Re-authorize or set providerSpecificData.tenantUrl." };
  }

  const baseHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "User-Agent": AWS_QUICK.headers["User-Agent"],
  };

  try {
    const userInfoRes = await fetchWithTimeout(
      `${tenantUrl}${AWS_QUICK.userInfoPath}`,
      {
        method: "POST",
        headers: {
          ...baseHeaders,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ excludeUserInfo: true }),
      },
      10000,
      proxyOptions,
    );

    if (userInfoRes.status === 401 || userInfoRes.status === 403) {
      return {
        plan: "AWS Quick",
        message: "AWS Quick authentication expired. Please re-authorize.",
      };
    }

    if (userInfoRes.ok) {
      const json = await userInfoRes.json().catch(() => null);
      if (json?.usageSummary) {
        return parseAwsQuickUsage(json);
      }
    }

    if (userInfoRes.status === 404 || userInfoRes.status === 405 || userInfoRes.status === 501 || userInfoRes.ok) {
      const entRes = await fetchWithTimeout(
        `${tenantUrl}${AWS_QUICK.entitlementsPath}`,
        { method: "GET", headers: baseHeaders },
        10000,
        proxyOptions,
      );
      if (entRes.status === 401 || entRes.status === 403) {
        return {
          plan: "AWS Quick",
          message: "AWS Quick authentication expired. Please re-authorize.",
        };
      }
      if (!entRes.ok) {
        return {
          plan: "AWS Quick",
          message: `AWS Quick usage API error (${entRes.status})`,
        };
      }
      const entJson = await entRes.json().catch(() => null);
      return parseAwsQuickUsage(entJson);
    }

    return {
      plan: "AWS Quick",
      message: `AWS Quick usage API error (${userInfoRes.status})`,
    };
  } catch (error) {
    return { message: `AWS Quick usage error: ${error.message}` };
  }
}
