import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    }),
  },
}));

const exchangeTokens = vi.fn(async () => ({
  accessToken: "access-1",
  refreshToken: "refresh-1",
  expiresIn: 3600,
  providerSpecificData: { tenantUrl: "https://tenant.example" },
}));
const createProviderConnection = vi.fn(async (data) => ({ id: "conn-1", ...data }));

vi.mock("@/lib/oauth/providers", () => ({
  getProvider: vi.fn(() => ({ flowType: "authorization_code_pkce" })),
  generateAuthData: vi.fn(),
  exchangeTokens,
  requestDeviceCode: vi.fn(),
  pollForToken: vi.fn(),
  extractCodexAccountInfo: vi.fn(() => ({})),
}));

vi.mock("@/models", () => ({ createProviderConnection }));
vi.mock("@/lib/localDb", () => ({ getProviderConnections: vi.fn(async () => []) }));
vi.mock("open-sse/services/minimaxCodeLease.js", () => ({
  requestLease: vi.fn(),
  requestStatus: vi.fn(),
  resolveLeaseEndpoint: vi.fn(),
  resolveMcodeDataDir: vi.fn(() => "/tmp"),
  AuthLeaseError: class AuthLeaseError extends Error {},
}));
vi.mock("open-sse/shared/mimoAccount.js", () => ({ readDesktopPassToken: vi.fn() }));
vi.mock("@/lib/oauth/utils/ideDetect", () => ({ detectIdeInstalled: vi.fn() }));
vi.mock("@/lib/oauth/utils/server", () => {
  const noop = () => {};
  const notUsed = () => { throw new Error("unexpected helper"); };
  return {
    startCodexProxy: notUsed, stopCodexProxy: noop, registerCodexSession: noop,
    getCodexSessionStatus: () => null, clearCodexSession: noop,
    startXaiProxy: notUsed, stopXaiProxy: noop, registerXaiSession: noop,
    getXaiSessionStatus: () => null, clearXaiSession: noop,
    startAwsQuickProxy: notUsed, stopAwsQuickProxy: noop,
    registerAwsQuickSession: noop, getAwsQuickSessionStatus: () => null, clearAwsQuickSession: noop,
    startTraeProxy: notUsed, stopTraeProxy: noop, registerTraeSession: noop,
    getTraeSessionStatus: () => null, clearTraeSession: noop,
    startWindsurfProxy: notUsed, stopWindsurfProxy: noop, registerWindsurfSession: noop,
    getWindsurfSessionStatus: () => null, clearWindsurfSession: noop,
    startZedProxy: notUsed, stopZedProxy: noop, registerZedSession: noop,
    getZedSessionStatus: () => null, clearZedSession: noop,
    startXiaomiMimoProxy: notUsed, stopXiaomiMimoProxy: noop,
    registerXiaomiMimoSession: noop, getXiaomiMimoSessionStatus: () => null, clearXiaomiMimoSession: noop,
  };
});

const { POST } = await import("../../src/app/api/oauth/[provider]/[action]/route.js");

function post(provider, action, body) {
  return POST(
    new Request(`http://localhost/api/oauth/${provider}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ provider, action }) },
  );
}

describe("AWS Quick token exchange through the OAuth route", () => {
  beforeEach(() => {
    exchangeTokens.mockClear();
    createProviderConnection.mockClear();
  });

  it("exchanges a JWT-shaped authorization code via the provider, not as a raw token", async () => {
    const code = "eyJhbGciOiJIUzM4NCJ9.eyJ0eXBlIjoiYXV0aENvZGUifQ.signature";
    const res = await post("awsquick", "exchange", {
      code,
      redirectUri: "http://127.0.0.1:18080",
      codeVerifier: "verifier-1",
      state: "state-1",
      meta: { tenantUrl: "https://tenant.example" },
    });

    expect(res.status).toBe(200);
    expect(exchangeTokens).toHaveBeenCalledWith(
      "awsquick", code, "http://127.0.0.1:18080", "verifier-1", "state-1",
      { tenantUrl: "https://tenant.example" },
    );
    expect(createProviderConnection).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "awsquick", authType: "oauth" }),
    );
  });

  it("still treats a JWT-shaped code as a raw token for other providers", async () => {
    const code = "eyJhbGciOiJIUzM4NCJ9.eyJ0eXBlIjoiYXV0aENvZGUifQ.signature";
    const res = await post("cline", "exchange", { code });
    expect(res.status).toBe(200);
    expect(exchangeTokens).not.toHaveBeenCalled();
    expect(createProviderConnection).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "cline", authType: "access_token" }),
    );
  });
});
