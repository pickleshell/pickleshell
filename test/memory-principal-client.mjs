// A new independent MCP client and MCP server process for every invocation.
import {Client} from '../pickleshell-memory-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import {StdioClientTransport} from '../pickleshell-memory-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
let input='';for await(const chunk of process.stdin)input+=chunk;
const {credential, url, audit, operations, discover}=JSON.parse(input);
const env={PATH:process.env.PATH,PICKLESHELL_MEMORY_ROLE:'agent',PICKLESHELL_MEMORY_ACTOR:'fixture-client',PICKLESHELL_MEMORY_PRINCIPAL_CREDENTIAL_FILE:credential,PICKLESHELL_MEMORY_AUDIT_LOG:audit,PICKLESHELL_MEMORY_BACKEND_URL:url};
if (process.env.PICKLESHELL_MEMORY_BACKEND_TOKEN) throw new Error('Backend credential reached client');
const client=new Client({name:'independent-principal-client',version:'1'});
try {
 await client.connect(new StdioClientTransport({command:process.execPath,args:[new URL('../pickleshell-memory-mcp/src/index.js',import.meta.url).pathname],env}));
 const unpack=r=>({error:!!r.isError,value:JSON.parse(r.content[0].text)});
 const results=[];
 for(const op of operations||[])results.push(unpack(await client.callTool(op)));
 if(discover){
   // No transcript, marker, raw scope or memory ID is supplied to this client.
   const found=unpack(await client.callTool({name:'memory_search',arguments:{query:discover.query,target:discover.target,limit:1}}));
   results.push(found);
   if(!found.error && found.value.results[0])results.push(unpack(await client.callTool({name:'memory_get',arguments:{memory_id:found.value.results[0].id,target:discover.target}})));
 }
 console.log(JSON.stringify(results));
}finally{await client.close();}
