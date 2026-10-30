import { randomBytes } from 'node:crypto';
import { compilePrompt } from './prompts.mjs';

export const MODES = ['text_to_image', 'text_to_video', 'image_to_video', 'reference_to_image', 'reference_to_video', 'add_audio', 'extend_video'];
const RATIOS = { landscape: [1344, 768], portrait: [768, 1344], square: [1024, 1024], classic: [1152, 864] };

export function validateGeneration(input, assets) {
  if (!input || !MODES.includes(input.mode)) throw new Error('Choose a supported image or video generation operation.');
  if (typeof input.prompt !== 'string' || input.prompt.trim().length < 3 || input.prompt.length > 16000) throw new Error('A descriptive prompt of 3–16,000 characters is required.');
  let ids = input.asset_ids || [];
  if (!Array.isArray(ids) || ids.length > 10 || ids.some(id => typeof id !== 'string')) throw new Error('Use up to ten valid media references.');
  // Tool models sometimes repeat the source among references. It is unambiguously
  // the context clip, so normalize it rather than submitting it twice.
  if (['add_audio','extend_video'].includes(input.mode) && input.source_asset_id) ids = ids.filter(id => id !== input.source_asset_id);
  const references = ids.map(id => {
    const asset = assets.find(item => item.id === id && !item.deletedAt);
    if (!asset) throw new Error(`Media reference ${id} is unavailable. Attach it again.`);
    return asset;
  });
  if (new Set(ids).size !== ids.length) throw new Error('Each reference should appear once.');
  if (input.mode === 'image_to_video' && (references.length < 1 || references.length > 2 || references.some(a => a.kind !== 'image'))) throw new Error('Image animation needs one starting image and optionally one ending image.');
  if (input.mode.startsWith('reference_') && !references.length) throw new Error('Reference generation needs at least one attached asset.');
  if (input.mode.startsWith('text_') && references.length) throw new Error('Use a reference operation when supplying assets.');
  const videoOperation = ['add_audio', 'extend_video'].includes(input.mode);
  const sourceAsset = videoOperation ? assets.find(asset => asset.id === input.source_asset_id && asset.kind === 'video' && !asset.deletedAt) : null;
  if (videoOperation && !sourceAsset) throw new Error('Choose an existing source video for Add Audio or Extend Video.');
  const duration = Number(input.duration ?? 5);
  if (!Number.isFinite(duration) || duration < 3 || duration > 15) throw new Error('Video duration must be between 3 and 15 seconds.');
  const seed = input.seed == null ? randomBytes(6).readUIntBE(0, 6) : Number(input.seed);
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('Seed must be a nonnegative safe integer.');
  if (input.aspect_ratio && input.aspect_ratio !== 'source' && !RATIOS[input.aspect_ratio]) throw new Error('Choose source, landscape, portrait, square or classic.');
  const source = sourceAsset || references.find(asset => asset.kind === 'image' && asset.metadata?.width && asset.metadata?.height);
  const aspectRatio = videoOperation ? 'source' : input.aspect_ratio || (source ? 'source' : 'landscape');
  if (aspectRatio === 'source' && !source) throw new Error('Source aspect ratio requires media with known dimensions. Choose a standard aspect ratio instead.');
  const counts = kind => references.filter(a => a.kind === kind).length;
  if (counts('image') > 5 || counts('video') > 2 || counts('audio') > 2) throw new Error('Use up to five images, two videos and two audio clips.');
  const h3 = {};
  if (input.h3 != null) {
    if (typeof input.h3 !== 'object' || Array.isArray(input.h3)) throw new Error('H3 prompt details must be an object.');
    for (const key of ['description', 'soundscape', 'music', 'style', 'language']) if (input.h3[key] != null) {
      if (typeof input.h3[key] !== 'string' || input.h3[key].length > 16000) throw new Error(`Invalid H3 ${key}.`);
      h3[key] = input.h3[key].trim();
    }
  }
  const subjects = input.subjects || [];
  if (!Array.isArray(subjects) || subjects.length > 16) throw new Error('Specify up to sixteen logical subjects.');
  for (const subject of subjects) {
    if (typeof subject.name !== 'string' || !subject.name.trim() || subject.name.length > 100 || subject.description != null && (typeof subject.description !== 'string' || subject.description.length > 2000)) throw new Error('Each subject needs a short name and valid description.');
    if (!Array.isArray(subject.image_ids || []) || (subject.image_ids || []).some(id => !references.some(asset => asset.id === id && asset.kind === 'image'))) throw new Error(`Subject ${subject.name} refers to an unavailable image.`);
    if (subject.voice_audio_id && !references.some(asset => asset.id === subject.voice_audio_id && asset.kind === 'audio')) throw new Error(`Subject ${subject.name} refers to an unavailable voice reference.`);
  }
  const referenceDetails = input.reference_details || [];
  if (!Array.isArray(referenceDetails) || referenceDetails.some(detail => !references.some(asset => asset.id === detail.id) || typeof detail.description !== 'string' || detail.description.length > 2000)) throw new Error('Reference details must describe supplied media IDs.');
  return { mode: input.mode, prompt: input.prompt.trim(), duration, aspect_ratio: aspectRatio, sourceSize: source?.metadata?.width ? [source.metadata.width, source.metadata.height] : null, sourceAsset, seed, title: String(input.title || 'Untitled creation').slice(0, 90), references, h3, subjects, reference_details: referenceDetails };
}

// Independently constructed graphs using public ComfyUI core node interfaces.
// No application-specific nodes or imports from another project.
export function buildWorkflow(spec, models, uploads, info = {}) {
  const videoOperation = ['add_audio', 'extend_video'].includes(spec.mode);
  if (videoOperation && !spec.media) throw new Error('Source video preparation is required.');
  const reference = spec.mode.startsWith('reference_') || videoOperation && spec.references.length > 0;
  const still = spec.mode.endsWith('_image');
  const modelName = reference ? models.referenceModel : models.videoModel;
  if (!modelName || !models.textEncoder || !models.videoVae || !models.audioVae) throw new Error('Connect ComfyUI and select the H3 model files in Settings → Model files.');
  let [width, height] = spec.aspect_ratio === 'source' ? fitSourceDimensions(...spec.sourceSize) : RATIOS[spec.aspect_ratio];
  // H3 uses a 17k+5 frame grid at 24fps. Five frames is the minimum image path.
  let length = spec.media?.frames || (still ? 5 : Math.ceil((Math.round(spec.duration * 24) - 5) / 17) * 17 + 5);
  let promptSpec = spec;
  if (videoOperation) {
    const instruction = spec.mode === 'add_audio' ? 'The supplied source clip establishes the visual events; generate the requested new soundtrack in synchronization with them.' : `The first ${(spec.media.contextFrames / 24).toFixed(2)} seconds retain the source clip’s ending context. Continue smoothly from that point with the following action.`;
    const description = spec.h3?.description || spec.prompt;
    const joined = description.includes('[Shot 1]') ? description.replace('[Shot 1]', `[Shot 1] ${instruction}`) : `${instruction} ${description}`;
    promptSpec = { ...spec, mode: reference ? 'reference_to_video' : 'text_to_video', h3: { ...spec.h3, description: joined } };
  }
  const prompts = compilePrompt(promptSpec, { frames: length, fps: 24 });
  if (videoOperation) prompts.format = `${reference ? 'Ref2VA' : 'FL2VA'} ${spec.mode === 'add_audio' ? 'soundtrack' : 'extension'}`;
  const graph = {};
  let sequence = 0;
  const node = (class_type, inputs, title = class_type) => {
    const id = String(++sequence);
    graph[id] = { class_type, inputs, _meta: { title } };
    return [id, 0];
  };
  const model = node('UNETLoader', { unet_name: modelName, weight_dtype: 'default' }, 'H3 diffusion model');
  const shifted = node('MiniMaxH3SigmaShift', { model, shift_video: 12, shift_audio: 3 });
  const clip = node('CLIPLoader', { clip_name: models.textEncoder, type: 'minimax', device: 'default' });
  const vae = node('VAELoader', { vae_name: models.videoVae });
  const audioVae = node('VAELoader', { vae_name: models.audioVae });
  const conditioningInputs = { clip, vae, prompt: prompts.finalPrompt, width, height, length };
  const uploaded = asset => {
    const value = uploads.get(asset.id);
    if (!value) throw new Error(`Missing uploaded media: ${asset.id}`);
    return value;
  };
  if (reference) {
    conditioningInputs.audio_vae = audioVae;
    conditioningInputs.ref_image_size = 'match';
    const counters = { image: 0, video: 0, audio: 0 };
    for (const asset of spec.references) {
      const ordinal = counters[asset.kind]++;
      if (asset.kind === 'image') conditioningInputs[`ref_images.ref_image_${ordinal}`] = node('LoadImage', { image: uploaded(asset) });
      if (asset.kind === 'audio') conditioningInputs[`ref_audios.ref_audio_${ordinal}`] = node('LoadAudio', { audio: uploaded(asset) });
      if (asset.kind === 'video') {
        // Native loader preserves the source FPS. H3 expects 24fps; require it during preparation.
        const video = node('LoadVideo', { file: uploaded(asset) });
        const components = node('GetVideoComponents', { video });
        conditioningInputs[`ref_videos.ref_video_${ordinal}`] = components;
      }
    }
  } else if (spec.mode === 'image_to_video') {
    conditioningInputs.first_frame = node('LoadImage', { image: uploaded(spec.references[0]) });
    if (spec.references[1]) conditioningInputs.last_frame = node('LoadImage', { image: uploaded(spec.references[1]) });
  }
  const condition = node(reference ? 'MiniMaxH3ReferenceToVideo' : 'MiniMaxH3ImageToVideo', conditioningInputs, 'Creative direction');
  const latent = [condition[0], 1];
  let positive = condition;
  if (videoOperation) {
    const source = uploads.get('__source__');
    if (!source) throw new Error('The prepared source clip was not uploaded.');
    const video = node('LoadVideo', { file: source });
    const components = node('GetVideoComponents', { video });
    const guide = { positive, latent, vae, audio_vae: audioVae, image: components, frame_idx: 0 };
    if (spec.mode === 'extend_video' && spec.media.source.hasAudio) guide.audio = [components[0], 1];
    positive = node('MiniMaxH3AddGuide', guide, 'Anchor original video context');
  }
  const guider = node('BasicGuider', { model: shifted, conditioning: positive });
  const sampler = node('KSamplerSelect', { sampler_name: 'euler' });
  const sigmas = node('BasicScheduler', { model: shifted, scheduler: 'simple', steps: 20, denoise: 1 });
  const noise = node('RandomNoise', { noise_seed: spec.seed });
  const samples = node('SamplerCustomAdvanced', { noise, guider, sampler, sigmas, latent_image: latent });
  if (spec.mode === 'add_audio') {
    const audio = node('VAEDecodeAudio', { samples, vae: audioVae });
    node('SaveAudio', { audio, filename_prefix: 'BosonStudio/audio' });
  } else {
   let images = node('VAEDecode', { samples, vae });
   if (still) {
    images = node('ImageFromBatch', { image: images, batch_index: 0, length: 1 });
    node('SaveImage', { images, filename_prefix: 'BosonStudio/image' });
   } else {
    const audio = node('VAEDecodeAudio', { samples, vae: audioVae });
    const video = node('CreateVideo', { images, audio, fps: 24 });
    node('SaveVideo', { video, filename_prefix: 'BosonStudio/video', format: 'mp4', codec: 'h264' });
   }
  }
  if (Object.keys(info).length) {
    const missing = [...new Set(Object.values(graph).map(n => n.class_type))].filter(name => !info[name]);
    if (missing.length) throw new Error(`Your ComfyUI is missing these core nodes: ${missing.join(', ')}. Update ComfyUI before generating.`);
    validateWorkflowInputs(graph, info);
  }
  return { graph, prompts, metadata: { width, height, frames: length, fps: 24, seed: spec.seed, promptFormat: prompts.format, promptVersion: prompts.version } };
}

export function fitSourceDimensions(width, height) {
  const scale = Math.sqrt((1024 * 1024) / (width * height));
  const cap = Math.min(scale, 2048 / Math.max(width, height));
  return [width, height].map(value => Math.max(32, Math.round(value * cap / 32) * 32));
}

// V3 growable inputs use dotted paths, not Python argument names or nested objects.
// Validate the actual input contract before allowing an expensive GPU submission.
export function validateWorkflowInputs(graph, info) {
  for (const [id, node] of Object.entries(graph)) {
    const schema = info[node.class_type]?.input;
    if (!schema) continue;
    const declared = { ...schema.required, ...schema.optional };
    const specFor = key => {
      if (declared[key]) return declared[key];
      for (const [group, spec] of Object.entries(declared)) {
        if (spec[0] !== 'COMFY_AUTOGROW_V3') continue;
        const template = spec[1]?.template;
        const prefix = `${group}.${template?.prefix}`;
        if (!key.startsWith(prefix)) continue;
        if (!/^\d+$/.test(key.slice(prefix.length))) continue;
        const index = Number(key.slice(prefix.length));
        if (!Number.isInteger(index) || index < 0 || index >= template.max) continue;
        return Object.values(template.input?.required || template.input?.optional || {})[0];
      }
    };
    for (const key of Object.keys(schema.required || {})) {
      if (!(key in node.inputs)) throw new Error(`${node.class_type} node ${id} is missing required input ${key}.`);
    }
    for (const [key, value] of Object.entries(node.inputs)) {
      const spec = specFor(key);
      if (!spec) throw new Error(`${node.class_type} node ${id} has unsupported input ${key}. Check its ComfyUI API schema.`);
      if (!Array.isArray(value)) continue;
      const upstream = graph[value[0]];
      if (!upstream) throw new Error(`Node ${id} input ${key} refers to a missing node.`);
      const actual = info[upstream.class_type]?.output?.[value[1]];
      const expected = spec[0];
      if (actual && typeof expected === 'string' && !expected.includes(actual) && expected !== '*') throw new Error(`${node.class_type}.${key} expects ${expected}, received ${actual}.`);
    }
  }
}
