import { renderMarkdown } from './markdown.js';
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const paths = {
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>',
  settings: '<polygon points="12.000,3.000 13.756,3.173 14.679,5.533 15.889,6.180 18.364,5.636 19.483,7.000 18.467,9.321 18.865,10.634 21.000,12.000 20.827,13.756 18.467,14.679 17.820,15.889 18.364,18.364 17.000,19.483 14.679,18.467 13.366,18.865 12.000,21.000 10.244,20.827 9.321,18.467 8.111,17.820 5.636,18.364 4.517,17.000 5.533,14.679 5.135,13.366 3.000,12.000 3.173,10.244 5.533,9.321 6.180,8.111 5.636,5.636 7.000,4.517 9.321,5.533 10.634,5.135"/><circle cx="12" cy="12" r="3"/>',
  chat: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2v-9.5A8.5 8.5 0 0 1 10.5 4h2a8.5 8.5 0 0 1 8.5 7.5Z"/><path d="M7 10h10M7 14h6"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  newChat: '<path d="M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7M16 3l5 5M10 14l2-5 7-7 4 4-7 7-6 1Z"/>',
  video: '<rect x="3" y="5" width="14" height="14" rx="3"/><path d="m17 9 5-3v12l-5-3Z"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/>',
  audio: '<path d="M9 18V5l11-2v13M9 9l11-2"/><ellipse cx="6" cy="18" rx="3" ry="2.5"/><ellipse cx="17" cy="16" rx="3" ry="2.5"/>',
  sparkles: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3ZM20 2v4M18 4h4"/>',
  orbit: '<ellipse cx="12" cy="12" rx="11" ry="4" transform="rotate(-45 12 12)"/><ellipse cx="12" cy="12" rx="11" ry="4" transform="rotate(45 12 12)"/><circle cx="12" cy="12" r="1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  arrowUp: '<path d="M12 20V4m-6 6 6-6 6 6"/>',
  arrowRight: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  arrowUpRight: '<path d="M6 18 18 6M6 6h12v12"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5"/>',
  download: '<path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  play: '<path d="m8 5 11 7-11 7Z"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.sparkles}</svg>`;
$$('[data-icon]').forEach(element => { element.innerHTML = icon(element.dataset.icon); });

let studio = { messages: [], assets: [], jobs: [], config: null, busy: false };
let attachments = [];
let filter = 'all';
let currentPreview;
let promptView = 'simple';
let lastMessageSignature = '';
let lastGallerySignature = '';
let disconnected = false;
let uploadCount = 0;
let toastTimer;

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
const jsonOptions = (body = {}, method = 'POST') => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
function toast(message, undo) {
  const element = $('#toast'); element.textContent = message; element.hidden = false;
  if (undo) { const button = document.createElement('button'); button.className = 'undo-button'; button.textContent = 'Undo'; button.addEventListener('click', async () => { button.disabled = true; try { await undo(); element.hidden = true; } catch (error) { toast(error.message); } }); element.append(button); }
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { element.hidden = true; }, undo ? 10000 : 5500);
}
function assetById(id) { return studio.assets.find(asset => asset.id === id); }
const assetUrl = asset => `/media/${encodeURIComponent(asset.id)}`;
const audioArt = () => `<div class="audio-visual" aria-hidden="true">${Array.from({ length: 13 }, () => '<i></i>').join('')}</div>`;
function mediaVisual(asset, { controls = false } = {}) {
  const url = escape(assetUrl(asset));
  if (asset.kind === 'image') return `<img src="${url}" alt="${escape(asset.name)}" loading="lazy">`;
  if (asset.kind === 'video') return `<video src="${url}#t=0.1" ${controls ? 'controls autoplay' : 'muted preload="metadata"'} playsinline aria-label="${escape(asset.name)}"></video>`;
  return controls ? `<audio src="${url}" controls autoplay></audio>` : audioArt();
}
function messageMedia(id) {
  const asset = assetById(id);
  if (!asset) return '';
  return `<button class="message-asset" data-preview="${escape(asset.id)}" aria-label="Preview ${escape(asset.name)}">${mediaVisual(asset)}<span>${escape(asset.name)}</span></button>`;
}
function renderMessages() {
  const signature = JSON.stringify([studio.messages, studio.busy]);
  if (signature === lastMessageSignature) return;
  const wasNearBottom = $('#chat-scroll').scrollHeight - $('#chat-scroll').scrollTop - $('#chat-scroll').clientHeight < 150;
  lastMessageSignature = signature;
  $('#welcome').hidden = studio.messages.length > 0;
  $('#messages').innerHTML = studio.messages.map(message => `<article class="message ${message.role === 'user' ? 'user' : 'assistant'} ${message.error ? 'error' : ''}" aria-label="${message.role === 'user' ? 'Your message' : 'Assistant message'}"><div class="message-avatar">${message.role === 'user' ? icon('user') : '<img src="/mark.svg" alt="">'}</div><div class="message-body"><div class="message-text">${message.error ? escape(message.content) : renderMarkdown(message.content)}</div>${message.assetIds?.length ? `<div class="message-assets">${message.assetIds.map(messageMedia).join('')}</div>` : ''}</div></article>`).join('');
  $('#thinking').hidden = !studio.busy;
  $('#send').innerHTML = icon(studio.busy ? 'stop' : 'arrowUp');
  $('#send').setAttribute('aria-label', studio.busy ? 'Stop assistant response' : 'Send message');
  if (wasNearBottom || studio.busy) requestAnimationFrame(() => { $('#chat-scroll').scrollTop = $('#chat-scroll').scrollHeight; });
}
function renderGallery() {
  const signature = JSON.stringify([studio.assets, studio.jobs, filter]);
  if (signature === lastGallerySignature) return;
  lastGallerySignature = signature;
  const assets = studio.assets.filter(asset => filter === 'all' || asset.kind === filter).slice().reverse();
  const jobs = studio.jobs.filter(job => job.status !== 'completed' && (filter === 'all' || (job.mode.endsWith('_image') ? 'image' : 'video') === filter)).slice().reverse();
  const activeJobs = studio.jobs.filter(job => ['queued', 'running', 'preparing'].includes(job.status));
  $('#gallery-count').textContent = studio.assets.length;
  $('#mobile-count').textContent = activeJobs.length ? `${activeJobs.length} active` : studio.assets.length;
  $('#mobile-count').classList.toggle('has-active', activeJobs.length > 0);
  $('#mobile-count').title = activeJobs.length ? `${activeJobs.length} active ${activeJobs.length === 1 ? 'generation' : 'generations'}` : `${studio.assets.length} media items`;
  $('#job-summary').hidden = activeJobs.length === 0;
  $('#job-summary').textContent = `${activeJobs.length} active ${activeJobs.length === 1 ? 'generation' : 'generations'}`;
  $('#gallery-empty').hidden = studio.assets.length > 0 || jobs.length > 0;
  $('#no-results').hidden = assets.length > 0 || jobs.length > 0 || studio.assets.length === 0;
  const jobCards = jobs.map(job => `<article class="media-card job-card ${job.status === 'failed' ? 'failed' : ''}"><div class="job-illustration">${icon(job.status === 'failed' ? 'orbit' : 'sparkles')}</div><h3>${escape(job.title)}</h3><div class="job-status">${['preparing', 'queued', 'running'].includes(job.status) ? '<span class="job-pulse"></span>' : ''}${escape({ preparing: 'Preparing generation', queued: 'Queued in ComfyUI', running: 'Generating', failed: 'Generation failed', cancelled: 'Cancelled' }[job.status] || job.status)}</div>${job.error || job.connectionWarning ? `<p>${escape(job.error || job.connectionWarning)}</p>` : ''}${['queued', 'running'].includes(job.status) ? `<button data-cancel="${escape(job.id)}">Cancel generation</button>` : ''}${['failed', 'cancelled'].includes(job.status) ? `<button class="remove-job" data-delete-job="${escape(job.id)}" aria-label="Remove ${escape(job.title)} from gallery">${icon('trash')}Remove</button>` : ''}</article>`).join('');
  $('#gallery-grid').innerHTML = jobCards + assets.map(asset => `<article class="media-card"><button class="media-card-visual" data-preview="${escape(asset.id)}" aria-label="Preview ${escape(asset.name)}">${mediaVisual(asset)}<span class="media-kind">${icon(asset.kind)}${escape(asset.kind === 'image' ? 'Image' : asset.kind === 'video' ? 'Video' : 'Audio')}</span>${asset.kind === 'video' ? `<span class="play-overlay">${icon('play')}</span>` : ''}</button><div class="media-card-details"><span class="media-card-title">${escape(asset.name)}</span><div class="media-card-sub"><span>${asset.origin === 'uploaded' ? 'Your reference' : 'MiniMax H3'}</span><span>${new Date(asset.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span></div></div><div class="media-card-actions"><button class="use-button" data-use="${escape(asset.id)}">${icon('plus')}Use in chat</button><a class="icon-button" href="${escape(assetUrl(asset))}?download=1" aria-label="Download ${escape(asset.name)}" download>${icon('download')}</a><button class="icon-button remove-media" data-delete-asset="${escape(asset.id)}" aria-label="Remove ${escape(asset.name)} from gallery" title="Remove from gallery">${icon('trash')}</button></div></article>`).join('');
}
function renderAttachments() {
  $('#attachment-tray').hidden = attachments.length === 0;
  $('#attachment-tray').innerHTML = attachments.map(id => {
    const asset = assetById(id); if (!asset) return '';
    return `<div class="attachment-pill">${asset.kind === 'image' ? `<img src="${escape(assetUrl(asset))}" alt="">` : icon(asset.kind)}<span>${escape(asset.name)}</span><button type="button" class="icon-button" data-remove="${escape(id)}" aria-label="Remove ${escape(asset.name)} from message">${icon('close')}</button></div>`;
  }).join('');
}
function renderConnection() {
  const configured = Boolean(studio.config?.llm.model && studio.config?.models.videoModel);
  $('#connection').classList.toggle('configured', configured && !disconnected);
  $('#connection-label').textContent = disconnected ? 'Reconnecting…' : configured ? 'Connections set' : 'Set up your studio';
}
async function sync() {
  try {
    studio = await api('/api/state'); disconnected = false;
    attachments = attachments.filter(id => studio.assets.some(asset => asset.id === id));
    renderMessages(); renderGallery(); renderConnection(); renderAttachments();
  } catch { disconnected = true; renderConnection(); }
}
function setView(view) {
  $('#workspace').dataset.view = view;
  $$('.mobile-tab').forEach(tab => { const active = tab.dataset.view === view; tab.classList.toggle('active', active); tab.setAttribute('aria-pressed', active); });
}
function useAsset(id) {
  if (attachments.includes(id)) { toast('This reference is already attached.'); return; }
  if (attachments.length >= 10) { toast('Use up to ten references in a message.'); return; }
  attachments.push(id); renderAttachments(); setView('chat'); $('#message-input').focus();
}
function openPreview(id) {
  const asset = assetById(id); if (!asset) return;
  currentPreview = asset;
  promptView = 'simple';
  $('#preview-title').textContent = asset.name;
  $('#preview-media').innerHTML = mediaVisual(asset, { controls: true });
  renderPrompt();
  const meta = asset.metadata;
  const details = [];
  if (meta?.width && meta?.height) details.push(`${meta.width} × ${meta.height}`);
  if (asset.kind === 'video' && meta?.frames && meta?.fps) details.push(`${(meta.frames / meta.fps).toFixed(1)}s`, `${meta.fps}fps`);
  if (Number.isSafeInteger(meta?.seed)) details.push(`Seed ${meta.seed}`);
  if (meta?.promptFormat) details.push(meta.promptFormat);
  $('#preview-metadata').textContent = details.length ? details.join(' · ') : `${asset.kind.charAt(0).toUpperCase() + asset.kind.slice(1)} · ${asset.extension.slice(1).toUpperCase()}`;
  $('#preview-download').href = `${assetUrl(asset)}?download=1`;
  $('#preview-dialog').showModal();
}
function renderPrompt() {
  const asset = currentPreview;
  if (!asset) return;
  const hasPrompt = Boolean(asset.simplePrompt || asset.finalPrompt || asset.prompt);
  $('#prompt-controls').hidden = !hasPrompt;
  $('#prompt-simple').setAttribute('aria-pressed', promptView === 'simple');
  $('#prompt-final').setAttribute('aria-pressed', promptView === 'final');
  $('#preview-prompt').textContent = !hasPrompt ? 'Uploaded reference.' : promptView === 'final' ? asset.finalPrompt || asset.prompt || asset.simplePrompt : asset.simplePrompt || asset.prompt || asset.finalPrompt;
  $('#preview-prompt').classList.toggle('final-prompt', promptView === 'final');
  $('#prompt-note').hidden = !hasPrompt || Boolean(asset.simplePrompt && asset.finalPrompt);
  $('#prompt-note').textContent = 'Legacy entry: only the original submitted prompt was recorded.';
}
$('#prompt-simple').addEventListener('click', () => { promptView = 'simple'; renderPrompt(); });
$('#prompt-final').addEventListener('click', () => { promptView = 'final'; renderPrompt(); });
$('#preview-close').addEventListener('click', () => $('#preview-dialog').close());
$('#preview-dialog').addEventListener('close', () => { $('#preview-media').innerHTML = ''; });
$('#preview-use').addEventListener('click', () => { $('#preview-dialog').close(); useAsset(currentPreview.id); });

async function uploadFiles(files, attach = true) {
  for (const file of files) {
    if (file.size > 128 * 1024 * 1024) { toast(`${file.name} is larger than 128 MB.`); continue; }
    if (attach && attachments.length >= 10) { toast('Use up to ten references in a message.'); break; }
    uploadCount++; $('#attach').disabled = true; $('#send').disabled = true;
    try {
      toast(`Adding ${file.name}…`);
      const asset = await api('/api/assets', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) }, body: file });
      await sync(); if (attach) useAsset(asset.id); toast(`${file.name} is ready.`);
    } catch (error) { toast(error.message); }
    finally { if (--uploadCount === 0) { $('#attach').disabled = false; $('#send').disabled = false; } }
  }
}
let attachUploads = true;
function chooseFiles(attach = true) { attachUploads = attach; $('#file-input').click(); }
$('#attach').addEventListener('click', () => chooseFiles());
$('#reference-suggestion').addEventListener('click', () => chooseFiles());
$('#gallery-upload').addEventListener('click', () => chooseFiles(false));
$('#empty-upload').addEventListener('click', () => chooseFiles(false));
$('#file-input').addEventListener('change', event => { void uploadFiles([...event.target.files], attachUploads); event.target.value = ''; });
$('#composer').addEventListener('submit', async event => {
  event.preventDefault();
  if (studio.busy) { try { await api('/api/chat/stop', jsonOptions()); } catch (error) { toast(error.message); } return; }
  if (uploadCount) return;
  const input = $('#message-input'); const message = input.value.trim();
  if (!message) { input.focus(); return; }
  if (!studio.config?.llm.model) { openSettings(); toast('Connect a language model to start creating.'); return; }
  $('#send').disabled = true;
  try {
    await api('/api/chat', jsonOptions({ message, assetIds: attachments }));
    input.value = ''; input.style.height = ''; attachments = []; renderAttachments(); await sync();
    $('#chat-scroll').scrollTop = $('#chat-scroll').scrollHeight;
  } catch (error) { toast(error.message); }
  finally { $('#send').disabled = false; }
});
$('#message-input').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !matchMedia('(pointer: coarse)').matches) { event.preventDefault(); $('#composer').requestSubmit(); } });
$('#message-input').addEventListener('input', event => { event.target.style.height = 'auto'; event.target.style.height = `${Math.min(event.target.scrollHeight, 150)}px`; });
$$('[data-prompt]').forEach(button => button.addEventListener('click', () => { const input=$('#message-input'); input.value = button.dataset.prompt; $('#chat-examples').open=false; input.dispatchEvent(new Event('input')); input.focus(); }));
$$('.mobile-tab').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
$$('.filter').forEach(button => button.addEventListener('click', () => { filter = button.dataset.filter; $$('.filter').forEach(tab => { const active = tab === button; tab.classList.toggle('active', active); tab.setAttribute('aria-pressed', active); }); renderGallery(); }));
document.addEventListener('click', async event => {
  const preview = event.target.closest('[data-preview]'); if (preview) openPreview(preview.dataset.preview);
  const use = event.target.closest('[data-use]'); if (use) useAsset(use.dataset.use);
  const remove = event.target.closest('[data-remove]'); if (remove) { attachments = attachments.filter(id => id !== remove.dataset.remove); renderAttachments(); }
  const deleteAsset = event.target.closest('[data-delete-asset]'); if (deleteAsset) requestRemoval('asset', deleteAsset.dataset.deleteAsset);
  const deleteJob = event.target.closest('[data-delete-job]'); if (deleteJob) requestRemoval('job', deleteJob.dataset.deleteJob);
  const cancel = event.target.closest('[data-cancel]'); if (cancel) { cancel.disabled = true; try { await api(`/api/jobs/${cancel.dataset.cancel}/cancel`, jsonOptions()); await sync(); } catch (error) { toast(error.message); cancel.disabled = false; } }
});

function openSettings() {
  const config = studio.config; if (!config) return;
  const form = $('#settings-form');
  $('#theme-choice').value = window.BosonTheme.getPreference();
  form.elements.comfyUrl.value = config.comfy.url;
  form.elements.comfyToken.value = ''; form.elements.clearComfyToken.checked = false;
  form.elements.comfyToken.placeholder = config.comfy.hasToken ? 'Saved token • leave blank to keep' : 'Optional bearer token';
  form.elements.llmUrl.value = config.llm.url;
  form.elements.llmModel.value = config.llm.model;
  form.elements.llmKey.value = ''; form.elements.clearLlmKey.checked = false;
  form.elements.llmKey.placeholder = config.llm.hasKey ? 'Saved key • leave blank to keep' : 'Optional API key';
  for (const [key, value] of Object.entries(config.models)) form.elements[key].value = value;
  $('#settings-error').hidden = true;
  $('#settings-dialog').showModal();
}
$('#theme-choice').addEventListener('change', event => window.BosonTheme.setPreference(event.target.value));
$('#settings-open').addEventListener('click', openSettings);
$('#connection').addEventListener('click', openSettings);
$('#settings-close').addEventListener('click', () => $('#settings-dialog').close());
function formSettings() {
  const form = $('#settings-form').elements;
  const settings = { comfy: { url: form.comfyUrl.value.trim() }, llm: { url: form.llmUrl.value.trim(), model: form.llmModel.value.trim() }, models: {} };
  if (form.comfyToken.value || form.clearComfyToken.checked) settings.comfy.token = form.clearComfyToken.checked ? '' : form.comfyToken.value;
  if (form.llmKey.value || form.clearLlmKey.checked) settings.llm.key = form.clearLlmKey.checked ? '' : form.llmKey.value;
  for (const key of ['videoModel', 'referenceModel', 'textEncoder', 'videoVae', 'audioVae']) settings.models[key] = form[key].value.trim();
  return settings;
}
async function saveSettings() {
  studio.config = await api('/api/settings', jsonOptions(formSettings(), 'PUT'));
  renderConnection();
}
$('#settings-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#save-settings').disabled = true;
  try { await saveSettings(); $('#settings-dialog').close(); toast('Your connections are saved.'); }
  catch (error) { $('#settings-error').textContent = error.message; $('#settings-error').hidden = false; }
  finally { $('#save-settings').disabled = false; }
});
function listOptions(id, values) { $(id).innerHTML = values.map(value => `<option value="${escape(value)}"></option>`).join(''); }
function renderComfyDiagnostics(report) {
  const labels = {text_to_image:'Text → Image',text_to_video:'Text → Video',image_to_video:'Image → Video',reference_to_image:'Reference → Image',reference_to_video:'Reference → Video',add_audio:'Add Audio',extend_video:'Extend Video'};
  const target = $('#comfy-diagnostics'); target.hidden = false;
  const toolsReady = report.mediaTools?.ffmpeg && report.mediaTools?.ffprobe;
  target.innerHTML = '<p>'+escape(report.device)+'</p><p>'+ (toolsReady ? 'FFmpeg and ffprobe available.' : 'FFmpeg or ffprobe missing: video reference preparation, Add Audio and Extend Video need both.') +'</p><p>No additional custom-node packs are required by these workflows.</p><details><summary>Workflow node requirements</summary><ul>'+report.workflowChecks.map(check=>'<li><strong>'+escape(labels[check.mode]||check.mode)+'</strong>: '+(check.ready?'Ready':'Missing '+escape(check.missing.join(', ')))+'</li>').join('')+'</ul></details><p class="diagnostic-note">Node checks verify the API contract. Model-loader libraries and weight compatibility still require a generation test.</p>';
}
$('#test-comfy').addEventListener('click', async () => {
  const button = $('#test-comfy'); const result = $('#comfy-result'); button.disabled = true;
  result.textContent = 'Connecting…'; result.classList.remove('error');
  try {
    await saveSettings();
    const report = await api('/api/test/comfy', jsonOptions());
    listOptions('#diffusion-models', report.models.diffusion); listOptions('#text-models', report.models.textEncoder); listOptions('#vae-models', report.models.vae);
    const form = $('#settings-form').elements;
    for (const [key, value] of Object.entries(report.suggested)) if (!form[key].value && value) form[key].value = value;
    await saveSettings();
    const missingSelections = Object.values(studio.config.models).filter(value => !value).length;
    result.textContent = report.missingNodes.length ? `ComfyUI ${report.version}: ${report.missingNodes.length} required nodes missing.` : missingSelections ? `ComfyUI ${report.version} connected. Select the remaining model files below.` : `ComfyUI ${report.version}: all ${report.requiredNodeCount} required node classes found.`;
    renderComfyDiagnostics(report);
    result.classList.toggle('error', report.missingNodes.length > 0);
    $('#model-settings').open = true;
  } catch (error) { result.textContent = error.message; result.classList.add('error'); }
  finally { button.disabled = false; }
});
$('#test-llm').addEventListener('click', async () => {
  const button = $('#test-llm'); const result = $('#llm-result'); button.disabled = true;
  result.textContent = 'Connecting…'; result.classList.remove('error');
  try {
    await saveSettings(); const report = await api('/api/test/llm', jsonOptions());
    listOptions('#llm-models', report.models);
    if (!$('#settings-form').elements.llmModel.value && report.models.length === 1) $('#settings-form').elements.llmModel.value = report.models[0];
    result.textContent = `Connected. ${report.models.length} ${report.models.length === 1 ? 'model' : 'models'} available. Tool calling will be checked on your first request.`;
  } catch (error) { result.textContent = error.message; result.classList.add('error'); }
  finally { button.disabled = false; }
});

$('#new-chat').addEventListener('click', () => { if (studio.busy) toast('Let Boson finish responding, or stop the response first.'); else if (studio.messages.length) $('#confirm-dialog').showModal(); else { attachments = []; renderAttachments(); $('#message-input').focus(); } });
$('#confirm-cancel').addEventListener('click', () => $('#confirm-dialog').close());
$('#confirm-new').addEventListener('click', async () => { try { await api('/api/chat/clear', jsonOptions()); attachments = []; renderAttachments(); $('#confirm-dialog').close(); await sync(); } catch (error) { toast(error.message); } });
$$('dialog').forEach(dialog => dialog.addEventListener('click', event => { const bounds = dialog.getBoundingClientRect(); if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) dialog.close(); }));

let dragDepth = 0;
document.addEventListener('dragenter', event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); dragDepth++; $('#drop-overlay').hidden = false; } });
document.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop-overlay').hidden = true; } });
document.addEventListener('drop', event => { if (!event.dataTransfer?.files.length) return; event.preventDefault(); dragDepth = 0; $('#drop-overlay').hidden = true; void uploadFiles([...event.dataTransfer.files]); });
document.addEventListener('paste', event => { const files = [...(event.clipboardData?.files || [])]; if (files.length && !$('#settings-dialog').open) { event.preventDefault(); void uploadFiles(files); } });

const splitter = $('#split-handle');
let pendingRemoval;
function requestRemoval(kind, id) {
  const entry = (kind === 'asset' ? studio.assets : studio.jobs).find(item => item.id === id);
  if (!entry) return;
  pendingRemoval = { kind, id };
  $('#delete-description').textContent = `Remove “${entry.name || entry.title}” from the gallery? You can undo this action.`;
  $('#delete-dialog').showModal();
}
$('#delete-cancel').addEventListener('click', () => $('#delete-dialog').close());
$('#delete-confirm').addEventListener('click', async () => {
  const removal = pendingRemoval;
  if (!removal) return;
  $('#delete-confirm').disabled = true;
  try {
    await api(`/api/${removal.kind === 'asset' ? 'assets' : 'jobs'}/${removal.id}`, { method: 'DELETE' });
    $('#delete-dialog').close();
    if (currentPreview?.id === removal.id && $('#preview-dialog').open) $('#preview-dialog').close();
    await sync();
    toast('Removed from gallery.', async () => { await api('/api/trash/restore', jsonOptions(removal)); await sync(); });
  } catch (error) { toast(error.message); }
  finally { $('#delete-confirm').disabled = false; }
});
function resizeAt(x) {
  const bounds = $('#workspace').getBoundingClientRect();
  const minimum = Math.max(35, 350 / bounds.width * 100);
  const maximum = Math.min(65, (bounds.width - 341) / bounds.width * 100);
  const percentage = Math.max(minimum, Math.min(maximum, (x - bounds.left) / bounds.width * 100));
  document.documentElement.style.setProperty('--chat-width', `${percentage}%`);
}
splitter.addEventListener('pointerdown', event => { splitter.setPointerCapture(event.pointerId); event.preventDefault(); });
splitter.addEventListener('pointermove', event => { if (splitter.hasPointerCapture(event.pointerId)) resizeAt(event.clientX); });
splitter.addEventListener('keydown', event => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); resizeAt(splitter.getBoundingClientRect().left + (event.key === 'ArrowLeft' ? -20 : 20)); } });
await sync();
setInterval(() => { if (!document.hidden) void sync(); }, 1400);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void sync(); });
