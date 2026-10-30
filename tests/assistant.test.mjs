import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { runAssistant } from '../lib/assistant.mjs';

test('tool failures are shown directly and the assistant is not allowed to silently retry', async t => {
  const requests = [];
  const mock = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    res.setHeader('Content-Type', 'application/json');
    const message = requests.length === 1
      ? { role: 'assistant', tool_calls: [{ id: 'invalid-generation', type: 'function', function: { name: 'create_media', arguments: '{"mode":"text_to_image"}' } }] }
      : { role: 'assistant', content: 'The request could not start because the reference is unavailable.' };
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  t.after(() => { mock.closeAllConnections(); return new Promise(resolve => mock.close(resolve)); });
  const messages = [{ role: 'user', content: 'Generate an image.' }];
  const store = {
    data: { config: { llm: { url: `http://127.0.0.1:${mock.address().port}/v1`, model: 'mock', key: 'private-key' }, comfy: { token: '' } }, assets: [], jobs: [], messages },
    message(role, content, metadata) { messages.push({ role, content, ...metadata }); },
    async save() {},
  };
  let attempts = 0;
  await runAssistant(store, async () => { attempts++; throw new Error('Reference private-key is unavailable.'); });
  assert.equal(attempts, 1);
  assert.equal(requests[1].tool_choice, 'none');
  const directError = messages.find(message => message.code === 'generation_tool_error');
  assert.equal(directError.content, 'Request could not complete: Reference [redacted] is unavailable.');
  assert.equal(directError.error, true);
  assert.ok(!JSON.stringify(messages).includes('private-key'));
});

test('job-status tool returns the recorded error without creating a replacement',async t=>{
 let calls=0;let generated=0;let observed;
 const mock=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=JSON.parse(raw);calls++;
  let message;
  if(calls===1)message={role:'assistant',tool_calls:[{id:'status-check',type:'function',function:{name:'get_job_status',arguments:'{}'}}]};
  else{observed=JSON.parse(body.messages.at(-1).content);message={role:'assistant',content:`Recorded error: ${observed.error}`};}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message}]}));
 });
 await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
 t.after(()=>{mock.closeAllConnections();return new Promise(resolve=>mock.close(resolve));});
 const data={config:{llm:{url:`http://127.0.0.1:${mock.address().port}/v1`,model:'mock',key:''},comfy:{token:''}},assets:[],jobs:[{id:'failed',status:'failed',error:'Actual reference input mismatch'}],messages:[{role:'assistant',content:'Actual reference input mismatch',error:true},{role:'user',content:'What was the error?'}]};
 const store={data,message(role,content,extra){data.messages.push({role,content,...extra});},async save(){}};
 await runAssistant(store,async()=>{generated++;});
 assert.equal(generated,0);assert.equal(observed.status,'failed');assert.equal(observed.error,'Actual reference input mismatch');
 assert.ok(data.messages.at(-1).content.includes(observed.error));
});
