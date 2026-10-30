// Independent H3 prompt compiler. Public format references are listed in README.
// The creative brief remains separate from the exact text submitted to ComfyUI.
const escapePattern = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const timestamp = seconds => {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
};
const readTime = text => { const match = /^(\d+):(\d+)\.(\d{3})$/.exec(text); return match ? Number(match[1]) * 60 + Number(match[2]) + Number(match[3]) / 1000 : NaN; };

export function normalizeShots(text, duration, { still = false } = {}) {
  let narrative = String(text).trim().replace(/\[\s*shot\s*(\d+)\s*\]/gi, '[Shot $1]').replace(/\bShot\s*(\d+)\s*:/gi, '[Shot $1]');
  narrative = narrative.replace(/\bShot\s*(\d+)\s+(\d+(?:\.\d+)?)s\s*:/gi, (_, shot, time) => `[Shot ${shot}] At ${timestamp(Number(time))},`);
  if (!narrative.includes('[Shot 1]')) narrative = `[Shot 1] ${narrative}`;
  const numbers = [...narrative.matchAll(/\[Shot (\d+)\]/g)].map(match => Number(match[1]));
  if (numbers.some((number, index) => number !== index + 1)) throw new Error('Shot numbers must be sequential, starting at Shot 1.');
  if (still && numbers.length > 1) throw new Error('A still-image prompt must describe one composition, not several video shots.');
  let lastCut = 0;
  narrative = narrative.replace(/\[Shot (\d+)\](\s*At\s+(\d+:\d+\.\d{3}),)?/g, (_, number, supplied, time) => {
    const index = Number(number) - 1;
    if (index === 0) return '[Shot 1]';
    const cut = supplied ? readTime(time) : duration * index / numbers.length;
    if (!(cut > lastCut && cut < duration)) throw new Error(`Shot ${number}'s cut time must increase and fall within the ${duration.toFixed(2)}-second output.`);
    lastCut = cut;
    return `[Shot ${number}] At ${timestamp(cut)},`;
  });
  return { narrative: narrative.replace(/\s*(\[Shot [2-9]\d*\])/g, '\n$1'), finalShot: numbers.length };
}

function parseExisting(text) {
  const names = 'integrated_multimodal_description|subject_definitions|summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music';
  const matches = [...text.matchAll(new RegExp(`^\\s*(${names})\\s*:\\s*`, 'gim'))];
  if (!matches.length) return {};
  return Object.fromEntries(matches.map((match, index) => [match[1].toLowerCase(), text.slice(match.index + match[0].length, matches[index + 1]?.index ?? text.length).trim()]));
}

function logicalSubjects(spec, images) {
  const groups = new Map();
  for (const subject of spec.subjects || []) {
    const key = subject.name.trim().toLocaleLowerCase();
    if (!groups.has(key)) groups.set(key, { ...subject, image_ids: [], number: groups.size + 1 });
    const group = groups.get(key);
    if (subject.retention === 'modify') group.retention = 'modify';
    if (!group.voice_audio_id && subject.voice_audio_id) group.voice_audio_id = subject.voice_audio_id;
    for (const id of subject.image_ids || []) if (!group.image_ids.includes(id)) group.image_ids.push(id);
  }
  if (!groups.size && spec.mode.startsWith('reference_')) images.forEach((asset, index) => groups.set(asset.id, { name: '', description: 'the visual content specified by the creative brief', image_ids: [asset.id], number: index + 1 }));
  return [...groups.values()];
}

function bindNames(text, subjects) {
  // Quoted speech, scene text and already-tagged dialogue must retain their words.
  return text.split(/(<d>[\s\S]*?<\/d>|"[^"\n]*")/g).map((part, index) => {
    if (index % 2) return part;
    for (const subject of [...subjects].filter(subject => subject.name).sort((a, b) => b.name.length - a.name.length)) {
      part = part.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escapePattern(subject.name)}(?![\\p{L}\\p{N}_])`, 'giu'), `<Subject ${subject.number}>`);
    }
    return part;
  }).join('');
}

export function formatDialogue(text, { language = 'English', subjects = [], audioLabels = new Map() } = {}) {
  const speakers = new Map();
  let result = ''; let cursor = 0;
  const spans = /<d>[\s\S]*?<\/d>|"([^"\n]+)"/g;
  for (const match of text.matchAll(spans)) {
    let before = text.slice(cursor, match.index);
    if (match[0].startsWith('<d>')) {
      const existing = [...before.matchAll(/<Subject (\d+)>\s*\((S\d+)\)/g)].at(-1);
      if (existing) {
        speakers.set(`subject-${existing[1]}`, existing[2]);
        const voiceId = subjects.find(subject => subject.number === Number(existing[1]))?.voice_audio_id;
        const label = audioLabels.get(voiceId);
        if (label && !before.includes(label)) before += `using the voice characteristics of ${label}, `;
      }
      result += before + match[0]; cursor = match.index + match[0].length; continue;
    }
    const sentence = before.slice(Math.max(before.lastIndexOf('\n'), before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?')) + 1);
    const speaking = /\b(says?|asks?|replies|whispers?|shouts?|sings?|speaks?|yells?|calls? out)\b[^.?!\n]*$/i.exec(sentence);
    if (!speaking) { result += before + match[0]; cursor = match.index + match[0].length; continue; }
    const subjectMatches = [...sentence.slice(0, speaking.index).matchAll(/<Subject (\d+)>/g)];
    const lastSubject = subjectMatches.at(-1);
    const named = !lastSubject ? subjects.find(subject => subject.name && new RegExp(`\\b${escapePattern(subject.name)}\\b`, 'i').test(sentence)) : null;
    const key = lastSubject ? `subject-${lastSubject[1]}` : named ? `subject-${named.number}` : sentence.slice(0, speaking.index).replace(/\(S\d+\)/g, '').trim().toLowerCase() || 'narrator';
    const explicit = /\((S\d+)\)/.exec(sentence)?.[1];
    if (!speakers.has(key)) speakers.set(key, explicit || `S${speakers.size + 1}`);
    const speaker = speakers.get(key);
    const subject = subjects.find(item => `subject-${item.number}` === key);
    const voice = subject?.voice_audio_id && audioLabels.get(subject.voice_audio_id);
    if (!explicit) {
      if (lastSubject) {
        const offset = before.length - sentence.length + lastSubject.index + lastSubject[0].length;
        before = `${before.slice(0, offset)} (${speaker})${before.slice(offset)}`;
      } else {
        const offset = before.length - sentence.length + speaking.index;
        before = `${before.slice(0, offset)}(${speaker}) ${before.slice(offset)}`;
      }
    }
    if (voice) before += `using the voice characteristics of ${voice}, `;
    const spoken = /^\[([^\]]+)\]\s*([\s\S]*)$/.exec(match[1]);
    result += `${before}<d>[${spoken?.[1] || language}] ${spoken?.[2] ?? match[1]}</d>`;
    cursor = match.index + match[0].length;
  }
  return { text: result + text.slice(cursor), speakers };
}

export function compilePrompt(spec, { frames, fps = 24 } = {}) {
  const simplePrompt = spec.prompt;
  const still = spec.mode.endsWith('_image');
  const reference = spec.mode.startsWith('reference_');
  const effectiveDuration = (frames || Math.ceil((spec.duration * fps - 5) / 17) * 17 + 5) / fps;
  const old = parseExisting(simplePrompt);
  const h3 = spec.h3 || {};
  let body = h3.description || old.detailed_description || old.integrated_multimodal_description || simplePrompt;
  body = body.replace(/^For the target video, at 0\.00 seconds[^\n]*\n*/i, '').replace(/^How the reference pictures align[^\n]*\n*/i, '').replace(/[“”]/g, '"');
  if (spec.mode === 'text_to_image') return { simplePrompt, finalPrompt: body.trim(), format: 'T2I', version: 1 };
  const images = spec.references.filter(asset => asset.kind === 'image');
  const videos = spec.references.filter(asset => asset.kind === 'video');
  const audios = spec.references.filter(asset => asset.kind === 'audio');
  const imageLabels = new Map(images.map((asset, index) => [asset.id, `<Picture ${index + 1}>`]));
  const audioLabels = new Map(audios.map((asset, index) => [asset.id, `<Audio ${index + 1}>`]));
  const subjects = logicalSubjects(spec, images);
  if (reference) body = bindNames(body, subjects);
  const shots = normalizeShots(body, effectiveDuration, { still });
  if (!reference && h3.style) shots.narrative = shots.narrative.replace('[Shot 1]', `[Shot 1] ${h3.style.replace(/[.!]$/, '')}.`);
  const dialogue = formatDialogue(shots.narrative, { language: h3.language || 'English', subjects, audioLabels });
  const sound = still ? 'N/A' : h3.soundscape || old.overall_soundscape || (audios.length ? `${audios.map(asset => audioLabels.get(asset.id)).join(', ')} guides the sound texture and timing; the source signal is not copied.` : 'Ambient environmental sound and synchronized sounds of the described physical actions.');
  const music = still ? 'N/A' : h3.music || old.non_diegetic_music || 'N/A';
  if (!reference) {
    let alignment = '';
    let format = 'T2VA';
    if (spec.mode === 'image_to_video' && images.length === 1) { format = 'I2VA'; alignment = 'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.'; }
    if (spec.mode === 'image_to_video' && images.length === 2) { format = 'FL2VA'; alignment = `How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot ${shots.finalShot}) aligns with the ${effectiveDuration.toFixed(2)}-second mark of the target video.`; }
    const finalPrompt = [alignment, `integrated_multimodal_description: ${dialogue.text}`, `overall_soundscape: ${sound}`, `non_diegetic_music: ${music}`].filter(Boolean).join('\n\n');
    return { simplePrompt, finalPrompt, format, version: 1 };
  }
  const definitions = []; const retention = [];
  for (const subject of subjects) {
    const label = `<Subject ${subject.number}>`;
    const sources = subject.image_ids.map(id => imageLabels.get(id)).filter(Boolean);
    const voice = dialogue.speakers.get(`subject-${subject.number}`);
    definitions.push(`${label}${voice ? ` (${voice})` : ''} is ${subject.name ? `${subject.name}, ` : ''}${subject.description || 'the visible subject specified in the brief'}, referenced from ${sources.join(', ')}.`);
    const marker = { preserve: 'fully_preserved', modify: 'partially_preserved', feature: 'attribute_transfer', style: 'weak_reference' }[subject.retention] || (still ? 'partially_preserved' : 'fully_preserved');
    const appearances = [...dialogue.text.matchAll(/\[Shot (\d+)\]([^]*?)(?=\[Shot \d+\]|$)/g)].filter(match => match[2].includes(label)).map(match => `[Shot ${match[1]}]`);
    retention.push(`${label} (appears in ${appearances.join(', ') || '[Shot 1]'}): ${marker} - Retain the defined characteristics except for changes explicitly requested in the description.`);
  }
  if (still && images[0]) {
    definitions.push('<Picture 1> is the source composition to edit.');
    retention.push('<Picture 1> ([Shot 1] composition): partially_preserved - Change only the requested elements; preserve unrequested composition, objects, lighting and background.');
  }
  for (const [index, asset] of videos.entries()) {
    const detail = spec.reference_details?.find(item => item.id === asset.id);
    definitions.push(`<Video ${index + 1}> provides motion, choreography, camera timing and temporal guidance${detail?.description ? `: ${detail.description}` : ''}. Its incidental people, clothing and environment are not target content.`);
    retention.push(`<Video ${index + 1}>: weak_reference - Follow the requested motion and timing without importing incidental source appearance.`);
  }
  for (const asset of audios) {
    const label = audioLabels.get(asset.id);
    const subject = subjects.find(item => item.voice_audio_id === asset.id);
    const speaker = subject && dialogue.speakers.get(`subject-${subject.number}`);
    definitions.push(`${label} is ${subject ? `voice guidance for <Subject ${subject.number}>${speaker ? ` (${speaker})` : ''}` : 'the sound reference for the requested scene'}.`);
    retention.push(`${label}: reference - Use its requested sound characteristics without promising sample-identical copying.`);
  }
  const tasks = [still ? 'keyframe completion' : 'reference generation', ...(audios.length ? ['audio reference'] : [])];
  const style = h3.style || (still ? 'Create one coherent still-image composition, following the supplied visual references.' : 'Follow the visual style and scene characteristics specified in the creative brief and image references.');
  const finalPrompt = [
    `subject_definitions:\n${definitions.join('\n') || old.subject_definitions || 'None'}`,
    `summary:\n[${tasks.join(' + ')}]`,
    `retention_analysis:\n${retention.join('\n') || old.retention_analysis || 'None'}`,
    `detailed_description:\n${style}\n${dialogue.text}`,
    `overall_soundscape:\n${sound}`, `non_diegetic_music:\n${music}`,
  ].join('\n\n');
  const referenceText = finalPrompt.replace(/<d>[\s\S]*?<\/d>|"[^"\n]*"/g, '');
  for (const match of referenceText.matchAll(/<(Picture|Video|Audio) (\d+)>/g)) {
    const limit = { Picture: images.length, Video: videos.length, Audio: audios.length }[match[1]];
    if (Number(match[2]) < 1 || Number(match[2]) > limit) throw new Error(`Prompt refers to unavailable ${match[1]} ${match[2]}.`);
  }
  return { simplePrompt, finalPrompt, format: still ? 'Ref2VA image' : 'Ref2VA', version: 1 };
}
