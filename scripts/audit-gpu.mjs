import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createStudio} from '../server.mjs';
const args=process.argv.slice(2);
const argument=(name)=>args.includes(name)?args[args.indexOf(name)+1]:undefined;
const reportPath=argument('--report');
const report=JSON.parse(await readFile(reportPath,'utf8'));
const source=JSON.parse(await readFile(argument('--config'),'utf8'));
const app=await createStudio({directory:report.directory});
await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
app.store.data.config=structuredClone(source.config);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const persist=()=>writeFile(reportPath,JSON.stringify(report,null,2));
try{
 for(const caseId of (argument('--cases')||'text-image,text-video,animate-image,first-last-frames,edit-follow-up,reference-video').split(',')){
  if(report.gpu.some(item=>item.id===caseId&&item.status==='completed'))continue;
  const planned=report.cases.find(item=>item.id===caseId);
  if(!planned?.passed)continue;
  const started=Date.now();const job=app.store.data.jobs.findLast(job=>job.mode===planned.created[0].mode&&!job.deletedAt&&job.status!=='failed'&&job.status!=='cancelled')||await app.createJob(planned.created[0]);
  console.log(JSON.stringify({submitted:caseId,job:job.id,status:job.status,error:job.error}));
  while(['preparing','queued','running'].includes(job.status)&&Date.now()-started<900000){await app.pollJobs();await delay(2500);}
  const result={id:caseId,status:job.status,error:job.error||null,elapsedSeconds:Math.round((Date.now()-started)/1000),metadata:job.metadata,outputs:job.outputIds?.map(id=>{const asset=app.store.data.assets.find(item=>item.id===id);return{id,file:path.join(report.directory,'media',`${id}${asset.extension}`),kind:asset.kind};})||[]};
  report.gpu=report.gpu.filter(item=>item.id!==caseId);report.gpu.push(result);await persist();
  console.log(JSON.stringify({gpu:caseId,status:result.status,error:result.error,elapsedSeconds:result.elapsedSeconds}));
  if(!['completed','failed'].includes(result.status))break;
 }
 report.finishedAt=new Date().toISOString();await persist();
 console.log(JSON.stringify({completed:report.gpu.filter(item=>item.status==='completed').length,total:report.gpu.length,report:reportPath}));
}finally{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));await app.store.pending;}
