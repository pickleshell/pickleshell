import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {loadConfig} from '../src/config.js';
import {BackendClient} from '../src/backend.js';
import {createServer} from '../src/index.js';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'principal-mcp-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'credential');writeFileSync(path,'a'.repeat(64),{mode:0o400});
  return {path, env:{PICKLESHELL_MEMORY_ROLE:'agent',PICKLESHELL_MEMORY_ACTOR:'test',PICKLESHELL_MEMORY_AUDIT_LOG:join(dir,'audit'),PICKLESHELL_MEMORY_PRINCIPAL_CREDENTIAL_FILE:path}};
}

test('principal credential is file-bound, private, and cannot mix backend/admin scope authority',t=>{
  const {path,env}=fixture(t);const c=loadConfig(env);
  assert.equal(c.backendUrl,'http://127.0.0.1:8767');assert.equal(c.backendToken,null);assert.equal(c.principalToken,'a'.repeat(64));
  for(const extra of [{PICKLESHELL_MEMORY_ROLE:'admin'},{PICKLESHELL_MEMORY_SCOPE:'codex-bos-v1'},{PICKLESHELL_MEMORY_BACKEND_TOKEN:'backend-secret'},{PICKLESHELL_MEMORY_BACKEND_URL:'https://example.test'}])assert.throws(()=>loadConfig({...env,...extra}));
  chmodSync(path,0o644);assert.throws(()=>loadConfig(env),/credential/);chmodSync(path,0o400);
  symlinkSync(path,path+'.link');assert.throws(()=>loadConfig({...env,PICKLESHELL_MEMORY_PRINCIPAL_CREDENTIAL_FILE:path+'.link'}),/credential/);
  assert.throws(()=>loadConfig({...env,PICKLESHELL_MEMORY_PRINCIPAL_CREDENTIAL_FILE:path+'.missing'}),/credential/);
});

test('principal transport sends only target and principal credential; redirects disabled',async t=>{
  const {env}=fixture(t);const calls=[];
  const backend=new BackendClient(loadConfig(env),async(url,init)=>{calls.push({url:String(url),init});return new Response('{}');});
  await backend.call({method:'POST',path:'/search',body:['query']},'shared/project/pickleshell',{query:'q',principal:'forged',user_id:'raw'});
  await backend.call({method:'GET',path:'/memories/{memory_id}'},'private',{memory_id:'m1'});
  await backend.discover();
  assert.deepEqual(JSON.parse(calls[0].init.body),{query:'q',target:'shared/project/pickleshell'});
  assert.equal(calls[1].url,'http://127.0.0.1:8767/memories/m1?target=private');
  for(const {init} of calls){assert.equal(init.headers.authorization,'Bearer '+'a'.repeat(64));assert.equal(init.redirect,'error');}
});

test('agent MCP exposes safe target, denies raw identity fields before forwarding, discovers broker principal',async t=>{
  const {env}=fixture(t);const c=loadConfig(env);const calls=[],events=[];
  const backend={call:async(...args)=>{calls.push(args);return {results:[]};},discover:async()=>({status:'ok',broker:{principal:'opencode',targets:[{target:'private',read:true,write:true,token:'secret'},{target:'shared/project/pickleshell',read:true,write:false}],token:'secret'}})};
  const server=createServer(c,backend,{record:e=>events.push(e)});const client=new Client({name:'test',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);t.after(()=>client.close());
  const {tools}=await client.listTools();const schema=tools.find(x=>x.name==='memory_search').inputSchema;
  assert('target' in schema.properties);assert(!('user_id' in schema.properties));assert(!('principal' in schema.properties));
  for(const field of ['user_id','principal','scope','namespace','agent_id','actor']) {
    const r=await client.callTool({name:'memory_search',arguments:{query:'x',[field]:'other'}});assert(r.isError);
  }
  assert.equal(calls.length,0);assert(events.every(e=>e.decision==='denied'));
  assert(!(await client.callTool({name:'memory_search',arguments:{query:'x',target:'shared/project/pickleshell'}})).isError);
  assert.equal(calls[0][1],'shared/project/pickleshell');
  const caps=JSON.parse((await client.callTool({name:'memory_capabilities',arguments:{}})).content[0].text);
  assert.equal(caps.principal,'opencode');assert.equal(caps.targets[1].write,false);assert(!JSON.stringify(caps).includes('secret'));
});
