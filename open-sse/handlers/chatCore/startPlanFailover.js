import { PROVIDERS } from "../../config/providers.js";
import { getStartPlanTransport, startPlanCoversModel } from "../../services/startPlan.js";

// GLM answer for "this key's balance is empty" — the coding plan is exhausted,
// but a Start Plan trial on the same connection may still have quota.
const INSUFFICIENT_BALANCE_CODES = new Set([1113]);

function isInsufficientBalance(status, bodyText) {
  if (status !== 429 && status !== 402) return false;
  if (!bodyText) return false;
  try {
    const json = JSON.parse(bodyText);
    const code = json?.error?.code ?? json?.code;
    if (INSUFFICIENT_BALANCE_CODES.has(Number(code))) return true;
  } catch {
    // fall through to the message check
  }
  return /insufficient balance/i.test(bodyText);
}

/**
 * Retry an exhausted coding-plan request against the Start Plan origin when the
 * same connection carries an active trial that meters this model. Returns the
 * new response and URL, or null to let the caller surface the original error.
 */
export async function retryOnStartPlan({ provider, model, format, status, bodyText, credentials, execute }) {
  if (!isInsufficientBalance(status, bodyText)) return null;
  if (!startPlanCoversModel(credentials?.startPlan, model)) return null;

  const transports = getStartPlanTransport(PROVIDERS[provider]?.startPlan);
  const transport = transports?.[format];
  if (!transport || !credentials) return null;

  const previous = credentials.runtimeTransport;
  credentials.runtimeTransport = transport;
  try {
    const result = await execute();
    if (!result?.response?.ok) return null;
    return result;
  } finally {
    if (previous) credentials.runtimeTransport = previous;
    else delete credentials.runtimeTransport;
  }
}
