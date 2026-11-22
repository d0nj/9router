import crypto from "crypto";
import { AWS_QUICK_CONFIG, assertValidAwsRegion } from "../constants/oauth.js";
import { extractEmailFromAccessToken } from "../providerHelpers.js";
import { awsOidcFetch } from "open-sse/utils/awsOidcFetch.js";

let cachedClient = null;

function oidcHosts(region) {
  assertValidAwsRegion(region);
  return [`oidc.${region}.amazonaws.com`, `oidc.${region}.api.aws`];
}

function endpointsFor(region, host) {
  const base = `https://${host || oidcHosts(region)[0]}`;
  return {
    registerUrl: `${base}/client/register`,
    authorizeUrl: `${base}/authorize`,
    tokenUrl: `${base}/token`,
  };
}

async function postOidc(hosts, path, body, label) {
  const failures = [];
  for (const host of hosts) {
    const url = `https://${host}${path}`;
    let response;
    try {
      response = await awsOidcFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      failures.push(`${host}: ${error.message}${error.cause?.code ? ` (${error.cause.code})` : ""}`);
      continue;
    }
    return { host, response, url };
  }
  throw new Error(`AWS Quick ${label} could not reach OIDC endpoints [${failures.join("; ")}]`);
}

async function registerClient(config, meta) {
  if (cachedClient) return cachedClient;
  const region = meta?.region || config.region || "us-east-1";
  const { host, response } = await postOidc(oidcHosts(region), "/client/register", {
    clientName: config.clientName,
    clientType: config.clientType,
    scopes: config.scopes,
    grantTypes: config.grantTypes,
    redirectUris: [config.registerRedirectUri || config.redirectUri],
    ...(meta?.issuer_url || config.issuerUrl
      ? { issuerUrl: meta?.issuer_url || config.issuerUrl }
      : {}),
  }, "client registration");
  if (!response.ok) {
    throw new Error(`AWS Quick client registration failed (${host}): ${await response.text()}`);
  }
  const data = await response.json();
  if (!data.clientId || !data.clientSecret) {
    throw new Error("AWS Quick client registration returned no credentials");
  }
  cachedClient = {
    clientId: data.clientId,
    clientSecret: data.clientSecret,
    region,
    host,
    expiresAt: data.clientSecretExpiresAt || null,
  };
  return cachedClient;
}

function oidcAuthorizeUrl(config, codeVerifier, state, redirectUri) {
  const digest = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: config.scope || "quicksight:read_write",
    state,
    code_challenge: digest,
    code_challenge_method: "S256",
    prompt: "login",
  });
  return `${config.authorizeUrl}?${params.toString()}`;
}

const awsquick = {
  config: AWS_QUICK_CONFIG,
  flowType: "authorization_code_pkce",
  fixedPort: AWS_QUICK_CONFIG.fixedPort,
  callbackPath: AWS_QUICK_CONFIG.callbackPath,

  prepareConfig: async (config, meta = {}) => {
    const client = await registerClient(config, meta);
    const region = client.region;
    const endpoints = endpointsFor(region, client.host);
    return {
      ...config,
      ...endpoints,
      region,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirectUri: config.redirectUri || "http://127.0.0.1:18080",
    };
  },

  buildAuthUrl: (config, redirectUri, state) => {
    const qwSurface = `desktop:${state}:${config.fixedPort || 18080}:${config.appVersion || "1.2.4660"}`;
    const params = new URLSearchParams({ qwSurface });
    return `${config.quickStartUrl}?${params.toString()}`;
  },

  exchangeToken: async (config, code, redirectUri, codeVerifier, state, meta = {}) => {
    const region = config.region || "us-east-1";
    const { host, response } = await postOidc(oidcHosts(region), "/token", {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      grantType: "authorization_code",
      code,
      redirectUri,
      codeVerifier,
    }, "token exchange");
    if (!response.ok) {
      throw new Error(`AWS Quick token exchange failed (${host}): ${await response.text()}`);
    }
    const data = await response.json();
    return {
      ...data,
      access_token: data.accessToken,
      refresh_token: data.refreshToken,
      id_token: data.idToken,
      expires_in: data.expiresIn,
      tenantUrl: meta?.tenantUrl,
      issuerUrl: meta?.issuerUrl,
      account: meta?.account,
      idcInstanceId: meta?.idcInstanceId,
      idcRegion: meta?.idcRegion,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      region: config.region,
    };
  },

  mapTokens: (tokens) => {
    const mapped = {
      accessToken: tokens.access_token || tokens.accessToken,
      refreshToken: tokens.refresh_token || tokens.refreshToken,
      expiresIn: tokens.expires_in || tokens.expiresIn,
      idToken: tokens.id_token || tokens.idToken,
      email: extractEmailFromAccessToken(tokens.access_token || tokens.accessToken),
      providerSpecificData: {
        tenantUrl: tokens.tenantUrl,
        issuerUrl: tokens.issuerUrl,
        account: tokens.account,
        idcInstanceId: tokens.idcInstanceId,
        idcRegion: tokens.idcRegion,
        clientId: tokens.clientId,
        clientSecret: tokens.clientSecret,
        region: tokens.region,
        oidcHost: cachedClient?.host,
        idToken: tokens.id_token || tokens.idToken,
      },
    };
    return mapped;
  },
};

export function parseAwsQuickDiscovery(callbackUrl) {
  let url;
  try {
    url = new URL(String(callbackUrl));
  } catch {
    throw new Error("Invalid Quick callback URL — paste the full URL from the address bar");
  }
  const tenantUrl = url.searchParams.get("tenantUrl");
  if (!tenantUrl) {
    throw new Error("Quick discovery callback has no tenantUrl — paste the first redirect URL (the one from quick.aws.com sign-in)");
  }
  return {
    nonce: url.searchParams.get("nonce"),
    tenantUrl,
    issuerUrl: url.searchParams.get("issuerUrl"),
    account: url.searchParams.get("account"),
    idcInstanceId: url.searchParams.get("idcInstanceId"),
    idcRegion: url.searchParams.get("idcRegion"),
  };
}

export function buildAwsQuickOidcUrl({ codeVerifier, state, redirectUri, meta = {} }) {
  const region = meta?.region || AWS_QUICK_CONFIG.region;
  const config = {
    ...AWS_QUICK_CONFIG,
    ...(cachedClient ? { clientId: cachedClient.clientId } : {}),
    ...meta,
    ...endpointsFor(region, cachedClient?.host),
  };
  return oidcAuthorizeUrl(config, codeVerifier, state, redirectUri || config.redirectUri);
}

export default awsquick;
