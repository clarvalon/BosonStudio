import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { request } from '../lib/connections.mjs';

test('ComfyUI validation errors retain node details while redacting credentials', async t => {
  const server = http.createServer((req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Prompt outputs failed validation' }, node_errors: { 1: { class_type: 'UNETLoader', errors: [{ message: 'Value not in list', details: 'Missing model: test-private-token.safetensors' }] } } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  await assert.rejects(request(`http://127.0.0.1:${server.address().port}`, 'prompt', { token: 'test-private-token' }), error => {
    assert.match(error.message, /Node 1 \(UNETLoader\): Value not in list/);
    assert.match(error.message, /Missing model: \[redacted\].safetensors/);
    assert.ok(!error.message.includes('test-private-token'));
    return true;
  });
});
