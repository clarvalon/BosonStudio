import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ffmpeg,probeMedia,addSoundtrack,appendContinuation,prepareVideoSource,mediaToolVersions} from '../lib/media.mjs';
test('Add Audio preserves the encoded video and extension keeps the source before appending',async t=>{
 const tools=await mediaToolVersions();if(!tools.ffmpeg||!tools.ffprobe){t.skip('FFmpeg/ffprobe are required for media integration checks.');return;}
 const directory=await mkdtemp(path.join(os.tmpdir(),'boson-media-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const source=path.join(directory,'source.mp4'),audio=path.join(directory,'audio.flac'),generated=path.join(directory,'generated.mp4'),soundtrack=path.join(directory,'soundtrack.mp4'),extended=path.join(directory,'extended.mp4'),context=path.join(directory,'context.mp4');
 await ffmpeg(['-y','-f','lavfi','-i','color=c=red:s=160x96:r=24:d=2','-c:v','libx264','-pix_fmt','yuv420p',source]);
 await ffmpeg(['-y','-f','lavfi','-i','sine=frequency=600:duration=3',audio]);
 await ffmpeg(['-y','-f','lavfi','-i','color=c=blue:s=160x96:r=24:d=3','-f','lavfi','-i','sine=frequency=400:duration=3','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',generated]);
 const original=await probeMedia(source);
 await addSoundtrack(source,audio,soundtrack,original.duration);
 const hash=async file=>(await ffmpeg(['-i',file,'-map','0:v:0','-c:v','copy','-f','hash','pipe:1'])).toString();
 assert.equal(await hash(source),await hash(soundtrack));assert.equal((await probeMedia(soundtrack)).hasAudio,true);
 await prepareVideoSource(source,context,'add_audio',160,96);
 const guide=await probeMedia(context);assert.equal(guide.frames%17,5);
 await appendContinuation(source,generated,extended,{source:original,width:160,height:96,contextFrames:22});
 const measured=await probeMedia(extended);assert.ok(measured.duration>4&&measured.duration<4.4);assert.equal(measured.hasAudio,true);
 const pixel=async time=>ffmpeg(['-ss',String(time),'-i',extended,'-frames:v','1','-vf','scale=1:1','-f','rawvideo','-pix_fmt','rgb24','pipe:1']);
 const first=await pixel(.5),last=await pixel(3);
 assert.ok(first[0]>first[2]);assert.ok(last[2]>last[0]);
});
