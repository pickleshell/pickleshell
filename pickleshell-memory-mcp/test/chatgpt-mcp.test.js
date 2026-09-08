import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {loadChatGPTConfig} from '../src/chatgpt-config.js';
import {loadConfig} from '../src/config.js';
import {createServer} from '../src/index.js';
import {BackendClient} from '../src/backend.js';

function config(t, mode='normal') {
  const dir=mkdtempSync(join(tmpdir(),'chatgpt-memory-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const credential=join(dir,'credential'), audit=join(dir,'audit');
  writeFileSync(credential,'c'.repeat(64),{mode:0o400});
  return {args:[credential,audit,mode], value:loadChatGPTConfig([credential,audit,mode],{})};
}
async function connect(t,c,fetchImpl) {
  const requests=[],events=[];
  const server=createServer(c,new BackendClient(c,async(url,init)=>{
    requests.push({url:String(url),init});return fetchImpl(url,init);
  }),{record:e=>events.push(e)});
  const client=new Client({name:'chatgpt-test',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
  t.after(()=>client.close());return {client,requests,events};
}

test('ChatGPT launch pins broker and rejects bearer/direct backend configurations',t=>{
  const {args,value}=config(t);
  assert.equal(value.backendUrl,'http://127.0.0.1:8767');assert.equal(value.backendToken,null);
  const forged=loadChatGPTConfig(args,{PICKLESHELL_MEMORY_ROLE:'admin',PICKLESHELL_MEMORY_EXPOSE_ADMIN:'1',PICKLESHELL_MEMORY_BACKEND_URL:'http://127.0.0.1:8766',PICKLESHELL_MEMORY_SCOPE:'evil'});
  assert.equal(forged.backendUrl,value.backendUrl);assert.equal(forged.exposeAdmin,false);assert.equal(forged.role,'agent');
  assert.throws(()=>loadChatGPTConfig(args,{PICKLESHELL_MEMORY_BACKEND_TOKEN:'secret'}));
  assert.throws(()=>loadChatGPTConfig([...args,'extra'],{}));
  assert.throws(()=>loadChatGPTConfig([args[0],args[1],'owner'],{}));
  assert.throws(()=>loadChatGPTConfig(['',args[1]],{}));
  assert.throws(()=>loadConfig({PICKLESHELL_MEMORY_ROLE:'agent',PICKLESHELL_MEMORY_ACTOR:'test',PICKLESHELL_MEMORY_AUDIT_LOG:args[1],PICKLESHELL_MEMORY_PRINCIPAL_CREDENTIAL_FILE:args[0],PICKLESHELL_MEMORY_BACKEND_URL:'http://127.0.0.1:8766'}));
});

test('normal listing has nine normal tools and no administrative schemas',async t=>{
  const {value}=config(t);const {client}=await connect(t,value,()=>new Response('{}'));
  const {tools}=await client.listTools();assert.equal(tools.length,9);
  assert(tools.some(t=>t.name==='memory_list_targets'));
  assert(!tools.some(t=>t.name.startsWith('memory_admin_')));
  for(const tool of tools) for(const key of ['principal','user_id','scope','role']) assert(!(key in (tool.inputSchema.properties||{})));
});

test('admin schemas use aliases; injected identities rejected for every tool before broker',async t=>{
  const {value}=config(t,'admin');const {client,requests}=await connect(t,value,()=>new Response('{}'));
  const {tools}=await client.listTools();assert.equal(tools.length,18);
  for(const tool of tools){
    const args={};
    for(const key of tool.inputSchema.required||[]) args[key]=key==='target'?'private/operator':key==='subject'?'operator':'id';
    for(const field of ['principal','user_id','role','scope']) {
      const r=await client.callTool({name:tool.name,arguments:{...args,[field]:'forged'}});
      assert(r.isError,tool.name+' accepted '+field);
    }
  }
  assert.equal(requests.length,0);
});

test('admin schema exposure cannot grant broker authority; structured denial is audited',async t=>{
  const {value}=config(t,'admin');const {client,requests,events}=await connect(t,value,()=>new Response('{"error":"admin_required"}',{status:403}));
  const r=await client.callTool({name:'memory_admin_status',arguments:{}});
  assert(r.isError);assert.equal(JSON.parse(r.content[0].text).error,'admin_required');
  assert.equal(requests[0].url,'http://127.0.0.1:8767/management/admin_status');
  assert.deepEqual(JSON.parse(requests[0].init.body),{});
  assert.equal(events[0].outcome,'error');
  assert(!JSON.stringify(r).includes(value.principalToken));
});

test('administrative delete is single-target and audit failure reports uncertain outcome',async t=>{
  const {value}=config(t,'admin');const {client,requests}=await connect(t,value,()=>new Response('{"deleted":true}'));
  const r=await client.callTool({name:'memory_admin_delete',arguments:{target:'private/operator',memory_id:'m1',confirm_memory_id:'m1'}});
  assert(!r.isError);assert.deepEqual(JSON.parse(requests[0].init.body),{target:'private/operator',memory_id:'m1',confirm_memory_id:'m1'});
  const {MemoryService}=await import('../src/service.js');
  const service=new MemoryService(value,{call:async()=>({deleted:true})},{record:()=>{throw Error('audit unavailable');}});
  const result=await service.call('memory_admin_delete',{target:'private/operator',memory_id:'m1',confirm_memory_id:'m1'});
  assert.equal(JSON.parse(result.content[0].text).mutation_outcome,'uncertain');
});

test('actual ChatGPT stdio entrypoint lists normal/admin surfaces without backend contact',async t=>{
  const {StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
  for(const mode of ['normal','admin']) {
    const {args}=config(t,mode);
    const client=new Client({name:'chatgpt-launch-test',version:'1'});
    try {
      await client.connect(new StdioClientTransport({command:process.execPath,
        args:[new URL('../src/chatgpt.js',import.meta.url).pathname,...args],
        env:{PATH:process.env.PATH}}));
      const {tools}=await client.listTools();
      assert.equal(tools.length,mode==='normal'?9:18);
    } finally {await client.close();}
  }
});
