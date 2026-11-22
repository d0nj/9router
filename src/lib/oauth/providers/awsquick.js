import crypto from "crypto";
import { AWS_QUICK_CONFIG, assertValidAwsRegion } from "../constants/oauth.js";
import { extractEmailFromAccessToken } from "../providerHelpers.js";

let cachedClient = null;

function endpointsFor(region) {
  assertValidAwsRegion(region);
  return {
    registerUrl: `https://oidc.${region}.amazonaws.com/client/register`,
    authorizeUrl: `https://oidc.${region}.amazonaws.com/authorize`,
    tokenUrl: `https://oidc.${region}.amazonaws.com/token`,
  };
}

async function registerClient(config, meta) {
  if (cachedClient) return cachedClient;
  const region = meta?.region || config.region || "us-east-1";
  const { registerUrl } = endpointsFor(region);
  const response = await fetch(registerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      clientName: config.clientName,
      clientType: config.clientType,
      scopes: config.scopes,
      grantTypes: config.grantTypes,
      ...(meta?.issuer_url || config.issuerUrl
        ? { issuerUrl: meta?.issuer_url || config.issuerUrl }
        : {}),
    }),
  });
  if (!response.ok) {
    throw new Error(`AWS Quick client registration failed: ${await response.text()}`);
  }
  const data = await response.json();
  if (!data.clientId || !data.clientSecret) {
    throw new Error("AWS Quick client registration returned no credentials");
  }
  cachedClient = {
    clientId: data.clientId,
    clientSecret: data.clientSecret,
    region,
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
    const endpoints = endpointsFor(region);
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
    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        grantType: "authorization_code",
        code,
        redirectUri,
        codeVerifier,
      }),
    });
    if (!response.ok) {
      throw new Error(`AWS Quick token exchange failed: ${await response.text()}`);
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
        idToken: tokens.id_token || tokens.idToken,
      },
    };
    return mapped;
  },
};

export function buildAwsQuickOidcUrl({ codeVerifier, state, redirectUri, meta = {} }) {
  const region = meta?.region || AWS_QUICK_CONFIG.region;
  const config = { ...AWS_QUICK_CONFIG, ...meta, ...endpointsFor(region) };
  return oidcAuthorizeUrl(config, codeVerifier, state, redirectUri || config.redirectUri);
}

export default awsquick;
