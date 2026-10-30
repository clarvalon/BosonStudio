export function endpoint(base, route) {
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use an http(s) base URL without credentials, query parameters or fragments.');
  return `${url.href.replace(/\/$/, '')}/${route.replace(/^\//, '')}`;
}

export async function request(base, route, { token, timeout = 30000, ...options } = {}) {
  const response = await fetch(endpoint(base, route), {
    ...options,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers },
    signal: options.signal || AbortSignal.timeout(timeout),
  });
  if (!response.ok) {
    let reason = '';
    const raw = await response.text();
    try {
      const data = JSON.parse(raw);
      reason = data.error?.message || data.error || data.message || '';
      if (typeof reason !== 'string') reason = '';
      const details = Object.entries(data.node_errors || {}).flatMap(([id, node]) =>
        (node.errors || []).map(error => `Node ${id}${node.class_type ? ` (${node.class_type})` : ''}: ${[error.message, error.details].filter(Boolean).join(' — ')}`),
      );
      if (details.length) reason = [reason, ...details.slice(0, 3)].filter(Boolean).join('. ');
    } catch {}
    // Never include upstream HTML, request headers, or echoed credentials in user-facing errors.
    if (typeof reason !== 'string') reason = '';
    if (token) reason = reason.split(token).join('[redacted]');
    throw new Error(`Connection returned HTTP ${response.status}${reason ? `: ${reason.slice(0, 1200)}` : ''}`);
  }
  return response;
}

export const jsonRequest = async (base, route, options) => (await request(base, route, options)).json();
export const postJSON = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const WORKFLOW_NODES = {
  text_to_image: ['MiniMaxH3ImageToVideo','VAEDecode','ImageFromBatch','SaveImage'],
  text_to_video: ['MiniMaxH3ImageToVideo','VAEDecode','VAEDecodeAudio','CreateVideo','SaveVideo'],
  image_to_video: ['MiniMaxH3ImageToVideo','LoadImage','VAEDecode','VAEDecodeAudio','CreateVideo','SaveVideo'],
  reference_to_image: ['MiniMaxH3ReferenceToVideo','LoadImage','LoadVideo','GetVideoComponents','LoadAudio','VAEDecode','ImageFromBatch','SaveImage'],
  reference_to_video: ['MiniMaxH3ReferenceToVideo','LoadImage','LoadVideo','GetVideoComponents','LoadAudio','VAEDecode','VAEDecodeAudio','CreateVideo','SaveVideo'],
  add_audio: ['MiniMaxH3ImageToVideo','MiniMaxH3ReferenceToVideo','MiniMaxH3AddGuide','LoadVideo','GetVideoComponents','LoadImage','LoadAudio','VAEDecodeAudio','SaveAudio'],
  extend_video: ['MiniMaxH3ImageToVideo','MiniMaxH3ReferenceToVideo','MiniMaxH3AddGuide','LoadVideo','GetVideoComponents','LoadImage','LoadAudio','VAEDecode','VAEDecodeAudio','CreateVideo','SaveVideo'],
};
const COMMON_NODES = ['MiniMaxH3SigmaShift','UNETLoader','CLIPLoader','VAELoader','BasicGuider','RandomNoise','BasicScheduler','KSamplerSelect','SamplerCustomAdvanced'];
export function nodeDiagnostics(stats,info){
  const workflowChecks = Object.entries(WORKFLOW_NODES).map(([mode,names])=>{
    const required=[...new Set([...COMMON_NODES,...names])];
    const missing=required.filter(name=>!info[name]);
    return{mode,ready:missing.length===0,missing,required};
  });
  const required=[...new Set(workflowChecks.flatMap(check=>check.required))];
  return{version:stats.system?.comfyui_version||stats.comfyui_version||'Unknown',workflowChecks,requiredNodeCount:required.length,missingNodes:required.filter(name=>!info[name]),requiredCustomNodePacks:[]};
}

export async function inspectComfy(config) {
  const [stats, info] = await Promise.all([
    jsonRequest(config.url, 'system_stats', { token: config.token }),
    jsonRequest(config.url, 'object_info', { token: config.token, timeout: 60000 }),
  ]);
  const choices = (node, field) => {
    const specification = info[node]?.input?.required?.[field] || info[node]?.input?.optional?.[field];
    return Array.isArray(specification?.[0]) ? specification[0] : [];
  };
  const models = {
    diffusion: choices('UNETLoader', 'unet_name'),
    textEncoder: choices('CLIPLoader', 'clip_name'),
    vae: choices('VAELoader', 'vae_name'),
  };
  const suggest = (list, expression) => list.find(name => expression.test(name)) || '';
  const suggested = {
    videoModel: suggest(models.diffusion, /(?:h3|minimax).*(?:t2v|fl2v)/i),
    referenceModel: suggest(models.diffusion, /(?:h3|minimax).*ref/i),
    textEncoder: suggest(models.textEncoder, /(?:h3|minimax).*qwen|qwen.*(?:h3|minimax)|qwen3.*32b/i),
    videoVae: suggest(models.vae, /(?:h3|minimax).*video.*vae/i),
    audioVae: suggest(models.vae, /(?:h3|minimax).*audio.*vae/i),
  };
  return { info, report: { device: stats.devices?.[0]?.name || 'ComfyUI connected', ...nodeDiagnostics(stats,info), referenceSupport: Boolean(info.MiniMaxH3ReferenceToVideo), models, suggested } };
}

export async function uploadComfy(config, asset, bytes) {
  const form = new FormData();
  form.append('image', new Blob([bytes], { type: asset.mime }), `${asset.id}${asset.extension}`);
  form.append('type', 'input');
  form.append('subfolder', 'boson-studio');
  form.append('overwrite', 'true');
  const result = await jsonRequest(config.url, 'upload/image', { token: config.token, method: 'POST', body: form, timeout: 120000 });
  return result.subfolder ? `${result.subfolder}/${result.name}` : result.name;
}
