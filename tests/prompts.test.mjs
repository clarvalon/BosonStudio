import test from 'node:test';
import assert from 'node:assert/strict';
import {compilePrompt,normalizeShots,formatDialogue} from '../lib/prompts.mjs';
import {validateGeneration,buildWorkflow} from '../lib/workflows.mjs';
const images=[{id:'first',kind:'image',metadata:{width:1024,height:1024}},{id:'last',kind:'image',metadata:{width:1024,height:1024}}];
const voice={id:'voice',kind:'audio'};
const spec=(mode,references=[],extra={})=>({mode,prompt:'A simple creative brief.',duration:5,references,...extra});
test('base H3 modes get the correct fields and keyframe alignment',()=>{
 const text=compilePrompt(spec('text_to_video'),{frames:124});
 assert.ok(text.finalPrompt.startsWith('integrated_multimodal_description: [Shot 1]'));
 assert.ok(!text.finalPrompt.includes('subject_definitions:'));
 assert.ok(text.finalPrompt.includes('overall_soundscape:'));
 const first=compilePrompt(spec('image_to_video',[images[0]]),{frames:124});
 assert.equal(first.format,'I2VA');assert.ok(first.finalPrompt.startsWith('For the target video, at 0.00 seconds'));
 const both=compilePrompt(spec('image_to_video',images),{frames:124});
 assert.equal(both.format,'FL2VA');assert.match(both.finalPrompt,/Picture 2 \(from Shot 1\) aligns with the 5\.17-second mark/);
 assert.equal(both.simplePrompt,'A simple creative brief.');
});
test('reference compiler groups pictures into logical subjects and preserves names inside speech',()=>{
 const compiled=compilePrompt(spec('reference_to_video',[...images,voice],{
  prompt:'Alex says "Hello, Alex!" A sign reads "OPEN".',
  subjects:[{name:'Alex',description:'a person in a green shirt',image_ids:['first'],retention:'preserve',voice_audio_id:'voice'},{name:'alex',description:'another view',image_ids:['last']}],
 }),{frames:124});
 const final=compiled.finalPrompt;
 const headings=[...final.matchAll(/^(\w+):/gm)].map(match=>match[1]);
 assert.deepEqual(headings,['subject_definitions','summary','retention_analysis','detailed_description','overall_soundscape','non_diegetic_music']);
 assert.match(final,/<Subject 1> \(S1\) is Alex/);assert.ok(!final.includes('<Subject 2>'));
 assert.match(final,/referenced from <Picture 1>, <Picture 2>/);
 assert.match(final,/<d>\[English\] Hello, Alex!<\/d>/);
 assert.ok(final.includes('A sign reads "OPEN"'));assert.ok(!final.includes('[English] OPEN'));
 assert.match(final,/<Audio 1> is voice guidance for <Subject 1> \(S1\)/);
 assert.match(final,/using the voice characteristics of <Audio 1>/);
});
test('one source picture can define several named subjects and recipients do not become speakers',()=>{
 const final=compilePrompt(spec('reference_to_image',[images[0]],{
  prompt:'Malley says to Mummy "Hello, Mummy!" Mummy replies "Bonjour."',
  subjects:[{name:'Malley',image_ids:['first'],description:'the man in glasses',retention:'modify'},{name:'Mummy',image_ids:['first'],description:'the woman beside him'}],
  h3:{language:'French'},
 }),{frames:5}).finalPrompt;
 assert.match(final,/<Subject 1> \(S1\) is Malley/);assert.match(final,/<Subject 2> \(S2\) is Mummy/);
 assert.match(final,/<d>\[French\] Hello, Mummy!<\/d>/);
 assert.match(final,/partially_preserved/);assert.match(final,/overall_soundscape:\nN\/A/);
});
test('shot cuts are added or validated without duplicating existing H3 fields',()=>{
 const result=normalizeShots('[Shot 1] Opening. [Shot 2] Closing.',6);
 assert.ok(result.narrative.includes('[Shot 2] At 00:03.000,'));
 assert.throws(()=>normalizeShots('[Shot 1] A. [Shot 2] At 00:09.000, B.',6),/cut time/);
 const final=compilePrompt(spec('text_to_video',[],{prompt:'integrated_multimodal_description: [Shot 1] A boat.\n\noverall_soundscape: Quiet water.\n\nnon_diegetic_music: N/A'}),{frames:124}).finalPrompt;
 assert.equal((final.match(/integrated_multimodal_description:/g)||[]).length,1);
 assert.match(final,/overall_soundscape: Quiet water\./);
});
test('supplied dialogue tags remain intact and unknown reference labels are rejected',()=>{
 const tagged=formatDialogue('<Subject 1> (S1) says <d>[Spanish] ¡Hola!</d>');
 assert.equal(tagged.speakers.get('subject-1'),'S1');assert.equal((tagged.text.match(/<d>/g)||[]).length,1);
 assert.throws(()=>compilePrompt(spec('reference_to_image',[images[0]],{prompt:'Use <Picture 9>.'}),{frames:5}),/unavailable Picture 9/);
 assert.doesNotThrow(()=>compilePrompt(spec('reference_to_video',[images[0]],{prompt:'The person says "The token is <Picture 9>." A sign reads "<Audio 7>".'}),{frames:124}));
});
test('the exact compiled prompt is sent to the H3 node and remains separate from the brief',()=>{
 const validated=validateGeneration({mode:'reference_to_image',prompt:'Make his shirt green.',asset_ids:['first'],aspect_ratio:'source',h3:{description:'Change the shirt in <Picture 1> to green; preserve the other details.'}},images);
 const models={videoModel:'base',referenceModel:'reference',textEncoder:'text',videoVae:'video',audioVae:'audio'};
 const {graph,prompts,metadata}=buildWorkflow(validated,models,new Map([['first','first.png']]));
 const node=Object.values(graph).find(node=>node.class_type==='MiniMaxH3ReferenceToVideo');
 assert.equal(node.inputs.prompt,prompts.finalPrompt);assert.equal(prompts.simplePrompt,'Make his shirt green.');
 assert.notEqual(prompts.simplePrompt,prompts.finalPrompt);assert.equal(metadata.promptFormat,'Ref2VA image');
});
