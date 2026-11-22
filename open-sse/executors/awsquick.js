import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { AWS_QUICK } from "../config/awsQuickConstants.js";
import { FORMATS } from "../translator/formats.js";
import { SSE_DONE, SSE_HEADERS } from "../utils/sseConstants.js";
import { sseChunk } from "../utils/sse.js";

function decodeBase64Url(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return null;
  return { format: match[1], bytes: match[2] };
}

function toConverseContent(content) {
  if (typeof content === "string") return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" || part.type === "input_text" || part.type === "output_text") {
      if (part.text != null) blocks.push({ text: String(part.text) });
      continue;
    }
    if (part.type === "image_url" || part.type === "image") {
      const value = part.image_url?.url || part.url || part.source?.data;
      const image = decodeBase64Url(value);
      if (image) blocks.push({ image });
      continue;
    }
    if (part.type === "tool_use") {
      let input = part.input;
      if (typeof input === "string") {
        try {
          input = JSON.parse(input);
        } catch {
          input = {};
        }
      }
      blocks.push({ toolUse: { toolUseId: part.id, name: part.name, input: input || {} } });
      continue;
    }
    if (part.type === "tool_result") {
      blocks.push({
        toolResult: {
          toolUseId: part.tool_use_id,
          content: toConverseContent(part.content),
        },
      });
    }
  }
  return blocks;
}

function toConverseMessages(messages) {
  const result = [];
  for (const message of messages || []) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      result.push({
        role: "user",
        content: [{ toolResult: { toolUseId: message.tool_call_id, content: toConverseContent(message.content) } }],
      });
      continue;
    }
    const content = toConverseContent(message.content);
    for (const call of message.tool_calls || []) {
      let input = call.function?.arguments;
      if (typeof input === "string") {
        try {
          input = JSON.parse(input);
        } catch {
          input = {};
        }
      }
      content.push({ toolUse: { toolUseId: call.id, name: call.function?.name, input: input || {} } });
    }
    result.push({ role: message.role === "assistant" ? "assistant" : "user", content });
  }
  return result;
}

function toConverseRequest(body) {
  const request = {};
  const system = (body.messages || [])
    .filter((message) => message.role === "system")
    .flatMap((message) => toConverseContent(message.content))
    .filter((block) => block.text != null);
  if (system.length) request.system = system;
  request.messages = toConverseMessages(body.messages);

  const inferenceConfig = {};
  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  if (maxTokens != null) inferenceConfig.maxTokens = maxTokens;
  if (body.temperature != null) inferenceConfig.temperature = body.temperature;
  if (body.top_p != null) inferenceConfig.topP = body.top_p;
  if (Array.isArray(body.stop) && body.stop.length) inferenceConfig.stopSequences = body.stop;
  if (Object.keys(inferenceConfig).length) request.inferenceConfig = inferenceConfig;

  if (Array.isArray(body.tools) && body.tools.length) {
    const tools = body.tools
      .filter((tool) => tool?.type === "function" && tool.function?.name)
      .map((tool) => ({
        toolSpec: {
          name: tool.function.name,
          description: tool.function.description || "",
          inputSchema: { json: tool.function.parameters || { type: "object", properties: {} } },
        },
      }));
    if (tools.length) {
      request.toolConfig = { tools };
      if (body.tool_choice && typeof body.tool_choice === "object" && body.tool_choice.function?.name) {
        request.toolConfig.toolChoice = { tool: { name: body.tool_choice.function.name } };
      } else if (body.tool_choice === "required" || body.tool_choice === "any") {
        request.toolConfig.toolChoice = { any: {} };
      } else if (body.tool_choice === "none") {
        delete request.toolConfig;
      }
    }
  }
  return request;
}

function converseResponseToOpenAI(data, model) {
  const message = data?.output?.message || {};
  let text = "";
  const toolCalls = [];
  for (const block of message.content || []) {
    if (block?.text != null) text += block.text;
    if (block?.toolUse) {
      toolCalls.push({
        id: block.toolUse.toolUseId,
        type: "function",
        function: {
          name: block.toolUse.name,
          arguments: typeof block.toolUse.input === "string"
            ? block.toolUse.input
            : JSON.stringify(block.toolUse.input || {}),
        },
      });
    }
  }
  const finishReason = data?.stopReason === "tool_use" ? "tool_calls" : "stop";
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: finishReason,
    }],
    usage: {
      prompt_tokens: data?.usage?.inputTokens || 0,
      completion_tokens: data?.usage?.outputTokens || 0,
      total_tokens: data?.usage?.totalTokens || (data?.usage?.inputTokens || 0) + (data?.usage?.outputTokens || 0),
    },
  };
}

function parseProxyEvent(line) {
  let text = line.trim();
  if (!text || text === "[DONE]") return null;
  if (text.startsWith("data:")) text = text.slice(5).trim();
  if (!text || text === "[DONE]") return null;
  try {
    const parsed = JSON.parse(text);
    return parsed?.event || parsed?.chunk || parsed;
  } catch {
    return null;
  }
}

export class AWSQuickExecutor extends BaseExecutor {
  constructor() {
    super("awsquick", PROVIDERS.awsquick || {});
  }

  resolveTenantUrl(credentials) {
    const fromData = credentials?.providerSpecificData?.tenantUrl
      || credentials?.providerSpecificData?.tenant_url
      || credentials?.runtimeTransport?.baseUrl;
    if (!fromData) return null;
    const url = new URL(String(fromData));
    if (url.protocol !== "https:") throw new Error("AWS Quick: tenant URL must use HTTPS");
    if (url.username || url.password) throw new Error("AWS Quick: tenant URL must not contain credentials");
    const host = url.hostname;
    const allowed = host.endsWith(".aws.dev")
      || host.endsWith(".amazonaws.com")
      || host.endsWith(".quick.aws.com");
    if (!allowed) throw new Error("AWS Quick: tenant URL host is not an AWS Quick DataPlane host");
    return url.origin;
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    const tenantUrl = this.resolveTenantUrl(credentials);
    if (!tenantUrl) {
      throw new Error("AWS Quick: missing tenant URL. Set providerSpecificData.tenantUrl to your Quick tenant DataPlane URL.");
    }
    return `${tenantUrl}${stream ? AWS_QUICK.proxyStreamPath : AWS_QUICK.proxyPath}`;
  }

  buildHeaders(credentials, stream = true) {
    const token = credentials?.apiKey || credentials?.accessToken;
    if (!token) throw new Error("AWS Quick: missing access token");
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...AWS_QUICK.headers,
    };
  }

  transformRequest(model, body, stream, credentials) {
    const requestBody = toConverseRequest(body || {});
    delete requestBody.modelId;
    return {
      modelId: model,
      apiType: AWS_QUICK.apiType,
      requestBody,
    };
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null, providerOverrides = null, directFetch = null }) {
    const result = await super.execute({
      model,
      body,
      stream,
      credentials,
      signal,
      log,
      proxyOptions,
      providerOverrides,
      directFetch,
    });
    if (!result?.response?.ok) return result;
    if (!stream || !result.response.body) {
      const text = await result.response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return { ...result, response: new Response(text, { status: result.response.status }), responseFormat: FORMATS.OPENAI };
      }
      const converted = converseResponseToOpenAI(data, model);
      return {
        ...result,
        response: new Response(JSON.stringify(converted), {
          status: result.response.status,
          headers: { "Content-Type": "application/json" },
        }),
        responseFormat: FORMATS.OPENAI,
      };
    }

    const reader = result.response.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const id = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    let buffer = "";
    let cancelled = false;

    const responseStream = new ReadableStream({
      async pull(controller) {
        while (!cancelled) {
          const { done, value } = await reader.read();
          if (done) {
            controller.enqueue(encoder.encode(SSE_DONE));
            controller.close();
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            const event = parseProxyEvent(line);
            if (!event) continue;
            const chunk = proxyEventToOpenAIChunk(event, id, created, model);
            if (chunk) controller.enqueue(encoder.encode(sseChunk(chunk)));
          }
        }
      },
      cancel(reason) {
        cancelled = true;
        return reader.cancel(reason);
      },
    });

    return {
      ...result,
      response: new Response(responseStream, {
        status: result.response.status,
        headers: { ...SSE_HEADERS },
      }),
      responseFormat: FORMATS.OPENAI,
    };
  }

  parseError(response, bodyText) {
    try {
      const parsed = JSON.parse(bodyText);
      const message = parsed?.message || parsed?.error?.message || parsed?.error;
      if (typeof message === "string") return message;
    } catch {}
    return super.parseError(response, bodyText);
  }
}

function proxyEventToOpenAIChunk(event, id, created, model) {
  const base = { id, object: "chat.completion.chunk", created, model };
  const deltaEvent = event.contentBlockDelta?.delta || event.delta;
  if (deltaEvent?.text != null) {
    return { ...base, choices: [{ index: 0, delta: { content: deltaEvent.text }, finish_reason: null }] };
  }
  if (deltaEvent?.toolUse) {
    const tool = deltaEvent.toolUse;
    return {
      ...base,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: tool.index || 0,
            ...(tool.name ? { id: tool.toolUseId, type: "function", function: { name: tool.name, arguments: "" } } : {}),
            ...(tool.input != null ? { function: { arguments: typeof tool.input === "string" ? tool.input : JSON.stringify(tool.input) } } : {}),
          }],
        },
        finish_reason: null,
      }],
    };
  }
  if (event.contentBlockStart?.start?.toolUse) {
    const tool = event.contentBlockStart.start.toolUse;
    return {
      ...base,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: event.contentBlockStart.contentBlockIndex || 0,
            id: tool.toolUseId,
            type: "function",
            function: { name: tool.name, arguments: "" },
          }],
        },
        finish_reason: null,
      }],
    };
  }
  if (event.messageStop) {
    const finishReason = event.messageStop.stopReason === "tool_use" ? "tool_calls" : "stop";
    return { ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] };
  }
  if (event.metadata?.usage) {
    const usage = event.metadata.usage;
    return {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: null }],
      usage: {
        prompt_tokens: usage.inputTokens || 0,
        completion_tokens: usage.outputTokens || 0,
        total_tokens: usage.totalTokens || (usage.inputTokens || 0) + (usage.outputTokens || 0),
      },
    };
  }
  return null;
}

export function buildAWSQuickRequestBody(model, body) {
  const requestBody = toConverseRequest(body || {});
  delete requestBody.modelId;
  return { modelId: model, apiType: AWS_QUICK.apiType, requestBody };
}

export function parseAWSQuickResponse(data, model) {
  return converseResponseToOpenAI(data, model);
}

export default AWSQuickExecutor;
