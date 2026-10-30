import { readFile, writeFile, mkdir, mkdtemp, copyFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { runAssistant } from '../lib/assistant.mjs';
import { validateGeneration, buildWorkflow } from '../lib/workflows.mjs';
import { inspectComfy, jsonRequest } from '../lib/connections.mjs';
import { createStudio } from '../server.mjs';
import { imageDimensions } from '../lib/vision.mjs';

const args = process.argv.slice(2);
const argument = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const configPath = argument('--config', new URL('../data/studio.json', import.meta.url));
const imagePath = argument('--image');
if (!imagePath) throw new Error('Supply --image with a PNG/JPEG/WebP reference. The bundled vision assertion expects a grey-shirted person eating a burger.');
const source = JSON.parse(await readFile(configPath, 'utf8'));
const config = source.config;
const directory = await mkdtemp(path.join(os.tmpdir(), 'boson-live-audit-'));
const reportPath = argument('--report', path.join(directory, 'report.json'));
const report = { startedAt: new Date().toISOString(), model: config.llm.model, directory, cases: [], gpu: [] };
const persist = () => writeFile(reportPath, JSON.stringify(report, null, 2));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const execute = (binary, argv) => new Promise((resolve, reject) => {
  const child = spawn(binary, argv, { windowsHide: true, stdio: 'ignore' });
  child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(`${binary} exited ${code}`)));
});
const app = await createStudio({ directory });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
app.store.data.config = structuredClone(config);
const imageBytes = await readFile(imagePath);
const metadata = imageDimensions(imageBytes);
const fixtures = [
  { id: 'audit-image-one', name: 'Original photo: man eating a burger', kind: 'image', extension: path.extname(imagePath), mime: 'image/png', metadata, origin: 'uploaded' },
  { id: 'audit-image-two', name: 'Ending frame', kind: 'image', extension: path.extname(imagePath), mime: 'image/png', metadata, origin: 'uploaded' },
  { id: 'audit-video', name: 'Motion reference clip', kind: 'video', extension: '.mp4', mime: 'video/mp4', origin: 'uploaded' },
  { id: 'audit-audio', name: 'Sound reference', kind: 'audio', extension: '.wav', mime: 'audio/wav', origin: 'uploaded' },
];
for (const asset of fixtures.filter(asset => asset.kind === 'image')) await copyFile(imagePath, path.join(directory, 'media', `${asset.id}${asset.extension}`));
await execute(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-loop', '1', '-i', imagePath, '-t', '3', '-vf', 'scale=640:640,fps=24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(directory, 'media', 'audit-video.mp4')]);
await execute(process.env.FFMPEG_PATH || 'ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=3', '-c:a', 'pcm_s16le', path.join(directory, 'media', 'audit-audio.wav')]);
const { info } = await inspectComfy(config.comfy);
const prior = [{ id: 'context', role: 'assistant', content: 'Here is your original image.', assetIds: ['audit-image-one'] }];
const cases = [
  { id: 'text-image', prompt: 'Generate a square editorial photograph of a blue ceramic cup on a wooden table. Use text only, no references.', mode: 'text_to_image', ids: [] },
  { id: 'text-video', prompt: 'Generate a 3-second landscape video of a paper boat floating along a quiet stream. Use text only, no reference files.', mode: 'text_to_video', ids: [] },
  { id: 'animate-image', prompt: 'Animate this image for 3 seconds with subtle natural motion. Keep its original aspect ratio.', attached: ['audit-image-one'], mode: 'image_to_video', ids: ['audit-image-one'] },
  { id: 'first-last-frames', prompt: 'Create a 3-second animation connecting the first attached image as the opening frame to the second as the ending frame. Preserve the source aspect ratio.', attached: ['audit-image-one', 'audit-image-two'], mode: 'image_to_video', ids: ['audit-image-one', 'audit-image-two'] },
  { id: 'edit-follow-up', prompt: 'Make his shirt green. Keep the same man, pose, restaurant, lighting and framing.', history: prior, mode: 'reference_to_image', ids: ['audit-image-one'] },
  { id: 'reference-video', prompt: 'Generate a 3-second video of the man from the attached image, guided by movement in the attached video and sound in the attached audio. Preserve the image aspect ratio.', attached: ['audit-image-one', 'audit-video', 'audit-audio'], mode: 'reference_to_video', ids: ['audit-image-one', 'audit-video', 'audit-audio'] },
  { id: 'add-audio', prompt: 'Add gentle restaurant ambience and soft background jazz to this existing video. Keep the original video footage unchanged and replace its soundtrack.', attached: ['audit-video'], mode: 'add_audio', ids: [], source: 'audit-video' },
  { id: 'extend-video', prompt: 'Extend this existing video by 3 seconds. The man continues eating his burger naturally. Keep the whole original clip and append a smooth continuation.', attached: ['audit-video'], mode: 'extend_video', ids: [], source: 'audit-video' },
  { id: 'vision-description', prompt: 'What color is his shirt, and what is he doing? Describe what you see. Do not generate anything.', attached: ['audit-image-one'], noGeneration: true, vision: true },
  { id: 'explicit-inspection', prompt: 'Inspect the image with ID audit-image-one. What color shirt is visible? Do not generate anything.', noGeneration: true, inspection: true },
  { id: 'error-diagnosis', prompt: 'Show the exact error for my latest job and explain it. Do not retry or generate a replacement.', noGeneration: true, status: true, jobs: [{ id: 'failed-reference', status: 'failed', mode: 'reference_to_image', title: 'Shirt edit', error: "MiniMaxH3ReferenceToVideo.execute() got an unexpected keyword argument 'ref_image_1'" }] },
  { id: 'conversational-status', prompt: 'Is my image ready yet?', noGeneration: true, natural: true, jobs: [{id:'885dce95-3865-497c-8d63-8cba566f8f0f',status:'queued',mode:'text_to_image',title:'Blue cup'}] },
  { id: 'unsupported-masked-edit', prompt: 'Open the paint-mask canvas so I can paint a pixel-accurate mask over just his shirt. Do not generate anything until I have painted the mask.', attached: ['audit-image-one'], noGeneration: true },
];
try {
  for (const scenario of cases.filter(scenario=>!argument('--cases')||argument('--cases').split(',').includes(scenario.id))) {
    app.store.data.assets = structuredClone(fixtures);
    app.store.data.jobs = structuredClone(scenario.jobs || []);
    app.store.data.messages = [...structuredClone(scenario.history || []), { id: `user-${scenario.id}`, role: 'user', content: scenario.prompt, assetIds: scenario.attached || [] }];
    const created = []; const trace = []; const errors = [];
    try {
      await runAssistant(app.store, async input => {
        const spec = validateGeneration(input, app.store.data.assets);
        const uploads = new Map(spec.references.map(asset => [asset.id, `${asset.id}${asset.extension}`]));
        if(spec.sourceAsset){
          spec.sourceSize=[640,640]; uploads.set('__source__','audit-context.mp4');
          spec.media={source:{width:640,height:640,duration:3,fps:24,hasAudio:false},contextFrames:spec.mode==='extend_video'?22:0,frames:spec.mode==='extend_video'?90:73};
        }
        buildWorkflow(spec, config.models, uploads, info);
        created.push({...input,asset_ids:spec.references.map(asset=>asset.id)});
        const job = { id: `planned-${scenario.id}`, status: 'queued', mode: spec.mode, title: spec.title, assetIds: input.asset_ids };
        app.store.data.jobs.push(job); return job;
      }, undefined, { onTool: entry => trace.push(entry) });
    } catch (error) { errors.push(error.message); }
    const response = app.store.data.messages.filter(message => message.role === 'assistant').map(message => message.content).join('\n');
    if (scenario.mode && (created.length !== 1 || created[0]?.mode !== scenario.mode)) errors.push(`Expected one ${scenario.mode}, received ${created.map(input => input.mode).join(', ') || 'none'}`);
    if (scenario.ids && JSON.stringify(created[0]?.asset_ids) !== JSON.stringify(scenario.ids)) errors.push('Wrong reference asset IDs/order.');
    if (scenario.source && created[0]?.source_asset_id !== scenario.source) errors.push('Wrong source video ID.');
    if (scenario.noGeneration && created.length) errors.push('Generated media without permission for this inspection/status request.');
    if (scenario.vision && (!/gr[ae]y/i.test(response) || !/burger|hamburger/i.test(response))) errors.push('Vision did not identify the known shirt color and food.');
    if (scenario.inspection && !trace.some(entry => entry.name === 'inspect_images')) errors.push('Did not inspect the requested image.');
    if (scenario.status && (!trace.some(entry => entry.name === 'get_job_status') || !response.includes('ref_image_1'))) errors.push('Did not retrieve/quote the actual job error.');
    if ((scenario.mode || scenario.natural) && /[0-9a-f]{8}-[0-9a-f-]{27,}|audit-(?:image|video|audio)|planned-|source_asset_id|asset_ids|create_media|MiniMaxH3/i.test(response)) errors.push('Routine reply exposed internal technical details.');
    const entry = { id: scenario.id, passed: errors.length === 0, errors, created, tools: trace.map(item => item.name), response };
    report.cases.push(entry); await persist();
    console.log(JSON.stringify({ case: entry.id, passed: entry.passed, errors }));
  }
  if (args.includes('--gpu')) {
    app.store.data.assets = structuredClone(fixtures); app.store.data.jobs = []; app.store.data.messages = [];
    for (const caseId of ['text-image', 'text-video', 'animate-image', 'first-last-frames', 'edit-follow-up', 'reference-video']) {
      const planned = report.cases.find(item => item.id === caseId);
      if (!planned?.passed) { report.gpu.push({ id: caseId, status: 'skipped', reason: 'LLM planning did not pass.' }); await persist(); continue; }
      const queue = await jsonRequest(config.comfy.url, 'queue', { token: config.comfy.token });
      if (queue.queue_running?.length || queue.queue_pending?.length) { console.log(JSON.stringify({ waitingForQueue: caseId })); while (true) { await delay(2500); const next = await jsonRequest(config.comfy.url, 'queue', { token: config.comfy.token }); if (!next.queue_running?.length && !next.queue_pending?.length) break; } }
      const started = Date.now(); const job = await app.createJob(planned.created[0]);
      console.log(JSON.stringify({ submitted: caseId, job: job.id, status: job.status }));
      while (['preparing', 'queued', 'running'].includes(job.status) && Date.now() - started < 600000) { await app.pollJobs(); await delay(2500); }
      const result = { id: caseId, status: job.status, error: job.error || null, elapsedSeconds: Math.round((Date.now() - started) / 1000), metadata: job.metadata, outputs: job.outputIds?.map(id => { const asset = app.store.data.assets.find(item => item.id === id); return { id, file: path.join(directory, 'media', `${id}${asset.extension}`), kind: asset.kind }; }) || [] };
      report.gpu.push(result); await persist(); console.log(JSON.stringify({ gpu: caseId, status: result.status, error: result.error, elapsedSeconds: result.elapsedSeconds }));
      if (result.status !== 'completed' && result.status !== 'failed') break;
    }
  }
  report.finishedAt = new Date().toISOString(); await persist();
  console.log(JSON.stringify({ report: reportPath, llmPassed: report.cases.filter(item => item.passed).length, llmTotal: report.cases.length, gpuCompleted: report.gpu.filter(item => item.status === 'completed').length }));
} finally { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); await app.store.pending; }
