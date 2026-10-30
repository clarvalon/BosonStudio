import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, stat, mkdir, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { Store } from './lib/store.mjs';
import { endpoint, request, jsonRequest, postJSON, inspectComfy, uploadComfy } from './lib/connections.mjs';
import { validateGeneration, buildWorkflow, fitSourceDimensions } from './lib/workflows.mjs';
import { runAssistant } from './lib/assistant.mjs';
import { imageDimensions } from './lib/vision.mjs';
import { removeEntry, restoreEntry } from './lib/gallery.mjs';
import { probeMedia, prepareVideoSource, addSoundtrack, appendContinuation, mediaToolVersions } from './lib/media.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4' };
const MEDIA_EXTENSIONS = Object.keys(TYPES).filter(ext => /^(image|video|audio)\//.test(TYPES[ext]) && ext !== '.svg');
const MAX_UPLOAD = 128 * 1024 * 1024;

async function readBody(req, max = 2 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw Object.assign(new Error(`Request exceeds ${Math.round(max / 1024 / 1024)} MB.`), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
const bodyJSON = async req => JSON.parse((await readBody(req)).toString('utf8') || '{}');
function json(res, data, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
function command(binary, args) {
  return new Promise((resolve, reject) => {
    const process = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let errors = '';
    process.stdout.on('data', chunk => { output += chunk; });
    process.stderr.on('data', chunk => { errors = (errors + chunk).slice(-2500); });
    process.on('error', () => reject(new Error(`${binary} is unavailable. Install FFmpeg and ffprobe for video reference uploads.`)));
    process.on('close', code => code === 0 ? resolve(output) : reject(new Error(`Media preparation failed (${binary}, exit ${code}). Check that the file is valid.`)));
  });
}

export async function createStudio({ directory = process.env.BOSON_DATA_DIR || path.join(ROOT, 'data') } = {}) {
  const store = await new Store(directory).init();
  let inspection; let inspectingUrl; let chatAbort; let polling = false;
  const assetPath = asset => path.join(directory, 'media', `${asset.id}${asset.extension}`);
  const publicAsset = asset => ({ ...asset, url: `/media/${asset.id}` });
  const state = () => ({ ...store.publicState(), assets: store.data.assets.filter(asset => !asset.deletedAt).map(publicAsset) });
  for (const asset of store.data.assets.filter(asset => asset.kind === 'image' && !asset.deletedAt && !asset.metadata?.width)) {
    try { asset.metadata = { ...asset.metadata, ...imageDimensions(await readFile(assetPath(asset))) }; } catch {}
  }
  const safeError = error => {
    let message = error.message || 'Something went wrong.';
    for (const secret of [store.data.config.comfy.token, store.data.config.llm.key]) if (secret) message = message.split(secret).join('[redacted]');
    return message;
  };
  const refreshInfo = async () => {
    const config = store.data.config.comfy;
    if (!inspection || inspectingUrl !== `${config.url}:${config.token}`) {
      inspection = await inspectComfy(config); inspectingUrl = `${config.url}:${config.token}`;
    }
    return inspection;
  };
  async function prepareAsset(asset) {
    if (asset.kind !== 'video') return { bytes: await readFile(assetPath(asset)), asset };
    const details = JSON.parse(await command(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', assetPath(asset)]));
    const duration = Number(details.format?.duration);
    if (!Number.isFinite(duration) || duration < 2 || duration > 15) throw new Error('Video references must be 2–15 seconds long. Trim the clip before uploading.');
    const temporary = path.join(directory, 'media', `${asset.id}.prepared.mp4`);
    await command(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-i', assetPath(asset), '-vf', "fps=24,scale=w='min(1344,iw)':h='min(1344,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2", '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '19', temporary]);
    try { return { bytes: await readFile(temporary), asset: { ...asset, extension: '.mp4', mime: 'video/mp4' } }; }
    finally { await unlink(temporary).catch(() => {}); }
  }
  async function prepareJob(job, spec) {
    let contextFile;
    try {
      const { info } = await refreshInfo();
      const uploads = new Map();
      if (spec.sourceAsset) {
        const sourceFile = assetPath(spec.sourceAsset);
        const source = await probeMedia(sourceFile);
        spec.sourceAsset.metadata = { ...spec.sourceAsset.metadata, ...source };
        spec.sourceSize = [source.width, source.height];
        const [width, height] = fitSourceDimensions(source.width, source.height);
        contextFile = path.join(directory, 'media', `${job.id}-context.mp4`);
        const prepared = await prepareVideoSource(sourceFile, contextFile, spec.mode, width, height);
        if (spec.mode === 'add_audio') spec.duration = source.duration;
        const frames = spec.mode === 'extend_video' ? 22 + Math.max(17, Math.round(spec.duration * 24 / 17) * 17) : Math.max(5, Math.ceil((Math.round(source.duration * 24) - 5) / 17) * 17 + 5);
        spec.media = { source: prepared.source, contextFrames: prepared.contextFrames || 0, frames, width, height };
        job.media = spec.media;
        uploads.set('__source__', await uploadComfy(job.connection, { id: `${job.id}-context`, extension: '.mp4', mime: 'video/mp4' }, await readFile(contextFile)));
      }
      for (const asset of spec.references) {
        const prepared = await prepareAsset(asset);
        uploads.set(asset.id, await uploadComfy(job.connection, prepared.asset, prepared.bytes));
      }
      const { graph, metadata, prompts } = buildWorkflow(spec, store.data.config.models, uploads, info);
      job.metadata = metadata;
      if (spec.sourceAsset) job.metadata.generationFrames = metadata.frames;
      job.simplePrompt = prompts.simplePrompt; job.finalPrompt = prompts.finalPrompt; job.prompt = prompts.finalPrompt;
      const response = await jsonRequest(job.connection.url, 'prompt', { token: job.connection.token, ...postJSON({ prompt: graph, client_id: job.id }) });
      if (!response.prompt_id) throw new Error(`ComfyUI rejected the workflow${response.error?.message ? `: ${response.error.message}` : '.'}`);
      job.promptId = response.prompt_id;
      job.status = 'queued';
      await store.save();
    } catch (error) {
      job.status = 'failed'; job.error = safeError(error);
      store.message('assistant', `I couldn’t start “${job.title}”. ${job.error}`, { error: true });
      await store.save();
    } finally {
      if (contextFile) await unlink(contextFile).catch(() => {});
    }
  }
  async function createJob(input) {
    const spec = validateGeneration(input, store.data.assets.filter(asset => !asset.deletedAt));
    const job = { id: store.id(), status: 'preparing', title: spec.title, prompt: spec.prompt, simplePrompt: spec.prompt, mode: spec.mode, sourceAssetId: spec.sourceAsset?.id, assetIds: [...(spec.sourceAsset ? [spec.sourceAsset.id] : []), ...spec.references.map(a => a.id)], createdAt: new Date().toISOString(), connection: { ...store.data.config.comfy } };
    store.data.jobs.push(job);
    await store.save();
    await prepareJob(job, spec);
    return job;
  }
  async function collectJob(job, record) {
    if (job.deletedAt || job.status === 'cancelled') return;
    const descriptors = [];
    for (const output of Object.values(record.outputs || {})) {
      for (const field of ['images', 'gifs', 'videos', 'audio']) for (const item of output[field] || []) {
        if (item?.filename && (!item.type || item.type === 'output') && !descriptors.some(other => other.filename === item.filename && other.subfolder === item.subfolder)) descriptors.push(item);
      }
    }
    if (!descriptors.length) throw new Error('ComfyUI finished without a saved image or video. Check the output nodes in your installed ComfyUI version.');
    const created = [];
    for (const item of descriptors) {
      const extension = path.extname(item.filename).toLowerCase();
      if (!MEDIA_EXTENSIONS.includes(extension)) continue;
      if (job.mode === 'add_audio' && !TYPES[extension].startsWith('audio/')) continue;
      if (job.mode === 'extend_video' && !TYPES[extension].startsWith('video/')) continue;
      const parameters = new URLSearchParams({ filename: item.filename, subfolder: item.subfolder || '', type: item.type || 'output' });
      const result = await request(job.connection.url, `view?${parameters}`, { token: job.connection.token, timeout: 120000 });
      const videoOperation = ['add_audio', 'extend_video'].includes(job.mode);
      const asset = { id: store.id(), name: job.title, extension: videoOperation ? '.mp4' : extension, mime: videoOperation ? 'video/mp4' : TYPES[extension], kind: videoOperation ? 'video' : TYPES[extension].split('/')[0], origin: 'generated', createdAt: new Date().toISOString(), prompt: job.prompt, simplePrompt: job.simplePrompt, finalPrompt: job.finalPrompt, jobId: job.id, metadata: job.metadata };
      const downloadFile = videoOperation ? path.join(directory, 'media', `${job.id}-render${extension}`) : assetPath(asset);
      await pipeline(result.body, (await import('node:fs')).createWriteStream(downloadFile));
      if (videoOperation) {
        try {
          const sourceAsset = store.data.assets.find(candidate => candidate.id === job.sourceAssetId);
          if (!sourceAsset) throw new Error('The original source video is unavailable.');
          if (job.mode === 'add_audio') await addSoundtrack(assetPath(sourceAsset), downloadFile, assetPath(asset), job.media.source.duration);
          else await appendContinuation(assetPath(sourceAsset), downloadFile, assetPath(asset), job.media);
          const measured = await probeMedia(assetPath(asset));
          job.metadata = { ...job.metadata, ...measured, frames: measured.frames || Math.round(measured.duration * measured.fps) };
          asset.metadata = job.metadata;
        } finally { await unlink(downloadFile).catch(() => {}); }
      }
      if (job.deletedAt || job.status === 'cancelled') return;
      store.data.assets.push(asset); created.push(asset.id);
    }
    if (!created.length) throw new Error('The output media format is not supported by this app.');
    job.status = 'completed'; job.completedAt = new Date().toISOString(); job.outputIds = created;
    store.message('assistant', `“${job.title}” is ready.`, { assetIds: created, result: true });
  }
  async function pollJobs() {
    if (polling) return;
    polling = true;
    try {
      for (const job of store.data.jobs.filter(j => !j.deletedAt && ['queued', 'running'].includes(j.status) && j.promptId)) {
        try {
          const config = job.connection || store.data.config.comfy;
          const history = await jsonRequest(config.url, `history/${encodeURIComponent(job.promptId)}`, { token: config.token, timeout: 15000 });
          if (job.deletedAt || job.status === 'cancelled') continue;
          const record = history[job.promptId];
          if (record?.status?.status_str === 'error' || record?.status?.messages?.some(([type]) => type === 'execution_error' || type === 'execution_interrupted')) {
            const details = record.status.messages.find(([type]) => type === 'execution_error')?.[1];
            throw new Error(details?.exception_message || 'ComfyUI stopped the generation.');
          }
          if (record?.status?.completed || record?.outputs && Object.keys(record.outputs).length) {
            await collectJob(job, record); await store.save(); continue;
          }
          const queue = await jsonRequest(config.url, 'queue', { token: config.token, timeout: 15000 });
          if (job.deletedAt || job.status === 'cancelled') continue;
          const present = [...(queue.queue_running || []), ...(queue.queue_pending || [])].some(entry => entry[1] === job.promptId);
          if (!present) {
            // History and queue are separate snapshots. Completion can occur between them.
            // Measure consecutive absence, not total job age, before declaring a job lost.
            job.missingSince ??= Date.now();
            job.connectionWarning = 'Waiting for ComfyUI to publish the result';
            if (Date.now() - job.missingSince > 30000) throw new Error('This job is no longer in the ComfyUI queue or history. It may have been removed.');
          } else {
            delete job.missingSince;
            job.connectionWarning = '';
            job.status = queue.queue_running?.some(entry => entry[1] === job.promptId) ? 'running' : 'queued';
          }
        } catch (error) {
          if (job.deletedAt || job.status === 'cancelled') continue;
          if (/fetch failed|timeout|aborted|ECONN|HTTP 50/i.test(error.message)) { job.connectionWarning = 'Waiting for ComfyUI to reconnect'; continue; }
          job.status = 'failed'; job.error = safeError(error);
          store.message('assistant', `“${job.title}” didn’t finish. ${job.error}`, { error: true });
          await store.save();
        }
      }
    } finally { polling = false; }
  }
  for (const job of store.data.jobs.filter(j => j.status === 'preparing')) { job.status = 'failed'; job.error = 'The app restarted during preparation. Please submit this request again.'; }
  const timer = setInterval(() => void pollJobs(), 2500);
  timer.unref();

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const host = req.headers.host || 'localhost';
      const url = new URL(req.url, `http://${host}`);
      // This is a trusted local application. Reject cross-origin API calls and DNS-rebinding hosts.
      const hostname = url.hostname;
      const trustedHosts = ['localhost', '127.0.0.1', '[::1]', ...(process.env.BOSON_ALLOWED_HOSTS || '').split(',').filter(Boolean)];
      if (!trustedHosts.includes(hostname)) throw Object.assign(new Error('Host not allowed. Add the host to BOSON_ALLOWED_HOSTS for LAN access.'), { status: 403 });
      if (req.headers.origin && new URL(req.headers.origin).host !== host) throw Object.assign(new Error('Cross-origin requests are not allowed.'), { status: 403 });
      const route = url.pathname;
      if (req.method === 'GET' && route === '/api/state') return json(res, state());
      if (req.method === 'GET' && route === '/api/health') return json(res, { ok: true, name: 'Boson Studio', version: '0.1.0' });
      if (req.method === 'PUT' && route === '/api/settings') {
        const input = await bodyJSON(req); const config = store.data.config;
        for (const service of ['comfy', 'llm']) {
          const value = input[service];
          if (!value) continue;
          if (typeof value.url !== 'string') throw new Error('A connection URL is required.');
          endpoint(value.url, '');
          config[service].url = value.url.replace(/\/+$/, '');
          const secret = service === 'comfy' ? 'token' : 'key';
          if (typeof value[secret] === 'string') config[service][secret] = value[secret];
          if (service === 'llm') config.llm.model = String(value.model || '').slice(0, 200);
        }
        if (input.models) for (const key of Object.keys(config.models)) if (typeof input.models[key] === 'string') config.models[key] = input.models[key].slice(0, 400);
        inspection = null; await store.save(); return json(res, state().config);
      }
      if (req.method === 'POST' && route === '/api/test/comfy') {
        inspection = null; const { report } = await refreshInfo(); return json(res, { ...report, mediaTools: await mediaToolVersions() });
      }
      if (req.method === 'POST' && route === '/api/test/llm') {
        const config = store.data.config.llm;
        const result = await jsonRequest(config.url, 'models', { token: config.key });
        return json(res, { ok: true, models: (result.data || []).map(model => model.id) });
      }
      if (req.method === 'POST' && route === '/api/assets') {
        const name = decodeURIComponent(req.headers['x-file-name'] || 'upload');
        const extension = path.extname(name).toLowerCase();
        if (!MEDIA_EXTENSIONS.includes(extension)) throw new Error('Upload a PNG, JPEG, WebP, GIF, MP4, WebM, MOV or common audio file.');
        const bytes = await readBody(req, MAX_UPLOAD);
        if (!bytes.length) throw new Error('This file is empty.');
        const asset = { id: store.id(), name: path.basename(name).slice(0, 160), extension, mime: TYPES[extension], kind: TYPES[extension].split('/')[0], origin: 'uploaded', createdAt: new Date().toISOString(), size: bytes.length };
        if (asset.kind === 'image') asset.metadata = imageDimensions(bytes) || {};
        await writeFile(assetPath(asset), bytes); store.data.assets.push(asset); await store.save();
        return json(res, publicAsset(asset), 201);
      }
      if (req.method === 'POST' && route === '/api/chat') {
        if (store.data.busy) return json(res, { error: 'The assistant is still responding.' }, 409);
        const input = await bodyJSON(req);
        if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 16000) throw new Error('Enter a message of up to 16,000 characters.');
        const assetIds = input.assetIds || [];
        if (!Array.isArray(assetIds) || assetIds.length > 10 || assetIds.some(id => !store.data.assets.find(a => a.id === id && !a.deletedAt))) throw new Error('An attached asset is unavailable.');
        store.message('user', input.message.trim(), { assetIds }); store.data.busy = true; await store.save();
        chatAbort = new AbortController();
        void runAssistant(store, createJob, chatAbort.signal).catch(error => {
          store.message('assistant', error.name === 'AbortError' ? 'Response stopped.' : safeError(error), { error: true });
        }).finally(async () => { store.data.busy = false; await store.save(); });
        return json(res, { accepted: true }, 202);
      }
      if (req.method === 'POST' && route === '/api/chat/stop') { chatAbort?.abort(); return json(res, { ok: true }); }
      if (req.method === 'POST' && route === '/api/chat/clear') {
        if (store.data.busy) throw new Error('Wait for the assistant to finish before starting a new chat.');
        store.data.messages = []; await store.save(); return json(res, { ok: true });
      }
      if (req.method === 'DELETE' && /^\/api\/(assets|jobs)\/[^/]+$/.test(route)) {
        const [, , category, id] = route.split('/');
        const result = removeEntry(store, category === 'assets' ? 'asset' : 'job', id);
        await store.save(); return json(res, result);
      }
      if (req.method === 'POST' && route === '/api/trash/restore') {
        const input = await bodyJSON(req);
        const result = restoreEntry(store, input.kind, input.id);
        await store.save(); return json(res, result);
      }
      if (req.method === 'POST' && /^\/api\/jobs\/[^/]+\/cancel$/.test(route)) {
        const job = store.data.jobs.find(j => j.id === route.split('/')[3]);
        if (!job || !['queued', 'running'].includes(job.status)) throw new Error('This job cannot be cancelled.');
        const config = job.connection || store.data.config.comfy;
        const queue = await jsonRequest(config.url, 'queue', { token: config.token });
        if (queue.queue_running?.some(entry => entry[1] === job.promptId)) await jsonRequest(config.url, 'interrupt', { token: config.token, ...postJSON({}) });
        else await jsonRequest(config.url, 'queue', { token: config.token, ...postJSON({ delete: [job.promptId] }) });
        job.status = 'cancelled'; await store.save(); return json(res, { ok: true });
      }
      if (req.method === 'GET' && route.startsWith('/media/')) {
        const asset = store.data.assets.find(a => a.id === route.slice(7) && !a.deletedAt);
        if (!asset) return json(res, { error: 'Media not found.' }, 404);
        const filename = assetPath(asset); const details = await stat(filename);
        if (url.searchParams.has('download')) res.setHeader('Content-Disposition', `attachment; filename="${asset.id}${asset.extension}"`);
        res.setHeader('Content-Type', asset.mime); res.setHeader('Accept-Ranges', 'bytes');
        const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
        if (req.headers.range && !match) { res.writeHead(416, { 'Content-Range': `bytes */${details.size}` }); return res.end(); }
        if (match) {
          let start = match[1] ? Number(match[1]) : Math.max(0, details.size - Number(match[2]));
          let end = match[1] && match[2] ? Math.min(Number(match[2]), details.size - 1) : details.size - 1;
          if (start > end || start >= details.size) { res.writeHead(416, { 'Content-Range': `bytes */${details.size}` }); return res.end(); }
          res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${details.size}`, 'Content-Length': end - start + 1 });
          return createReadStream(filename, { start, end }).pipe(res);
        }
        res.setHeader('Content-Length', details.size); return createReadStream(filename).pipe(res);
      }
      if (req.method === 'GET' && ['/', '/index.html', '/app.js', '/markdown.js', '/styles.css', '/theme.js', '/theme.css', '/mark.svg'].includes(route)) {
        const filename = path.join(ROOT, 'public', route === '/' ? 'index.html' : route.slice(1));
        res.setHeader('Content-Type', TYPES[path.extname(filename)] || 'application/octet-stream');
        return res.end(await readFile(filename));
      }
      return json(res, { error: 'Not found.' }, 404);
    } catch (error) { if (!res.headersSent) json(res, { error: safeError(error) }, error.status || 400); else res.destroy(); }
  });
  server.on('close', () => { clearInterval(timer); chatAbort?.abort(); });
  return { server, store, pollJobs, createJob };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server } = await createStudio();
  const port = Number(process.env.PORT || 3210); const host = process.env.HOST || '127.0.0.1';
  server.listen(port, host, () => console.log(`\n  Boson Studio\n  http://${host === '0.0.0.0' ? 'localhost' : host}:${port}\n\n  Local image and video studio.\n`));
}
