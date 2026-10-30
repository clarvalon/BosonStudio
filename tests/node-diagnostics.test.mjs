import test from 'node:test';
import assert from 'node:assert/strict';
import {nodeDiagnostics,WORKFLOW_NODES} from '../lib/connections.mjs';
test('node diagnostics report server version and distinguish workflow-specific missing requirements',()=>{
 const full=nodeDiagnostics({system:{comfyui_version:'0.43.0'}},{});
 const info=Object.fromEntries(full.workflowChecks.flatMap(check=>check.required).map(name=>[name,{}]));
 const ready=nodeDiagnostics({system:{comfyui_version:'0.43.0'}},info);
 assert.equal(ready.version,'0.43.0');assert.equal(ready.workflowChecks.length,7);assert.equal(ready.missingNodes.length,0);
 delete info.SaveAudio;
 const missing=nodeDiagnostics({},info);
 assert.equal(missing.version,'Unknown');assert.equal(missing.workflowChecks.find(check=>check.mode==='add_audio').ready,false);
 assert.equal(missing.workflowChecks.find(check=>check.mode==='text_to_image').ready,true);
 assert.ok(missing.missingNodes.includes('SaveAudio'));assert.deepEqual(missing.requiredCustomNodePacks,[]);
});
