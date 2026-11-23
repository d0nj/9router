import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { AWS_QUICK } from "../config/awsQuickConstants.js";
import { AWS_EVENTSTREAM } from "../config/awsConstants.js";
import { FORMATS } from "../translator/formats.js";
import { SSE_DONE, SSE_HEADERS } from "../utils/sseConstants.js";
import { sseChunk } from "../utils/sse.js";
import { crc32, parseEventFrame } from "../utils/awsEventStream.js";

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
  const pushTurn = (role, blocks) => {
    if (!blocks.length) return;
    const prev = result[result.length - 1];
    if (prev && prev.role === role) {
      prev.content.push(...blocks);
    } else {
      result.push({ role, content: blocks });
    }
  };
  for (const message of messages || []) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      pushTurn("user", [{
        toolResult: {
          toolUseId: message.tool_call_id,
          content: toConverseContent(message.content),
        },
      }]);
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
    pushTurn(message.role === "assistant" ? "assistant" : "user", content);
  }
  return result;
}

const ADAPTIVE_THINKING_RE = /claude-(opus-4-8|.*-5(?:-|$))/i;
const THINKING_EFFORTS = new Set(["low", "medium", "high", "max"]);

function resolveThinkingEffort(body) {
  const raw = body?.reasoning_effort || body?.reasoning?.effort;
  if (typeof raw === "string") {
    const normalized = raw.toLowerCase();
    if (normalized === "xhigh") return "max";
    if (THINKING_EFFORTS.has(normalized)) return normalized;
  }
  return null;
}

function toConverseRequest(body, model) {
  const request = {};
  const system = (body.messages || [])
    .filter((message) => message.role === "system")
    .flatMap((message) => toConverseContent(message.content))
    .filter((block) => block.text != null);
  const requiredPrefix = AWS_QUICK.allowedSystemPrefix;
  if (requiredPrefix) {
    const firstText = system[0]?.text;
    if (typeof firstText !== "string" || !firstText.startsWith(requiredPrefix)) {
      system.unshift({ text: requiredPrefix });
    }
  }
  if (system.length) request.system = system;
  request.messages = toConverseMessages(body.messages);

  const effort = resolveThinkingEffort(body);
  const isClaude = !model || /claude/i.test(model);
  const thinkingActive = Boolean(effort) || (typeof model === "string" && ADAPTIVE_THINKING_RE.test(model));

  const inferenceConfig = {};
  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  if (maxTokens != null) inferenceConfig.maxTokens = maxTokens;
  if (body.temperature != null && (!thinkingActive || body.temperature === 1)) {
    inferenceConfig.temperature = body.temperature;
  }
  if (body.top_p != null && !thinkingActive) inferenceConfig.topP = body.top_p;
  if (Array.isArray(body.stop) && body.stop.length) inferenceConfig.stopSequences = body.stop;
  if (Object.keys(inferenceConfig).length) request.inferenceConfig = inferenceConfig;

  if (effort && isClaude) {
    request.additionalModelRequestFields = {
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort },
    };
  }

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
  const body = data?.responseBody && typeof data.responseBody === "object" ? data.responseBody : data;
  const message = body?.output?.message || {};
  let text = "";
  let reasoning = "";
  const toolCalls = [];
  for (const block of message.content || []) {
    if (block?.text != null) text += block.text;
    if (block?.reasoningContent?.reasoningText?.text != null) {
      reasoning += block.reasoningContent.reasoningText.text;
    }
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
  const finishReason = body?.stopReason === "tool_use" ? "tool_calls" : "stop";
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
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: finishReason,
    }],
    usage: {
      prompt_tokens: body?.usage?.inputTokens || 0,
      completion_tokens: body?.usage?.outputTokens || 0,
      total_tokens: body?.usage?.totalTokens || (body?.usage?.inputTokens || 0) + (body?.usage?.outputTokens || 0),
    },
  };
}

const ERROR_EVENT_KEYS = new Set([
  "error",
  "serviceUnavailable",
  "internalServer",
  "modelStreamError",
  "throttling",
  "validation",
  "accessDenied",
  "modelTimeout",
  "modelNotReady",
  "resourceNotFound",
]);

function classifyProxyError(type, message, fallbackStatus = 502) {
  const combined = `${type || ""} ${message || ""}`;
  if (/usageLimit|BLOCKED_MONTHLY|BLOCKED_SESSION|throttl|too many requests|rate.?limit/i.test(combined)) {
    return 429;
  }
  if (/validation|Status Code: 400|invalid|malformed|context.{0,20}(?:length|window|limit|overflow)|too long|input tokens exceed/i.test(combined)) {
    return 400;
  }
  if (/AccessDenied|not supported|unauthorized|forbidden|disabled/i.test(combined)) {
    return 403;
  }
  if (/unavailable|overloaded|modelNotReady/i.test(combined)) {
    return 503;
  }
  if (/timeout/i.test(combined)) {
    return 504;
  }
  return fallbackStatus;
}

function buildUsageLimitError(usageSummary, payload = null) {
  const statusLabel = usageSummary?.entitlementStatus || "BLOCKED";
  const monthly = usageSummary?.monthlyUsage;
  const session = usageSummary?.sessionUsage;
  let resetsAtMs;
  if (
    typeof session?.resumeInMinutes === "number" &&
    session.resumeInMinutes > 0 &&
    (statusLabel === "BLOCKED_SESSION" || monthly?.availableUnits !== 0)
  ) {
    resetsAtMs = Date.now() + session.resumeInMinutes * 60_000;
  } else if (typeof monthly?.resetsAt === "number" && monthly.resetsAt > 0) {
    resetsAtMs = monthly.resetsAt > 1e12 ? monthly.resetsAt : monthly.resetsAt * 1000;
  }
  const details = [statusLabel];
  if (typeof monthly?.availableUnits === "number" && typeof monthly?.provisionedUnits === "number") {
    details.push(`${monthly.availableUnits}/${monthly.provisionedUnits} monthly units left`);
  }
  if (typeof session?.resumeInMinutes === "number" && session.resumeInMinutes > 0 && statusLabel === "BLOCKED_SESSION") {
    details.push(`resumes in ${session.resumeInMinutes}m`);
  } else if (resetsAtMs) {
    details.push(`resets at ${new Date(resetsAtMs).toISOString()}`);
  }
  const baseMessage = payload?.message || payload?.error || "AWS Quick usage limit exceeded";
  return {
    message: `${baseMessage} (${details.join(", ")})`,
    type: "usage_limit_exceeded",
    code: statusLabel,
    status: 429,
    ...(resetsAtMs ? { resetsAtMs } : {}),
  };
}

function normalizeProxyPayload(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  if (typeof parsed.eventType === "string") {
    const key = parsed.eventType.charAt(0).toLowerCase() + parsed.eventType.slice(1);
    const payload = typeof parsed.payload === "string"
      ? (() => { try { return JSON.parse(parsed.payload); } catch { return { message: parsed.payload }; } })()
      : (parsed.payload || {});
    const usageSummary = parsed.usageSummary || payload?.usageSummary;
    const isBlockedEntitlement = typeof usageSummary?.entitlementStatus === "string"
      && /^BLOCKED_/i.test(usageSummary.entitlementStatus);
    if (key === "usageLimitExceeded") {
      return { error: buildUsageLimitError(usageSummary, payload) };
    }
    const isContentEvent = Boolean(
      payload?.delta || payload?.start || payload?.stopReason || payload?.usage || payload?.role || payload?.contentBlockIndex != null,
    );
    if (isBlockedEntitlement && !isContentEvent) {
      return { error: buildUsageLimitError(usageSummary, payload) };
    }
    if (ERROR_EVENT_KEYS.has(key) || key.endsWith("Exception") || (!isContentEvent && (payload?.error || payload?.errorType))) {
      const message = payload?.error || payload?.message || payload?.Message || `AWS Quick stream error (${parsed.eventType})`;
      const type = payload?.errorType || parsed.eventType;
      return {
        error: {
          message,
          type,
          status: classifyProxyError(type, message),
        },
      };
    }
    return { [key]: payload };
  }
  return parsed?.event || parsed?.chunk || parsed;
}

function parseProxyEvent(line) {
  let text = line.trim();
  if (!text || text === "[DONE]") return null;
  if (text.startsWith("data:")) text = text.slice(5).trim();
  if (!text || text === "[DONE]") return null;
  try {
    return normalizeProxyPayload(JSON.parse(text));
  } catch {
    return null;
  }
}

function concatBytes(a, b) {
  if (!a || a.byteLength === 0) return b;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

export function resolveAwsQuickTenantUrl(credentials) {
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

export class AWSQuickExecutor extends BaseExecutor {
  constructor() {
    super("awsquick", PROVIDERS.awsquick || {});
  }

  resolveTenantUrl(credentials) {
    return resolveAwsQuickTenantUrl(credentials);
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
    const requestBody = toConverseRequest(body || {}, model);
    delete requestBody.modelId;
    return {
      modelId: model,
      ...(stream ? {} : { apiType: AWS_QUICK.apiType }),
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
      if (typeof data?.responseBody === "string") {
        const message = data.responseBody;
        const status = classifyProxyError("", message);
        return {
          ...result,
          response: new Response(JSON.stringify({ error: { message, type: "api_error" } }), {
            status,
            headers: { "Content-Type": "application/json" },
          }),
          responseFormat: FORMATS.OPENAI,
        };
      }
      const responseBody = data?.responseBody && typeof data.responseBody === "object" ? data.responseBody : null;
      if (!responseBody?.output && !data?.output) {
        const usageSummary = data?.usageSummary || responseBody?.usageSummary;
        if (typeof usageSummary?.entitlementStatus === "string" && /^BLOCKED_/i.test(usageSummary.entitlementStatus)) {
          const err = buildUsageLimitError(usageSummary, responseBody);
          return {
            ...result,
            response: new Response(JSON.stringify({ error: err }), {
              status: 429,
              headers: { "Content-Type": "application/json" },
            }),
            responseFormat: FORMATS.OPENAI,
          };
        }
        const errMessage = responseBody?.error || responseBody?.message || data?.error || data?.message;
        if (typeof errMessage === "string" && errMessage) {
          const errType = responseBody?.errorType || data?.errorType || "api_error";
          const status = classifyProxyError(errType, errMessage);
          return {
            ...result,
            response: new Response(JSON.stringify({ error: { message: errMessage, type: errType, status } }), {
              status,
              headers: { "Content-Type": "application/json" },
            }),
            responseFormat: FORMATS.OPENAI,
          };
        }
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
    const contentType = result.response.headers?.get?.("content-type") || "";
    let isEventStream = contentType.includes("vnd.amazon.eventstream");
    let binaryBuffer = new Uint8Array(0);
    let textBuffer = "";
    let cancelled = false;
    let finished = false;
    let errored = false;
    let pendingFinishReason = null;
    let pendingUsage = null;
    let activeController = null;
    let preStreamError = null;
    let streamAccepted = false;
    const bufferedSse = [];
    const toolCallIndices = new Map();
    const resolveToolIndex = (blockIndex) => {
      if (blockIndex == null) return 0;
      if (!toolCallIndices.has(blockIndex)) {
        toolCallIndices.set(blockIndex, toolCallIndices.size);
      }
      return toolCallIndices.get(blockIndex);
    };

    const emitSse = (sseText) => {
      if (activeController) {
        activeController.enqueue(encoder.encode(sseText));
      } else {
        bufferedSse.push(sseText);
      }
    };

    const emitError = (err) => {
      finished = true;
      errored = true;
      const normalized = {
        message: err.message || "AWS Quick stream error",
        type: err.type || "api_error",
        ...(err.code ? { code: err.code } : {}),
        status: err.status || classifyProxyError(err.type, err.message),
        ...(err.resetsAtMs ? { resetsAtMs: err.resetsAtMs } : {}),
      };
      if (activeController) {
        activeController.enqueue(encoder.encode(sseChunk({ error: normalized })));
      } else {
        preStreamError = normalized;
      }
    };

    const flushTerminal = () => {
      if (errored || (!pendingFinishReason && !pendingUsage)) return;
      const chunk = {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: pendingFinishReason }],
        ...(pendingUsage ? { usage: pendingUsage } : {}),
      };
      pendingFinishReason = null;
      pendingUsage = null;
      emitSse(sseChunk(chunk));
    };

    const emitEvent = (event) => {
      if (!event || finished) return;
      if (event.error) {
        emitError(event.error);
        return;
      }
      if (event.messageStart) {
        streamAccepted = true;
        return;
      }
      if (event.contentBlockStart || event.contentBlockDelta || event.contentBlockStop) {
        streamAccepted = true;
      }
      if (event.messageStop) {
        streamAccepted = true;
        pendingFinishReason = event.messageStop.stopReason === "tool_use" ? "tool_calls" : "stop";
        if (pendingUsage) flushTerminal();
        return;
      }
      if (event.metadata?.usage) {
        streamAccepted = true;
        const usage = event.metadata.usage;
        const cachedTokens = usage.cacheReadInputTokens || 0;
        pendingUsage = {
          prompt_tokens: usage.inputTokens || 0,
          completion_tokens: usage.outputTokens || 0,
          total_tokens: usage.totalTokens || (usage.inputTokens || 0) + (usage.outputTokens || 0),
          ...(cachedTokens > 0 ? { prompt_tokens_details: { cached_tokens: cachedTokens } } : {}),
        };
        if (pendingFinishReason) flushTerminal();
        return;
      }
      const chunk = proxyEventToOpenAIChunk(event, id, created, model, resolveToolIndex);
      if (chunk) {
        streamAccepted = true;
        emitSse(sseChunk(chunk));
      }
    };

    const drainBinaryFrames = () => {
      while (binaryBuffer.byteLength >= 12 && !finished) {
        const view = new DataView(binaryBuffer.buffer, binaryBuffer.byteOffset, binaryBuffer.byteLength);
        if (view.getUint32(8, false) !== crc32(binaryBuffer.subarray(0, 8))) {
          emitError({ message: "AWS Quick EventStream prelude CRC mismatch", type: "api_error", status: 502 });
          return;
        }
        const totalLength = view.getUint32(0, false);
        const headersLength = view.getUint32(4, false);
        if (
          totalLength < 16 ||
          totalLength > AWS_EVENTSTREAM.maxMessageBytes ||
          headersLength > AWS_EVENTSTREAM.maxHeadersBytes ||
          headersLength > totalLength - 16
        ) {
          emitError({ message: "AWS Quick EventStream frame bounds are invalid", type: "api_error", status: 502 });
          return;
        }
        if (binaryBuffer.byteLength < totalLength) break;
        const frame = binaryBuffer.slice(0, totalLength);
        binaryBuffer = binaryBuffer.slice(totalLength);
        let decoded;
        try {
          decoded = parseEventFrame(frame);
        } catch (err) {
          emitError({ message: err.message, type: "api_error", status: 502 });
          return;
        }
        const messageType = decoded.headers[":message-type"];
        if (messageType === "exception" || messageType === "error") {
          const message =
            decoded.payload?.error ||
            decoded.payload?.message ||
            decoded.payload?.Message ||
            decoded.headers[":error-message"] ||
            `AWS Quick EventStream ${messageType}`;
          const type = decoded.payload?.errorType || decoded.headers[":exception-type"] || decoded.headers[":error-code"] || "api_error";
          emitError({ message, type, status: classifyProxyError(type, message) });
          return;
        }
        emitEvent(normalizeProxyPayload(decoded.payload));
      }
    };

    const processBytes = (value) => {
      if (!isEventStream && binaryBuffer.byteLength === 0 && textBuffer.length === 0 && value.byteLength >= 12) {
        const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
        if (view.getUint32(8, false) === crc32(value.subarray(0, 8))) {
          isEventStream = true;
        }
      }
      if (isEventStream) {
        binaryBuffer = concatBytes(binaryBuffer, value);
        drainBinaryFrames();
        return;
      }
      textBuffer += decoder.decode(value, { stream: true });
      const lines = textBuffer.split("\n");
      textBuffer = lines.pop() || "";
      for (const line of lines) {
        emitEvent(parseProxyEvent(line));
        if (finished) return;
      }
    };

    try {
      while (!streamAccepted && !preStreamError && !finished) {
        const { done, value } = await reader.read();
        if (done) {
          if (!isEventStream && textBuffer.trim()) {
            emitEvent(parseProxyEvent(textBuffer));
          }
          flushTerminal();
          finished = true;
          break;
        }
        processBytes(value);
      }
    } catch (err) {
      await reader.cancel(err).catch(() => {});
      throw err;
    }

    if (preStreamError) {
      await reader.cancel().catch(() => {});
      return {
        ...result,
        response: new Response(JSON.stringify({ error: preStreamError }), {
          status: preStreamError.status || 502,
          headers: { "Content-Type": "application/json" },
        }),
        responseFormat: FORMATS.OPENAI,
      };
    }

    if (finished && bufferedSse.length === 0) {
      await reader.cancel().catch(() => {});
      return {
        ...result,
        response: new Response(JSON.stringify({
          error: { message: "AWS Quick returned an empty stream", type: "api_error", status: 502 },
        }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        }),
        responseFormat: FORMATS.OPENAI,
      };
    }

    const responseStream = new ReadableStream({
      async pull(controller) {
        activeController = controller;
        if (bufferedSse.length > 0) {
          while (bufferedSse.length > 0) {
            controller.enqueue(encoder.encode(bufferedSse.shift()));
          }
          if (finished) {
            flushTerminal();
            controller.enqueue(encoder.encode(SSE_DONE));
            controller.close();
          }
          return;
        }
        if (finished) {
          flushTerminal();
          controller.enqueue(encoder.encode(SSE_DONE));
          controller.close();
          return;
        }
        while (!cancelled && !finished) {
          const { done, value } = await reader.read();
          if (done) {
            if (!isEventStream && textBuffer.trim()) {
              emitEvent(parseProxyEvent(textBuffer));
            }
            flushTerminal();
            finished = true;
            controller.enqueue(encoder.encode(SSE_DONE));
            controller.close();
            return;
          }
          processBytes(value);
          if (finished) {
            flushTerminal();
            controller.enqueue(encoder.encode(SSE_DONE));
            controller.close();
            return;
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
      const errObj = parsed?.error && typeof parsed.error === "object" ? parsed.error : parsed;
      const message =
        (typeof parsed?.error === "string" ? parsed.error : null)
        || errObj?.message
        || parsed?.message;
      const resetsAtMs = typeof errObj?.resetsAtMs === "number" ? errObj.resetsAtMs : undefined;
      const status = typeof errObj?.status === "number" ? errObj.status : response.status;
      if (typeof message === "string" && message) {
        return { status, message, ...(resetsAtMs ? { resetsAtMs } : {}) };
      }
    } catch {}
    return super.parseError(response, bodyText);
  }
}

function proxyEventToOpenAIChunk(event, id, created, model, resolveToolIndex = (i) => i || 0) {
  const base = { id, object: "chat.completion.chunk", created, model };
  const deltaEvent = event.contentBlockDelta?.delta || event.delta;
  if (deltaEvent?.text != null) {
    return { ...base, choices: [{ index: 0, delta: { content: deltaEvent.text }, finish_reason: null }] };
  }
  if (deltaEvent?.reasoningContent?.text != null) {
    return { ...base, choices: [{ index: 0, delta: { reasoning_content: deltaEvent.reasoningContent.text }, finish_reason: null }] };
  }
  if (deltaEvent?.toolUse) {
    const tool = deltaEvent.toolUse;
    const toolIndex = resolveToolIndex(event.contentBlockDelta?.contentBlockIndex ?? tool.index ?? 0);
    return {
      ...base,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: toolIndex,
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
            index: resolveToolIndex(event.contentBlockStart.contentBlockIndex ?? 0),
            id: tool.toolUseId,
            type: "function",
            function: { name: tool.name, arguments: "" },
          }],
        },
        finish_reason: null,
      }],
    };
  }
  return null;
}

export function buildAWSQuickRequestBody(model, body, stream = false) {
  const requestBody = toConverseRequest(body || {}, model);
  delete requestBody.modelId;
  return { modelId: model, ...(stream ? {} : { apiType: AWS_QUICK.apiType }), requestBody };
}

export function parseAWSQuickResponse(data, model) {
  return converseResponseToOpenAI(data, model);
}

export default AWSQuickExecutor;
