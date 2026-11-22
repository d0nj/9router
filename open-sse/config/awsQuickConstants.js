export const AWS_QUICK = {
  proxyPath: "/integration/quick-work/bedrock-proxy",
  proxyStreamPath: "/integration/quick-work/bedrock-proxy-stream",
  apiType: "CONVERSE",
  source: "redaction-validator",
  headers: {
    "User-Agent": "Amazon Quick/1.2.4660",
    "X-QuickDsk-mdid": "redaction-validator",
  },
};

export default AWS_QUICK;
