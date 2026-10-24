import { buildZCodeHeaders } from "../shared/zcodeFingerprint.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

// ZCode answers business calls as { code, msg, data }; code 0/200 (or absent) is success.
function isSuccessCode(code) {
  return code === undefined || code === null || code === 0 || code === 200 || code === "0" || code === "200";
}

// Plan identities carry the Start Plan in plan_id/name ("start-plan").
function isStartPlanIdentity(value) {
  return typeof value === "string" && value.toLowerCase().includes("start-plan");
}

function hasActiveStartPlan(plans) {
  return (Array.isArray(plans) ? plans : []).some((plan) => {
    if (String(plan?.status ?? "").trim().toLowerCase() !== "active") return false;
    const id = String(plan?.plan_id ?? "").trim().toLowerCase();
    const name = String(plan?.name ?? "").trim().toLowerCase();
    // Upstream: an active plan carrying no identity at all counts as the
    // account's own. Any named plan must name the Start Plan.
    if (!id && !name) return true;
    return isStartPlanIdentity(id) || isStartPlanIdentity(name);
  });
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

function startPlanBase(config) {
  return config?.startPlan?.origin || "https://zcode.z.ai";
}

/**
 * Start Plan snapshot for a ZAI connection: whether the free trial is active
 * and which models still carry quota. Returns null when the connection has no
 * ZCode JWT (pasted coding-plan API keys never reach the trial) or when the
 * upstream answer is not a successful balance envelope.
 */
export async function getZaiStartPlan({ zcodeJwtToken, deviceMid, config, proxyOptions = null }) {
  const token = zcodeJwtToken?.trim();
  if (!token) return null;

  const url = new URL("/api/v1/zcode-plan/billing/balance", startPlanBase(config));
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

// Start Plan inference rides its own origin and pays from the trial pool, so a
// coding-plan key with no balance answers 1113 while the trial still works.
// Paths mirror buildZCodeEndpointUrls(): the OpenAI surface is bare, the Claude
// surface appends /v1/messages.
export function getStartPlanTransport(startPlan) {
  if (!startPlan?.origin) return null;
  return {
    openai: { baseUrl: `${startPlan.origin}/api/v1/zcode-plan/chat/completions`, format: "openai" },
    claude: { baseUrl: `${startPlan.origin}/api/v1/zcode-plan/anthropic/v1/messages`, format: "claude" },
  };
}

/**
 * Whether the Start Plan should serve this model: the trial must be active and
 * the balance pool must meter the model. Both come from the same snapshot.
 */
export function startPlanCoversModel(snapshot, modelId) {
  if (!snapshot?.active) return false;
  if (!snapshot.modelIds.length) return true;
  const wanted = String(modelId ?? "").trim().toLowerCase();
  return snapshot.modelIds.some((id) => id.toLowerCase() === wanted);
}
