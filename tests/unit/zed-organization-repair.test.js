// Route-level regression: a Zed connection saved against the personal organization
// must be re-pointed at the plan-bearing one before the model catalog and LLM token
// are requested. Mocked below resolveZedModels, so globalThis.fetch cannot intercept
// (proxyAwareFetch captures native fetch at import time).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const stub = vi.hoisted(() => {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  return { calls: [], tokenBodies: [], failingTokenOrganization: null, nativeFetch };
});

const USER_INFO = {
  default_organization_id: "org-personal",
  organizations: [
    { id: "org-personal", name: "Personal", is_personal: true },
    { id: "org-work", name: "Work", is_personal: false },
  ],
  plans_by_organization: { "org-personal": "zed_free", "org-work": "zed_pro" },
};

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: async (url, options) => {
    const u = String(url);
    stub.calls.push(u);
    if (u.includes("cloud.zed.dev/client/users/me")) return Response.json(USER_INFO);
    if (u.includes("cloud.zed.dev/client/llm_tokens")) {
      const body = JSON.parse(options?.body || "{}");
      stub.tokenBodies.push(body);
      if (body.organization_id === stub.failingTokenOrganization) {
        return Response.json(
          { message: "Organization does not have an active subscription" },
          { status: 400 },
        );
      }
      return Response.json({ token: "llm-token" });
    }
    if (u.includes("cloud.zed.dev/models")) {
      return Response.json({
        models: [{ id: "claude-opus-4-live", display_name: "Opus", is_disabled: false }],
      });
    }
    return stub.nativeFetch(url, options);
  },
  default: async (url, options) => stub.nativeFetch(url, options),
}));

const originalDataDir = process.env.DATA_DIR;
let GET;
let createProviderConnection;
let getProviderConnectionById;
let fetchZedLlmToken;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "9router-zed-org-"));
  vi.resetModules();
  ({ GET } = await import("@/app/api/providers/[id]/models/route.js"));
  ({ createProviderConnection, getProviderConnectionById } = await import("@/models/index.js"));
  ({ fetchZedLlmToken } = await import("open-sse/shared/zedAuth.js"));
}, 30000);

afterAll(() => {
  // Windows keeps SQLite handles open past the suite, so rm can throw EBUSY.
  // The temp dir is disposable; never fail the suite for it.
  try {
    fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  } catch {}
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

beforeEach(() => {
  stub.calls.length = 0;
  stub.tokenBodies.length = 0;
  stub.failingTokenOrganization = null;
});

async function seedZedWithOrg(organizationId) {
  return createProviderConnection({
    provider: "zed",
    authType: "oauth",
    accessToken: `tok-org-${Date.now()}`,
    email: `zed-org-${Date.now()}@example.com`,
    providerSpecificData: { userId: "u-org", systemId: "sys-org", organizationId },
    testStatus: "active",
  });
}

async function getModels(connectionId) {
  const req = new Request(`http://localhost/api/providers/${connectionId}/models`);
  return GET(req, { params: Promise.resolve({ id: connectionId }) });
}

describe("Zed connection stored on the wrong organization", () => {
  it("mints the LLM token for the plan-bearing organization", async () => {
    const conn = await seedZedWithOrg("org-personal");
    const res = await getModels(conn.id);
    expect(res.status).toBe(200);
    expect(stub.tokenBodies).toEqual([{ organization_id: "org-work" }]);
    const data = await res.json();
    expect(data.models.map((m) => m.id)).toEqual(["claude-opus-4-live"]);
  });

  it("persists the corrected organization so later requests skip the repair", async () => {
    const conn = await seedZedWithOrg("org-personal");
    await getModels(conn.id);
    const stored = await getProviderConnectionById(conn.id);
    expect(stored.providerSpecificData.organizationId).toBe("org-work");
  });

  it("keeps a connection that is already on the plan-bearing organization", async () => {
    const conn = await seedZedWithOrg("org-work");
    await getModels(conn.id);
    const stored = await getProviderConnectionById(conn.id);
    expect(stored.providerSpecificData.organizationId).toBe("org-work");
  });

  it("retries an LLM token rejected for the stored organization against the paid one", async () => {
    stub.failingTokenOrganization = "org-personal";
    const token = await fetchZedLlmToken({
      accessToken: "tok-org-direct",
      providerSpecificData: { userId: "u-org", organizationId: "org-personal" },
    });
    expect(token).toBe("llm-token");
    expect(stub.tokenBodies).toEqual([
      { organization_id: "org-personal" },
      { organization_id: "org-work" },
    ]);
  });
});
