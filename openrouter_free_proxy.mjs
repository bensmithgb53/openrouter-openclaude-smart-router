#!/usr/bin/env node
/**
 * Loopback-only OpenAI-compatible proxy for OpenClaude + OpenRouter free models.
 *
 * It replaces the requested model with one candidate from a generated free-only
 * chain. Each failed request advances to the next model while the client keeps
 * the same conversation transcript. By default streaming replies are buffered
 * before they reach the client; this lets the proxy safely retry an OpenRouter
 * SSE error that occurs after HTTP 200 but before a completed response.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_UPSTREAM = 'https://openrouter.ai/api/v1';
const MAX_REQUEST_BYTES = 20 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 600_000;

function usage() {
  console.error(
    'Usage: openrouter_free_proxy.mjs --config FILE --ready-file FILE [--port 0] [--buffer-streams 0|1] [--upstream URL]',
  );
}

function parseArgs(argv) {
  const options = { port: 0, bufferStreams: true, upstream: DEFAULT_UPSTREAM };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--config') options.config = argv[++index];
    else if (arg === '--ready-file') options.readyFile = argv[++index];
    else if (arg === '--port') options.port = Number(argv[++index]);
    else if (arg === '--buffer-streams') options.bufferStreams = argv[++index] !== '0';
    else if (arg === '--upstream') options.upstream = argv[++index];
    else if (arg === '--help' || arg === '-h') return { help: true };
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.config || !options.readyFile || !Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error('Missing --config/--ready-file or invalid --port.');
  }
  return options;
}

function readConfig(configPath) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!Array.isArray(config.models) || config.models.length < 2) {
    throw new Error('Proxy configuration must contain at least two model candidates.');
  }
  const ids = config.models.map((model) => model?.id).filter(Boolean);
  if (ids.length !== config.models.length || new Set(ids).size !== ids.length) {
    throw new Error('Proxy model candidates must have unique non-empty ids.');
  }
  return { ...config, models: config.models.map((model) => ({ ...model, id: String(model.id) })) };
}

function timestamp() {
  return new Date().toISOString();
}

function log(event, fields = {}) {
  const safe = Object.fromEntries(
    Object.entries(fields).filter(([key]) => !/authorization|key|token|secret/i.test(key)),
  );
  console.error(JSON.stringify({ time: timestamp(), event, ...safe }));
}

function lowerHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    result[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return result;
}

function outboundHeaders(incomingHeaders, apiKey) {
  const blocked = new Set([
    'host', 'connection', 'content-length', 'transfer-encoding', 'authorization', 'accept-encoding',
  ]);
  const headers = {};
  for (const [name, value] of Object.entries(lowerHeaders(incomingHeaders))) {
    if (!blocked.has(name)) headers[name] = value;
  }
  headers.authorization = `Bearer ${apiKey}`;
  headers['content-type'] = 'application/json';
  return headers;
}

function readBody(request, limit = MAX_REQUEST_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        request.destroy();
        reject(Object.assign(new Error(`Request exceeds ${limit} bytes.`), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

async function readResponse(response, limit = MAX_RESPONSE_BYTES) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw Object.assign(new Error(`Upstream response exceeds ${limit} bytes.`), { statusCode: 502 });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function parseErrorBody(body) {
  const text = body.toString('utf8');
  try {
    const parsed = JSON.parse(text);
    const error = parsed?.error ?? parsed;
    return {
      code: Number(error?.code) || undefined,
      message: String(error?.message || text.slice(0, 500)),
      metadata: error?.metadata || {},
    };
  } catch {
    return { message: text.slice(0, 500), metadata: {} };
  }
}

function parseSseFailure(body) {
  const text = body.toString('utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.startsWith('data:')) continue;
    const rawData = rawLine.slice(5).trim();
    if (!rawData || rawData === '[DONE]') continue;
    try {
      const chunk = JSON.parse(rawData);
      const choiceError = (chunk.choices || []).some((choice) => choice?.finish_reason === 'error');
      if (chunk.error || choiceError) {
        const error = chunk.error || {};
        return {
          code: Number(error.code) || 502,
          message: String(error.message || 'OpenRouter sent an SSE error event.'),
          metadata: error.metadata || {},
        };
      }
    } catch {
      // The original stream is still valid for the client if no other failure is found.
    }
  }
  return null;
}

function retryable(error, headers) {
  const status = Number(error?.code) || 0;
  const message = String(error?.message || '').toLowerCase();
  const normalized = lowerHeaders(headers || {});
  const platformLimitExhausted =
    status === 429 &&
    normalized['x-ratelimit-limit'] !== undefined &&
    normalized['x-ratelimit-remaining'] === '0';

  if (platformLimitExhausted) return { retry: false, reason: 'platform_rate_limit_exhausted' };
  if ([408, 404, 429, 500, 502, 503, 504, 524, 529].includes(status)) return { retry: true, reason: `http_${status}` };
  if (status === 403 && /moderation|content.?filter|safety|refus/.test(message)) return { retry: true, reason: 'moderation_or_refusal' };
  if (status === 400 && /context|token|maximum|too long|unsupported.*(parameter|model)|model.*unsupported/.test(message)) {
    return { retry: true, reason: 'model_specific_validation' };
  }
  return { retry: false, reason: `non_retryable_http_${status || 'unknown'}` };
}

function responseHeaders(upstreamHeaders) {
  const permitted = new Set([
    'content-type', 'cache-control', 'x-request-id', 'x-ratelimit-limit', 'x-ratelimit-remaining',
    'x-ratelimit-reset', 'retry-after', 'openrouter-version',
  ]);
  const result = {};
  for (const [name, value] of upstreamHeaders.entries()) {
    if (permitted.has(name.toLowerCase())) result[name] = value;
  }
  return result;
}

function sendBuffer(response, status, headers, body) {
  if (response.writableEnded) return;
  response.writeHead(status, headers);
  response.end(body);
}

function sendJson(response, status, body) {
  sendBuffer(response, status, { 'content-type': 'application/json; charset=utf-8' }, Buffer.from(JSON.stringify(body)));
}

function upstreamUrl(upstream, requestUrl) {
 const incoming = new URL(requestUrl, 'http://127.0.0.1');
 let pathname = incoming.pathname;
 if (pathname === '/v1') pathname = '/';
 else if (pathname.startsWith('/v1/')) pathname = pathname.slice(3);
  const base = new URL(upstream.endsWith('/') ? upstream : `${upstream}/`);
  const target = new URL(pathname.replace(/^\//, ''), base);
  target.search = incoming.search;
  return target;
}

async function sendAttempt({ requestJson, candidate, fallbackModels, requestHeaders, apiKey, target, requestMethod }) {
 const payload = { ...requestJson, model: candidate.id };
  // Native OpenRouter fallbacks recover ordinary request failures without an
  // extra round trip. The proxy still keeps the complete order so it can catch
  // an SSE error that arrives after OpenRouter has already returned HTTP 200.
  // OpenRouter accepts at most three entries in its native `models` array.
  // The local loop still supports the complete generated chain and advances
  // beyond this three-model window if the upstream request fails.
  if (fallbackModels.length > 0) payload.models = fallbackModels.slice(0, 3);
  else delete payload.models;
 const controller = new AbortController();
 const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const upstreamResponse = await fetch(target, {
      method: requestMethod,
      headers: outboundHeaders(requestHeaders, apiKey),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await readResponse(upstreamResponse);
    return { upstreamResponse, body, candidate };
  } finally {
    clearTimeout(timer);
  }
}

async function handleChatCompletion({ request, response, config, apiKey, target, bufferStreams }) {
  let rawBody;
  try {
    rawBody = await readBody(request);
  } catch (error) {
    sendJson(response, error.statusCode || 400, { error: { message: error.message } });
    return;
  }

  let requestJson;
  try {
    requestJson = JSON.parse(rawBody.toString('utf8'));
    if (!requestJson || Array.isArray(requestJson) || typeof requestJson !== 'object') throw new Error('Body must be a JSON object.');
  } catch (error) {
    sendJson(response, 400, { error: { message: `Invalid JSON request: ${error.message}` } });
    return;
  }

  const isStreaming = requestJson.stream === true;
  let lastResult;
  for (let index = 0; index < config.models.length; index += 1) {
    const candidate = config.models[index];
    let result;
    try {
      result = await sendAttempt({
       requestJson,
       candidate,
        fallbackModels: config.models.slice(index + 1).map((model) => model.id),
       requestHeaders: request.headers,
       apiKey,
       target,
        requestMethod: request.method,
      });
    } catch (error) {
      const syntheticError = { code: 502, message: error.name === 'AbortError' ? 'Upstream request timed out.' : error.message };
      const decision = retryable(syntheticError, {});
      log('attempt_transport_error', { model: candidate.id, attempt: index + 1, reason: decision.reason });
      if (index + 1 < config.models.length && decision.retry) continue;
      sendJson(response, 502, { error: syntheticError });
      return;
    }

    lastResult = result;
    const failure = !result.upstreamResponse.ok
      ? parseErrorBody(result.body)
      : (isStreaming && bufferStreams ? parseSseFailure(result.body) : null);

    if (!failure) {
      const headers = responseHeaders(result.upstreamResponse.headers);
      if (isStreaming && bufferStreams) headers['x-smart-router-buffered'] = 'true';
      log('attempt_succeeded', { model: candidate.id, attempt: index + 1, buffered_stream: isStreaming && bufferStreams });
      sendBuffer(response, result.upstreamResponse.status, headers, result.body);
      return;
    }

    const decision = retryable(failure, result.upstreamResponse.headers);
    log('attempt_failed', {
      model: candidate.id,
      attempt: index + 1,
      status: failure.code || result.upstreamResponse.status,
      reason: decision.reason,
    });
    if (index + 1 < config.models.length && decision.retry) continue;

    const headers = responseHeaders(result.upstreamResponse.headers);
    sendBuffer(response, result.upstreamResponse.status, headers, result.body);
    return;
  }

  // Defensive fallback; the loop always returns but keeps an intelligible error
  // if configuration changes in the future.
  if (lastResult) {
    sendBuffer(response, lastResult.upstreamResponse.status, responseHeaders(lastResult.upstreamResponse.headers), lastResult.body);
  } else {
    sendJson(response, 502, { error: { message: 'No model attempt was made.' } });
  }
}

async function handlePassthrough({ request, response, apiKey, target }) {
  let body = Buffer.alloc(0);
  try {
    if (!['GET', 'HEAD'].includes(request.method)) body = await readBody(request);
    const headers = outboundHeaders(request.headers, apiKey);
    if (body.length === 0 && ['GET', 'HEAD'].includes(request.method)) delete headers['content-type'];
    const upstreamResponse = await fetch(target, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : body,
    });
    const responseBody = await readResponse(upstreamResponse);
    sendBuffer(response, upstreamResponse.status, responseHeaders(upstreamResponse.headers), responseBody);
  } catch (error) {
    sendJson(response, error.statusCode || 502, { error: { message: error.message } });
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    usage();
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    usage();
    return;
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error('OPENROUTER_API_KEY is required by the local proxy.');
    process.exitCode = 2;
    return;
  }

  let config;
  try {
    config = readConfig(options.config);
  } catch (error) {
    console.error(`Invalid proxy configuration: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  const server = http.createServer(async (request, response) => {
    const target = upstreamUrl(options.upstream, request.url || '/');
    const localPath = new URL(request.url || '/', 'http://127.0.0.1').pathname;
    if (request.method === 'GET' && localPath === '/health') {
      sendJson(response, 200, { status: 'ok', models: config.models.map((model) => model.id) });
      return;
    }
    if (request.method === 'POST' && /\/chat\/completions$/.test(localPath)) {
      await handleChatCompletion({
        request,
        response,
        config,
        apiKey,
        target,
        bufferStreams: options.bufferStreams,
      });
      return;
    }
    await handlePassthrough({ request, response, apiKey, target });
  });

  server.on('clientError', (error, socket) => {
    log('client_error', { message: error.message });
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  server.listen({ host: '127.0.0.1', port: options.port }, () => {
    const address = server.address();
    const ready = {
      host: '127.0.0.1',
      port: typeof address === 'object' && address ? address.port : options.port,
      pid: process.pid,
      models: config.models.map((model) => model.id),
      buffer_streams: options.bufferStreams,
    };
    fs.mkdirSync(path.dirname(options.readyFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(options.readyFile, `${JSON.stringify(ready)}\n`, { mode: 0o600 });
    log('proxy_ready', { port: ready.port, model_count: ready.models.length, buffer_streams: options.bufferStreams });
  });

  const stop = () => {
    try { fs.rmSync(options.readyFile, { force: true }); } catch { /* no-op */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
