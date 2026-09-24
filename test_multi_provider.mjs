#!/usr/bin/env node
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const here = path.dirname(new URL(import.meta.url).pathname);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-multi-provider-test-'));
const readyFile = path.join(temp, 'ready.json');
const configFile = path.join(temp, 'config.json');
const requests = [];
fs.writeFileSync(configFile, JSON.stringify({ models: [
  { id: 'or-free', provider: 'openrouter', base_url: 'http://unused/v1', key_env: 'OPENROUTER_API_KEY' },
  { id: 'gemini-free', provider: 'gemini', base_url: 'http://unused/v1', key_env: 'GEMINI_API_KEY' },
] }));

const upstream = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  requests.push({ model: payload.model, messages: payload.messages, authorization: request.headers.authorization });
  if (payload.model === 'or-free') {
    response.writeHead(429, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 429, message: 'account free quota exhausted' } }));
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ model: payload.model, choices: [{ message: { content: 'answered by second provider' } }] }));
});
const port = await new Promise((resolve) => upstream.listen(0, '127.0.0.1', () => resolve(upstream.address().port)));
const proxy = spawn('node', [path.join(here, 'openrouter_free_proxy.mjs'), '--config', configFile, '--ready-file', readyFile, '--port', '0', '--upstream', `http://127.0.0.1:${port}/v1`], {
  env: { ...process.env, OPENROUTER_API_KEY: 'or-secret', GEMINI_API_KEY: 'gemini-secret' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
proxy.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
try {
  for (let i = 0; i < 100 && !fs.existsSync(readyFile); i += 1) await new Promise((r) => setTimeout(r, 20));
  const ready = JSON.parse(fs.readFileSync(readyFile, 'utf8'));
  const messages = [{ role: 'system', content: 'keep context' }, { role: 'user', content: 'continue this task' }];
  const response = await fetch(`http://127.0.0.1:${ready.port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer local-placeholder' },
    body: JSON.stringify({ model: 'ignored', messages }),
  });
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(await response.text()).model, 'gemini-free');
  assert.deepEqual(requests.map((item) => item.model), ['or-free', 'gemini-free']);
  assert.deepEqual(requests[0].messages, messages);
  assert.deepEqual(requests[1].messages, messages);
  assert.equal(requests[0].authorization, 'Bearer or-secret');
  assert.equal(requests[1].authorization, 'Bearer gemini-secret');
  assert.doesNotMatch(stderr, /or-secret|gemini-secret/);
  console.log('Multi-provider test passed: same messages survived an OpenRouter-to-Gemini failover without leaking keys.');
} finally {
  proxy.kill('SIGTERM');
  await new Promise((resolve) => upstream.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
}
