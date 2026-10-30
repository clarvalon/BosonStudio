import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createStudio} from '../server.mjs';
import {removeEntry} from '../lib/gallery.mjs';

test('a cancelled/removed job cannot republish results from an in-flight poll',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'boson-race-'));
 let release;let entered;
 const reached=new Promise(resolve=>{entered=resolve;});
 const upstream=http.createServer(async(req,res)=>{
  entered();await new Promise(resolve=>{release=resolve;});
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify({test:{status:{completed:true},outputs:{out:{images:[{filename:'image.png',type:'output'}]}}}}));
 });
 await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
 const app=await createStudio({directory});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{app.server.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise(resolve=>app.server.close(resolve)),new Promise(resolve=>upstream.close(resolve))]);await app.store.pending;await rm(directory,{recursive:true,force:true});});
 app.store.data.config.comfy={url:`http://127.0.0.1:${upstream.address().port}`,token:''};
 const job={id:'test-job',promptId:'test',status:'running',mode:'text_to_image',title:'A result',createdAt:new Date().toISOString()};
 app.store.data.jobs.push(job);
 const polling=app.pollJobs();await reached;
 job.status='cancelled';removeEntry(app.store,'job',job.id);release();await polling;
 assert.equal(job.status,'cancelled');assert.ok(job.deletedAt);assert.equal(app.store.data.assets.length,0);
 assert.ok(!app.store.data.messages.some(message=>message.result));
});

test('an old job survives the queue-to-history completion gap and collects its result',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'boson-handoff-'));
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDFsAAAAASUVORK5CYII=','base64');
 let historyCalls=0;
 const upstream=http.createServer((req,res)=>{
  if(req.url.startsWith('/view?')){res.setHeader('Content-Type','image/png');return res.end(png);}
  res.setHeader('Content-Type','application/json');
  if(req.url==='/queue')return res.end(JSON.stringify({queue_running:[],queue_pending:[]}));
  historyCalls++;
  res.end(JSON.stringify(historyCalls===1?{}:{test:{status:{completed:true},outputs:{out:{images:[{filename:'image.png',type:'output'}]}}}}));
 });
 await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
 const app=await createStudio({directory});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{app.server.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise(resolve=>app.server.close(resolve)),new Promise(resolve=>upstream.close(resolve))]);await app.store.pending;await rm(directory,{recursive:true,force:true});});
 app.store.data.config.comfy={url:`http://127.0.0.1:${upstream.address().port}`,token:''};
 const job={id:'handoff',promptId:'test',status:'running',mode:'text_to_image',title:'Completed output',createdAt:new Date(Date.now()-120000).toISOString(),connection:{...app.store.data.config.comfy}};
 app.store.data.jobs.push(job);await app.pollJobs();
 assert.equal(job.status,'running');assert.ok(job.missingSince);assert.ok(!job.error);
 await app.pollJobs();assert.equal(job.status,'completed');assert.equal(app.store.data.assets.length,1);
});
