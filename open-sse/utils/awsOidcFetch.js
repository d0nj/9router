let nativeFetch = null;

const env = process.env;
const proxyConfigured = Boolean(
  env.HTTPS_PROXY || env.https_proxy ||
  env.HTTP_PROXY || env.http_proxy ||
  env.ALL_PROXY || env.all_proxy,
);

export async function awsOidcFetch(url, options = {}) {
  if (proxyConfigured) return fetch(url, options);
  nativeFetch ??= (await import("undici")).fetch;
  return nativeFetch(url, options);
}

export default awsOidcFetch;
