import { PROVIDER_OAUTH } from "../providers/index.js";
import { buildZCodeHeaders } from "../shared/zcodeFingerprint.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

const BALANCE_TIMEOUT_MS = 15_000;

// ZCode answers business calls as { code, msg, data }; code 0/200 (or absent) is success.
function isSuccessCode(code) {
  return code === undefined || code === null || code === 0 || code === 200 || code === "0" || code === "200";
}

// Plan identities carry the Start Plan in plan_id/name ("start-plan").
function isStartPlanIdentity(value) {
  return typeof value === "string" && value.toLowerCase().includes("start-plan");
}

function hasActiveStartPlan(plans) {
  return Boolean(
    Array.isArray(plans) &&
      plans.some((plan) => {
        if (String(plan?.status ?? "").trim().toLowerCase() !== "active") return false;
        const id = String(plan?.plan_id ?? "").trim().toLowerCase();
        const name = String(plan?.name ?? "").trim().toLowerCase();
        // Upstream: an active plan carrying no identity at all counts as the
        // account's own. Any named plan must name the Start Plan.
        if (!id && !name) return true;
        return isStartPlanIdentity(id) || isStartPlanIdentity(name);
      })
  );
}

// Trial entitlements are grouped by the models they meter ("model:<id>").
function startPlanModelIds(balances) {
  const seen = new Set();
  const ids = [];
  for (const balance of Array.isArray(balances) ? balances : []) {
    const capabilities = (balance?.capabilities ?? []).map((entry) => {
      const capability = String(entry ?? "").trim();
      return capability.toLowerCase().startsWith("model:") ? capability.slice(6).trim() : "";
    });
    for (const modelId of capabilities.length ? capabilities : [balance?.show_name ?? ""]) {
      const id = modelId.trim();
      if (!id || seen.has(id.toLowerCase())) continue;
      seen.add(id.toLowerCase());
      ids.push(id);
    }
  }
  return ids;
}

/**
 * Start Plan snapshot for a ZAI connection: whether the free trial is active
 * and which models still carry quota. Returns null when the connection has no
 * ZCode JWT (pasted coding-plan API keys never reach the trial) or when the
 * upstream answer is not a successful balance envelope.
 */
export async function getZaiStartPlan({ zcodeJwtToken, deviceMid, proxyOptions = null }) {
  const token = zcodeJwtToken?.trim();
  const balanceUrl = PROVIDER_OAUTH.glm?.startPlan?.billingBalanceUrl;
  if (!token || !balanceUrl) return null;

  const url = new URL(balanceUrl);
  const response = await proxyAwareFetch(
    url.href,
    {
      method: "GET",
      headers: {
        ...buildZCodeHeaders({ deviceMid }),
        authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    },
    proxyOptions
  );

  if (!response.ok) return null;
  const payload = await response.json().catch(() => null);
  if (!payload || !isSuccessCode(payload.code)) return null;

  const plans = Array.isArray(payload.data?.plans) ? payload.data.plans : [];
  return {
    active: hasActiveStartPlan(plans),
    expired: plans.some((plan) => String(plan?.status ?? "").toLowerCase() === "expired"),
    modelIds: startPlanModelIds(payload.data?.balances),
    plans: plans.map((plan) => ({
      name: plan?.name ?? null,
      planId: plan?.plan_id ?? null,
      status: plan?.status ?? null,
    })),
  };
}
