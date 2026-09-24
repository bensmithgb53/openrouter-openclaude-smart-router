#!/usr/bin/env node
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const here = path.dirname(new URL(import.meta.url).pathname);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-free-router-test-'));
const upstreamReady = path.join(temp, 'upstream-ready.json');
const proxyReady = path.join(temp, 'proxy-ready.json');
const configPath = path.join(temp, 'chain.json');
const requests = [];

fs.writeFileSync(configPath, JSON.stringify({
  models: [{ id: 'vendor/first:free' }, { id: 'vendor/second:free' }],
}));

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function stop(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 1000).unref();
  });
}

async function waitFor(file, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(file) && fs.statSync(file).size > 0) return JSON.parse(fs.readFileSync(file, 'utf8'));
    if (child.exitCode !== null) throw new Error(`Process exited before readiness: ${child.exitCode}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${file}`);
}

async function post(port, body) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer local-placeholder' },
    body: JSON.stringify(body),
  });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

const upstream = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  requests.push({ model: payload.model, fallbacks: payload.models, authorization: request.headers.authorization, stream: payload.stream });

  if (payload.model === 'vendor/first:free') {
    if (payload.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\ndata: {"error":{"code":503,"message":"first model overloaded"},"choices":[{"delta":{},"finish_reason":"error"}]}\n\ndata: [DONE]\n\n');
      return;
    }
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 503, message: 'first model overloaded' } }));
    return;
  }

  response.writeHead(200, { 'content-type': payload.stream ? 'text/event-stream' : 'application/json' });
  if (payload.stream) {
    response.end('data: {"model":"vendor/second:free","choices":[{"delta":{"content":"recovered"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  } else {
    response.end(JSON.stringify({ model: 'vendor/second:free', choices: [{ message: { content: 'recovered' } }] }));
  }
});

let proxy;
try {
  const upstreamPort = await listen(upstream);
  fs.writeFileSync(upstreamReady, JSON.stringify({ upstreamPort }));
  proxy = spawn('node', [path.join(here, 'openrouter_free_proxy.mjs'), '--config', configPath, '--ready-file', proxyReady, '--port', '0', '--upstream', `http://127.0.0.1:${upstreamPort}/v1`], {
    env: { ...process.env, OPENROUTER_API_KEY: 'test-secret-never-log' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let proxyStderr = '';
  proxy.stderr.on('data', (chunk) => { proxyStderr += chunk.toString('utf8'); });
  const ready = await waitFor(proxyReady, proxy);

  const nonStreaming = await post(ready.port, { model: 'ignored', messages: [{ role: 'user', content: 'test' }] });
  assert.equal(nonStreaming.status, 200);
  assert.equal(JSON.parse(nonStreaming.text).model, 'vendor/second:free');

  const streaming = await post(ready.port, { model: 'ignored', stream: true, messages: [{ role: 'user', content: 'test stream' }] });
  assert.equal(streaming.status, 200);
  assert.equal(streaming.headers.get('x-smart-router-buffered'), 'true');
  assert.match(streaming.text, /vendor\/second:free/);
  assert.doesNotMatch(streaming.text, /partial/);

  assert.deepEqual(requests.map((entry) => entry.model), [
    'vendor/first:free', 'vendor/second:free', 'vendor/first:free', 'vendor/second:free',
  ]);
  assert.deepEqual(requests.map((entry) => entry.fallbacks), [
    ['vendor/second:free'], undefined, ['vendor/second:free'], undefined,
  ]);
  assert.ok(requests.every((entry) => entry.authorization === 'Bearer test-secret-never-log'));
  assert.doesNotMatch(proxyStderr, /test-secret-never-log/);
  console.log('Proxy integration test passed: HTTP and late-SSE failures advance to the second model without leaking the API key.');
} finally {
  await stop(proxy);
  await new Promise((resolve) => upstream.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
}
