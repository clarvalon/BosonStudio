import {spawn} from 'node:child_process';
export function runMedia(binary,args,{timeout=120000}={}){
 return new Promise((resolve,reject)=>{
  const child=spawn(binary,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
  const output=[];let diagnostic='';
  const timer=setTimeout(()=>{child.kill();reject(new Error('Media processing timed out.'));},timeout);
  child.stdout.on('data',chunk=>output.push(chunk));child.stderr.on('data',chunk=>{diagnostic=(diagnostic+chunk).slice(-1200);});
  child.on('error',()=>{clearTimeout(timer);reject(new Error(`${binary} is unavailable. Install FFmpeg and ffprobe for video processing.`));});
  child.on('close',code=>{clearTimeout(timer);code===0?resolve(Buffer.concat(output)):reject(new Error(`Media processing failed (${binary}, exit ${code}). ${diagnostic.slice(-500)}`));});
 });
}
export const ffmpeg=(args,options)=>runMedia(process.env.FFMPEG_PATH||'ffmpeg',['-hide_banner','-loglevel','error',...args],options);
export async function probeMedia(file){
 const data=JSON.parse((await runMedia(process.env.FFPROBE_PATH||'ffprobe',['-v','error','-show_streams','-show_format','-of','json',file])).toString());
 const video=data.streams?.find(stream=>stream.codec_type==='video');
 const audio=data.streams?.find(stream=>stream.codec_type==='audio');
 const [numerator,denominator]=(video?.avg_frame_rate||video?.r_frame_rate||'24/1').split('/').map(Number);
 const fps=denominator?numerator/denominator:24;
 return{width:video?.width,height:video?.height,fps:Number.isFinite(fps)&&fps>0?fps:24,duration:Number(data.format?.duration||video?.duration||audio?.duration),hasAudio:Boolean(audio),frames:Number(video?.nb_frames)||undefined};
}
export const canvasFilter=(width,height)=>`fps=24,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
export async function prepareVideoSource(sourceFile,contextFile,mode,width,height){
 const source=await probeMedia(sourceFile);
 if(!Number.isFinite(source.duration)||source.duration<1)throw new Error('The source video must be at least one second long.');
 if(mode==='add_audio'&&source.duration>15)throw new Error('Add Audio currently supports source videos up to 15 seconds. Trim the clip first.');
 if(mode==='extend_video'&&source.duration>60)throw new Error('Extend Video currently supports source videos up to 60 seconds.');
 const contextFrames=mode==='extend_video'?22:undefined;
 const guideFrames=contextFrames||Math.max(5,Math.ceil((Math.round(source.duration*24)-5)/17)*17+5);
 const start=mode==='extend_video'?Math.max(0,source.duration-22/24):0;
 const args=['-y','-ss',String(start),'-i',sourceFile,'-vf',canvasFilter(width,height)+',tpad=stop_mode=clone:stop_duration=1','-map','0:v:0','-frames:v',String(guideFrames)];
 if(source.hasAudio)args.push('-map','0:a:0','-c:a','aac','-ar','32000','-ac','2');
 else args.push('-an');
 if(contextFrames)args.push('-t',String(22/24));
 args.push('-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p',contextFile);
 await ffmpeg(args);
 return{source,contextFrames};
}
export async function addSoundtrack(sourceFile,audioFile,destination,duration){
 await ffmpeg(['-y','-i',sourceFile,'-i',audioFile,'-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a','192k','-af','apad','-t',String(duration),'-movflags','+faststart',destination]);
}
export async function appendContinuation(sourceFile,generatedFile,destination,{source,width,height,contextFrames}){
 const audio0=source.hasAudio?`[0:a]aresample=32000,aformat=channel_layouts=stereo,apad,atrim=duration=${source.duration},asetpts=PTS-STARTPTS[a0]`:`anullsrc=channel_layout=stereo:sample_rate=32000,atrim=duration=${source.duration},asetpts=PTS-STARTPTS[a0]`;
 const filters=[`[0:v]${canvasFilter(width,height)},setpts=PTS-STARTPTS[v0]`,audio0,`[1:v]trim=start_frame=${contextFrames},setpts=PTS-STARTPTS,${canvasFilter(width,height)}[v1]`,`[1:a]atrim=start=${contextFrames/24},asetpts=PTS-STARTPTS,aresample=32000,aformat=channel_layouts=stereo[a1]`,'[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]'].join(';');
 await ffmpeg(['-y','-i',sourceFile,'-i',generatedFile,'-filter_complex',filters,'-map','[v]','-map','[a]','-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-movflags','+faststart',destination]);
}
export async function endingFrame(file){
 const metadata=await probeMedia(file);
 const bytes=await ffmpeg(['-ss',String(Math.max(0,metadata.duration-.08)),'-i',file,'-frames:v','1','-vf',"scale=w='min(1024,iw)':h=-2",'-f','image2pipe','-vcodec','mjpeg','pipe:1']);
 return{bytes,metadata};
}
export async function mediaToolVersions(){
 const results=await Promise.allSettled([runMedia(process.env.FFMPEG_PATH||'ffmpeg',['-version']),runMedia(process.env.FFPROBE_PATH||'ffprobe',['-version'])]);
 return Object.fromEntries(['ffmpeg','ffprobe'].map((name,index)=>[name,results[index].status==='fulfilled'?results[index].value.toString().split('\n')[0]:null]));
}
