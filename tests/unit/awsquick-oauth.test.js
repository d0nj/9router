import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("open-sse/utils/awsOidcFetch.js", () => ({
  awsOidcFetch: (...args) => fetch(...args),
}));

import { generateAuthData, exchangeTokens } from "../../src/lib/oauth/providers/index.js";
import { buildAwsQuickOidcUrl, parseAwsQuickDiscovery } from "../../src/lib/oauth/providers/awsquick.js";
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
      redirectUris: ["http://127.0.0.1:18080"],
      issuerUrl: expect.any(String),
    });
  });

  it("builds the OIDC authorize URL with the registered client, PKCE and loopback redirect", async () => {
    mockAwsFetch();
    const started = await generateAuthData("awsquick", "http://127.0.0.1:18080", { region: "us-east-1" });
    const url = new URL(buildAwsQuickOidcUrl({
      codeVerifier: started.codeVerifier,
      state: started.state,
      redirectUri: "http://127.0.0.1:18080",
      meta: { region: "us-east-1" },
    }));
    expect(url.origin + url.pathname).toBe("https://oidc.us-east-1.amazonaws.com/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.searchParams.get("state")).toBe(started.state);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:18080");
    expect(url.searchParams.get("scope")).toBe("quicksight:read_write");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("prompt")).toBe("login");
  });

  it("turns the AWS Quick discovery callback into OIDC login material", async () => {
    mockAwsFetch();
    const started = await generateAuthData("awsquick", "http://127.0.0.1:18080", { region: "us-east-1" });
    const tenantUrl = "https://qbs-test.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev";
    const discoveryUrl = `http://localhost:18080/callback?nonce=${encodeURIComponent(started.state)}&account=123&issuerUrl=https%3A%2F%2Fidentitycenter.amazonaws.com%2Fssoins-x&tenantUrl=${encodeURIComponent(tenantUrl)}&idcInstanceId=ssoins-x&idcRegion=us-east-1`;

    const meta = parseAwsQuickDiscovery(discoveryUrl);
    expect(meta).toMatchObject({ nonce: started.state, tenantUrl, account: "123", idcRegion: "us-east-1" });

    const oidcUrl = new URL(buildAwsQuickOidcUrl({
      codeVerifier: started.codeVerifier,
      state: started.state,
      redirectUri: started.redirectUri,
      meta: { ...meta, region: meta.idcRegion },
    }));
    expect(oidcUrl.searchParams.get("client_id")).toBe("client-1");
    expect(oidcUrl.searchParams.get("state")).toBe(started.state);
    expect(oidcUrl.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:18080");
  });

  it("rejects a callback that is not the discovery redirect", () => {
    expect(() => parseAwsQuickDiscovery("http://localhost:18080/callback?code=abc")).toThrow(/tenantUrl/);
    expect(() => parseAwsQuickDiscovery("not a url")).toThrow(/Invalid Quick callback URL/);
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
