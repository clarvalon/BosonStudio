import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGeneration, buildWorkflow, validateWorkflowInputs, MODES } from '../lib/workflows.mjs';
import { endpoint } from '../lib/connections.mjs';

const models = { videoModel: 'h3-fl2va.safetensors', referenceModel: 'h3-ref2va.safetensors', textEncoder: 'h3-qwen.safetensors', videoVae: 'h3-video.safetensors', audioVae: 'h3-audio.safetensors' };
const assets = [{ id: 'image-one', kind: 'image' }, { id: 'image-two', kind: 'image' }, { id: 'video-one', kind: 'video' }, { id: 'audio-one', kind: 'audio' }];
const input = (mode, ids = []) => ({ mode, prompt: 'A cinematic garden in the early morning.', asset_ids: ids, duration: 5, aspect_ratio: 'portrait', seed: 123 });

test('all five generation paths create closed graphs with valid H3 frame grids', () => {
  for (const mode of MODES.filter(mode=>!['add_audio','extend_video'].includes(mode))) {
    const ids = mode.startsWith('reference_') ? ['image-one', 'video-one', 'audio-one'] : mode === 'image_to_video' ? ['image-one', 'image-two'] : [];
    const spec = validateGeneration(input(mode, ids), assets);
    const { graph, metadata } = buildWorkflow(spec, models, new Map(ids.map(id => [id, `${id}.png`])));
    assert.equal(metadata.width, 768); assert.equal(metadata.height, 1344);
    assert.equal(metadata.frames % 17, 5); assert.equal(metadata.seed, 123);
    for (const node of Object.values(graph)) for (const value of Object.values(node.inputs)) {
      if (Array.isArray(value)) assert.ok(graph[value[0]], `Unresolved node link ${value[0]}`);
    }
    const nodes = Object.values(graph);
    assert.equal(nodes.filter(node => node.class_type === (mode.endsWith('_image') ? 'SaveImage' : 'SaveVideo')).length, 1);
    const loader = nodes.find(node => node.class_type === 'UNETLoader');
    assert.equal(loader.inputs.unet_name, mode.startsWith('reference_') ? models.referenceModel : models.videoModel);
    if (mode === 'image_to_video') {
      const condition = nodes.find(node => node.class_type === 'MiniMaxH3ImageToVideo');
      assert.ok(condition.inputs.first_frame); assert.ok(condition.inputs.last_frame);
    }
  }
});

test('reference validation rejects invented assets, wrong animation media and unsupported operations', () => {
  assert.throws(() => validateGeneration(input('reference_to_video', ['invented']), assets), /unavailable/);
  assert.throws(() => validateGeneration(input('image_to_video', ['video-one']), assets), /starting image/);
  assert.throws(() => validateGeneration(input('unknown_mode', ['video-one']), assets), /supported/);
  assert.throws(() => validateGeneration(input('reference_to_image', []), assets), /at least one/);
  assert.throws(() => validateGeneration(input('text_to_video', ['image-one']), assets), /reference operation/);
  assert.throws(() => validateGeneration({ ...input('text_to_video'), duration: 900 }, assets), /duration/);
  assert.throws(() => validateGeneration({ ...input('text_to_video'), seed: -1 }, assets), /Seed/);
});

test('Add Audio decodes only audio and extension anchors video context with optional reference guidance',()=>{
 const source={id:'source',kind:'video',metadata:{width:640,height:360}};
 for(const mode of ['add_audio','extend_video']){
  const validated=validateGeneration({...input(mode),source_asset_id:'source'},[source]);
  validated.media={frames:mode==='add_audio'?73:90,contextFrames:mode==='extend_video'?22:0,source:{width:640,height:360,duration:3,hasAudio:true}};
  const {graph,prompts}=buildWorkflow(validated,models,new Map([['__source__','source.mp4']]));
  const nodes=Object.values(graph);
  assert.ok(nodes.some(node=>node.class_type==='MiniMaxH3AddGuide'));
  if(mode==='add_audio'){
   assert.ok(nodes.some(node=>node.class_type==='SaveAudio'));
   assert.ok(!nodes.some(node=>node.class_type==='VAEDecode'));
   assert.ok(!nodes.find(node=>node.class_type==='MiniMaxH3AddGuide').inputs.audio);
  }else{
   assert.ok(nodes.some(node=>node.class_type==='SaveVideo'));
   assert.ok(nodes.find(node=>node.class_type==='MiniMaxH3AddGuide').inputs.audio);
  }
  assert.ok(prompts.finalPrompt.includes('integrated_multimodal_description:'));
 }
 assert.throws(()=>validateGeneration(input('add_audio'),[source]),/source video/);
});

test('automatic seed generation works when an LLM omits the optional seed', () => {
  const request = input('text_to_image');
  delete request.seed;
  for (let attempt = 0; attempt < 25; attempt++) {
    const spec = validateGeneration(request, assets);
    assert.ok(Number.isSafeInteger(spec.seed));
    assert.ok(spec.seed >= 0 && spec.seed < 2 ** 48);
    const { graph } = buildWorkflow(spec, models, new Map());
    assert.equal(Object.values(graph).find(node => node.class_type === 'RandomNoise').inputs.noise_seed, spec.seed);
  }
  assert.equal(validateGeneration({ ...request, seed: 0 }, assets).seed, 0);
});

test('missing models and missing ComfyUI classes fail before queue submission', () => {
  const spec = validateGeneration(input('text_to_video'), assets);
  assert.throws(() => buildWorkflow(spec, {}, new Map()), /select the H3 model/);
  assert.throws(() => buildWorkflow(spec, models, new Map(), { UNETLoader: {} }), /missing these core nodes/);
});

test('connection base URLs retain path prefixes and reject embedded credentials', () => {
  assert.equal(endpoint('http://localhost:8188/proxy/', '/prompt'), 'http://localhost:8188/proxy/prompt');
  assert.throws(() => endpoint('file:///etc/passwd', 'prompt'), /http/);
  assert.throws(() => endpoint('https://user:password@example.org', 'prompt'), /credentials/);
});

test('all H3 references use zero-based dotted V3 keys and reject the old broken syntax', () => {
  const ids = ['image-one', 'image-two', 'video-one', 'audio-one'];
  const { graph } = buildWorkflow(validateGeneration(input('reference_to_video', ids), assets), models, new Map(ids.map(id => [id, `${id}.png`])));
  const condition = Object.values(graph).find(node => node.class_type === 'MiniMaxH3ReferenceToVideo');
  assert.ok(condition.inputs['ref_images.ref_image_0']);
  assert.ok(condition.inputs['ref_images.ref_image_1']);
  assert.ok(condition.inputs['ref_videos.ref_video_0']);
  assert.ok(condition.inputs['ref_audios.ref_audio_0']);
  const autogrow = (prefix, type, max) => ['COMFY_AUTOGROW_V3', { template: { prefix, max, input: { required: { value: [type] } } } }];
  const info = { MiniMaxH3ReferenceToVideo: { input: {
    required: Object.fromEntries(['clip', 'prompt', 'width', 'height', 'length', 'ref_image_size'].map(key => [key, ['*']])),
    optional: { vae: ['VAE'], audio_vae: ['VAE'], ref_images: autogrow('ref_image_', 'IMAGE', 9), ref_videos: autogrow('ref_video_', 'IMAGE', 3), ref_audios: autogrow('ref_audio_', 'AUDIO', 3) },
  } } };
  assert.doesNotThrow(() => validateWorkflowInputs(graph, info));
  condition.inputs.ref_image_1 = condition.inputs['ref_images.ref_image_0'];
  assert.throws(() => validateWorkflowInputs(graph, info), /unsupported input ref_image_1/);
});

test('image-based operations preserve source proportions and reject deleted references', () => {
  const source = { id: 'portrait', kind: 'image', metadata: { width: 600, height: 1200 } };
  const spec = validateGeneration({ ...input('image_to_video', ['portrait']), aspect_ratio: 'source' }, [source]);
  const { metadata } = buildWorkflow(spec, models, new Map([['portrait', 'portrait.png']]));
  assert.ok(metadata.width < metadata.height);
  assert.ok(Math.abs(metadata.width / metadata.height - 0.5) < 0.02);
  assert.equal(metadata.width % 32, 0); assert.equal(metadata.height % 32, 0);
  assert.throws(() => validateGeneration(input('reference_to_image', ['portrait']), [{ ...source, deletedAt: new Date().toISOString() }]), /unavailable/);
});
