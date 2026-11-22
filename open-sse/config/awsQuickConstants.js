export const AWS_QUICK = {
  proxyPath: "/integration/quick-work/bedrock-proxy",
  proxyStreamPath: "/integration/quick-work/bedrock-proxy-stream",
  apiType: "CONVERSE",
  source: "user-conversation",
  headers: {
    "User-Agent": "Amazon Quick/1.2.4660",
    "X-QuickDsk-mdid": "user-conversation",
    "x-amzn-quick-atype": "ufg",
  },
};

export default AWS_QUICK;
