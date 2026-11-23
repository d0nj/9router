export const AWS_QUICK = {
  proxyPath: "/integration/quick-work/bedrock-proxy",
  proxyStreamPath: "/integration/quick-work/bedrock-proxy-stream",
  userInfoPath: "/integration/quick-work/user-info",
  entitlementsPath: "/agenticmetering/v1/get-available-entitlement-units",
  apiType: "CONVERSE",
  source: "user-conversation",
  headers: {
    "User-Agent": "Amazon Quick/1.2.4660",
    "X-QuickDsk-mdid": "user-conversation",
    "x-amzn-quick-atype": "ufg",
  },
  allowedSystemPrefix:
    "You classify whether numbers marked in text are real credit card numbers or false positives.\n\nEach marked number already passed ",
};

export default AWS_QUICK;
