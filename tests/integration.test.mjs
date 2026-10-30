import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from '../server.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDFsAAAAASUVORK5CYII=', 'base64');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
const options = (body, method = 'POST') => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const waitUntil = async condition => { for (let i = 0; i < 120; i++) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 25)); } assert.fail('Timed out waiting for the assistant or job'); };

test('standalone chat, authenticated tool execution, gallery retrieval, byte ranges and persistence', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'boson-test-'));
  let graph; let promptId; let toolCalls = 0; let gotBearer = 0;
  const nodeNames = ['UNETLoader', 'CLIPLoader', 'VAELoader', 'MiniMaxH3ImageToVideo', 'MiniMaxH3SigmaShift', 'BasicGuider', 'RandomNoise', 'BasicScheduler', 'KSamplerSelect', 'SamplerCustomAdvanced', 'VAEDecode', 'VAEDecodeAudio', 'SaveImage', 'CreateVideo', 'SaveVideo', 'ImageFromBatch', 'MiniMaxH3ReferenceToVideo', 'LoadImage','LoadVideo','GetVideoComponents','LoadAudio','MiniMaxH3AddGuide','SaveAudio'];
  const info = Object.fromEntries(nodeNames.map(name => [name, {}]));
  info.UNETLoader = { input: { required: { unet_name: [['minimax_h3_fl2va.safetensors', 'minimax_h3_ref2va.safetensors']], weight_dtype: [['default']] } } };
  info.CLIPLoader = { input: { required: { clip_name: [['minimax_h3_qwen.safetensors']], type: [['minimax']] }, optional: { device: [['default', 'cpu']] } } };
  info.VAELoader = { input: { required: { vae_name: [['minimax_h3_video_vae.safetensors', 'minimax_h3_audio_vae.safetensors']] } } };
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (req.headers.authorization === 'Bearer comfy-test-secret') gotBearer++;
    const send = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    if (req.url === '/system_stats') return send({ devices: [{ name: 'Mock GPU' }] });
    if (req.url === '/object_info') return send(info);
    if (req.url === '/v1/models') return send({ data: [{ id: 'test-llm' }] });
    if (req.url === '/v1/chat/completions') {
      assert.equal(req.headers.authorization, 'Bearer llm-test-secret');
      if (body.messages.at(-1).role === 'tool') return send({ choices: [{ message: { role: 'assistant', content: 'Your image is queued.' } }] });
      toolCalls++;
      return send({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-one', type: 'function', function: { name: 'create_media', arguments: JSON.stringify({ mode: 'text_to_image', title: 'Morning garden', prompt: 'A cinematic garden in early morning light.', asset_ids: [], aspect_ratio: 'square', duration: 5 }) } }] } }] });
    }
    if (req.url === '/prompt') { graph = body.prompt; promptId = 'mock-prompt'; return send({ prompt_id: promptId }); }
    if (req.url.startsWith('/history/')) return send(promptId ? { [promptId]: { status: { completed: true, status_str: 'success' }, outputs: { out: { images: [{ filename: 'test.png', type: 'output', subfolder: '' }] } } } } : {});
    if (req.url.startsWith('/view?')) { res.setHeader('Content-Type', 'image/png'); return res.end(PNG); }
    if (req.url === '/queue') return send({ queue_pending: [], queue_running: [] });
    res.writeHead(404); res.end('{}');
  });
  const upstreamUrl = await listen(upstream);
  const app = await createStudio({ directory }); const appUrl = await listen(app.server);
  t.after(async () => { await close(app.server); await close(upstream); await app.store.pending; await rm(directory, { recursive: true, force: true }); });
  const getState = async () => (await fetch(`${appUrl}/api/state`)).json();
  const initial = await getState(); assert.equal(initial.assets.length, 0);
  const config = { comfy: { url: upstreamUrl, token: 'comfy-test-secret' }, llm: { url: `${upstreamUrl}/v1`, model: 'test-llm', key: 'llm-test-secret' }, models: { videoModel: 'minimax_h3_fl2va.safetensors', referenceModel: 'minimax_h3_ref2va.safetensors', textEncoder: 'minimax_h3_qwen.safetensors', videoVae: 'minimax_h3_video_vae.safetensors', audioVae: 'minimax_h3_audio_vae.safetensors' } };
  const save = await fetch(`${appUrl}/api/settings`, options(config, 'PUT')); assert.equal(save.status, 200);
  const publicConfig = await save.json(); assert.equal(publicConfig.llm.hasKey, true); assert.equal(publicConfig.llm.key, undefined);
  const testComfy = await (await fetch(`${appUrl}/api/test/comfy`, options({}))).json(); assert.equal(testComfy.missingNodes.length, 0); assert.equal(testComfy.suggested.videoModel, config.models.videoModel);
  const chat = await fetch(`${appUrl}/api/chat`, options({ message: 'Create an image of a garden.', assetIds: [] })); assert.equal(chat.status, 202);
  await waitUntil(async () => { const data = await getState(); return !data.busy && data.jobs[0]?.promptId; });
  await app.pollJobs();
  const completed = await getState();
  assert.equal(toolCalls, 1); assert.equal(completed.jobs[0].status, 'completed');
  assert.equal(completed.assets.length, 1); assert.equal(completed.assets[0].name, 'Morning garden');
  assert.ok(graph && Object.values(graph).some(node => node.class_type === 'SaveImage'));
  assert.ok(gotBearer >= 4); assert.ok(!JSON.stringify(completed).includes('test-secret'));
  assert.ok(!JSON.stringify(completed).includes('connection":'));
  const mediaUrl = `${appUrl}/media/${completed.assets[0].id}`;
  assert.deepEqual(Buffer.from(await (await fetch(mediaUrl)).arrayBuffer()), PNG);
  const partial = await fetch(mediaUrl, { headers: { Range: 'bytes=0-7' } }); assert.equal(partial.status, 206); assert.equal((await partial.arrayBuffer()).byteLength, 8);
  const badRange = await fetch(mediaUrl, { headers: { Range: 'bytes=999999-' } }); assert.equal(badRange.status, 416);
  const forbidden = await fetch(`${appUrl}/api/chat`, { ...options({ message: 'test' }), headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example' } }); assert.equal(forbidden.status, 403);
  const upload = await fetch(`${appUrl}/api/assets`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent('reference.png') }, body: PNG }); assert.equal(upload.status, 201);
  const unsafeUpload = await fetch(`${appUrl}/api/assets`, { method: 'POST', headers: { 'X-File-Name': 'script.html' }, body: '<script></script>' }); assert.equal(unsafeUpload.status, 400);
  const stored = JSON.parse(await readFile(path.join(directory, 'studio.json'), 'utf8'));
  assert.equal(stored.assets.length, 2); assert.equal(stored.config.comfy.token, 'comfy-test-secret');
  assert.equal((await fetch(`${appUrl}/`)).status, 200);
  const uploadedId = (await upload.json()).id;
  const generatedId = completed.assets[0].id;
  for (const id of [uploadedId, generatedId]) {
    assert.equal((await fetch(`${appUrl}/api/assets/${id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await fetch(`${appUrl}/media/${id}`)).status, 404);
  }
  assert.equal((await getState()).assets.length, 0);
  const restore = await fetch(`${appUrl}/api/trash/restore`, options({ kind: 'asset', id: generatedId }));
  assert.equal(restore.status, 200);
  assert.deepEqual(Buffer.from(await (await fetch(mediaUrl)).arrayBuffer()), PNG);
  app.store.data.jobs.push({ id: 'failed-job', status: 'failed', mode: 'text_to_image', error: 'Recorded failure' });
  app.store.data.jobs.push({ id: 'active-job', status: 'queued', mode: 'text_to_image' });
  await app.store.save();
  assert.equal((await fetch(`${appUrl}/api/jobs/failed-job`, { method: 'DELETE' })).status, 200);
  assert.ok(!(await getState()).jobs.some(job => job.id === 'failed-job'));
  assert.equal((await fetch(`${appUrl}/api/jobs/active-job`, { method: 'DELETE' })).status, 400);
  assert.equal((await fetch(`${appUrl}/api/trash/restore`, options({ kind: 'job', id: 'failed-job' }))).status, 200);
  assert.ok((await getState()).jobs.some(job => job.id === 'failed-job'));
});
