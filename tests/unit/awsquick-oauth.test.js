import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("open-sse/utils/awsOidcFetch.js", () => ({
  awsOidcFetch: (...args) => fetch(...args),
}));

import { generateAuthData, exchangeTokens } from "../../src/lib/oauth/providers/index.js";
import { buildAwsQuickOidcUrl } from "../../src/lib/oauth/providers/awsquick.js";
import { getAwsQuickSessionStatus, registerAwsQuickSession } from "../../src/lib/oauth/utils/server.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockAwsFetch() {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    if (String(url).includes("/client/register")) {
      return new Response(JSON.stringify({ clientId: "client-1", clientSecret: "secret-1" }), { status: 200 });
    }
    if (String(url).includes("/token")) {
      return new Response(JSON.stringify({
        accessToken: "access-1",
        refreshToken: "refresh-1",
        idToken: "id-1",
        expiresIn: 3600,
      }), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }));
}

describe("AWS Quick OAuth flow", () => {
  it("builds the Quick discovery start URL using the state as nonce", async () => {
    mockAwsFetch();
    const data = await generateAuthData("awsquick", "http://127.0.0.1:18080", { region: "us-east-1" });
    expect(data.flowType).toBe("authorization_code_pkce");
    expect(data.fixedPort).toBe(18080);
    const url = new URL(data.authUrl);
    expect(url.origin + url.pathname).toBe("https://quick.aws.com/sn");
    expect(url.searchParams.get("qwSurface")).toBe(`desktop:${data.state}:18080:1.2.4660`);

    const registerCall = vi.mocked(fetch).mock.calls.find(([u]) => String(u).includes("/client/register"));
    expect(JSON.parse(registerCall[1].body)).toEqual({
      clientName: "AmazonQuick-Desktop",
      clientType: "public",
      scopes: ["quicksight:read_write"],
      grantTypes: ["authorization_code", "refresh_token"],
      redirectUris: ["http://localhost:18080"],
      issuerUrl: expect.any(String),
    });
  });

  it("builds the OIDC authorize URL with PKCE and the loopback redirect", () => {
    const url = new URL(buildAwsQuickOidcUrl({
      codeVerifier: "a".repeat(43),
      state: "state-1",
      redirectUri: "http://127.0.0.1:18080",
      meta: { region: "us-east-1" },
    }));
    expect(url.origin + url.pathname).toBe("https://oidc.us-east-1.amazonaws.com/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:18080");
    expect(url.searchParams.get("scope")).toBe("quicksight:read_write");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("prompt")).toBe("login");
  });

  it("carries the discovered tenant URL into the stored connection data", async () => {
    mockAwsFetch();
    const mapped = await exchangeTokens(
      "awsquick",
      "code-1",
      "http://127.0.0.1:18080",
      "verifier-1",
      "state-1",
      { tenantUrl: "https://qbs-test.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev", issuerUrl: "https://identitycenter.amazonaws.com/ssoins-x", account: "123" },
    );
    expect(mapped.accessToken).toBe("access-1");
    expect(mapped.refreshToken).toBe("refresh-1");
    expect(mapped.providerSpecificData.tenantUrl).toBe("https://qbs-test.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev");
    expect(mapped.providerSpecificData.issuerUrl).toBe("https://identitycenter.amazonaws.com/ssoins-x");
    expect(mapped.providerSpecificData.account).toBe("123");
    expect(mapped.providerSpecificData.clientId).toBe("client-1");
  });

  it("registers loopback sessions for the proxy", () => {
    expect(registerAwsQuickSession({
      state: "state-9",
      codeVerifier: "verifier-9",
      redirectUri: "http://127.0.0.1:18080",
    })).toBe(true);
    expect(getAwsQuickSessionStatus("state-9")).toMatchObject({ status: "pending" });
  });
});
