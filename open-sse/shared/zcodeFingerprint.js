import { platform, arch, release } from "os";
import { getConsistentMachineId } from "./machineId.js";

// ZCode desktop client identity (zcode.z.ai). The Start Plan is gated on the
// same headers the official Electron app sends, so a bare Authorization header
// answers `coding_plan_not_entitled` even with a live trial.
export const ZCODE_APP_VERSION = "3.16.3";
export const ZCODE_REVERSE_PROXY_ORIGIN = "https://zcode.z.ai";

// ZCode normalizes the platform into three categories; anything else is linux.
export function zcodeOsCategory(platformName = platform()) {
  if (platformName === "darwin") return "macos";
  if (platformName === "win32") return "windows";
  return "linux";
}

function zcodeClientLanguage() {
  return Intl.DateTimeFormat().resolvedOptions().locale || "unknown";
}

function zcodeClientTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";
}

// Header keys and defaults mirror buildZCodeSourceHeadersFromContext().
export function buildZCodeHeaders({ deviceMid, appVersion = ZCODE_APP_VERSION, sourceTitle = "electron" } = {}) {
  return {
    "User-Agent": `ZCode/${appVersion}`,
    "HTTP-Referer": ZCODE_REVERSE_PROXY_ORIGIN,
    "X-Title": `Z Code@${sourceTitle}`,
    "X-ZCode-App-Version": appVersion,
    "X-Platform": `${platform()}-${arch()}`,
    "X-Client-Language": zcodeClientLanguage(),
    "X-Client-Timezone": zcodeClientTimezone(),
    "X-Os-Category": zcodeOsCategory(),
    "X-Os-Version": release(),
    ...(deviceMid ? { "X-Device-Mid": deviceMid } : {}),
  };
}

// Stable per-machine id, same shape as the telemetry deviceMid the app stores.
export async function resolveZCodeDeviceMid() {
  return getConsistentMachineId("zcode-device-mid");
}
