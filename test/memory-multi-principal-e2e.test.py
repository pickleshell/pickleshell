"""Isolated real backend + broker + independent stdio MCP clients. No live ports/data."""
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'pickleshell-memory-broker'))
from pickleshell_memory_broker.server import BoundedHTTPServer,BrokerHandler
from pickleshell_memory_broker.policy import load_policy


def free_port():
    with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]


class RealSharedMemory(unittest.TestCase):
    def test_independent_principals_vector_search_and_isolation(self):
        with tempfile.TemporaryDirectory(prefix='memory-principals-e2e-') as temp:
            temp=Path(temp);(temp/'data').mkdir(mode=0o700);backend_port=free_port();backend_token=secrets.token_urlsafe(48)
            self.assertNotIn(backend_port,[8765,8766,8767])
            env={**os.environ,'PYTHONPATH':os.pathsep.join(map(str,[ROOT/'test',ROOT/'pickleshell-memory-backend/test',ROOT/'pickleshell-memory-backend'])),
                 'PICKLESHELL_MEMORY_BACKEND_HOST':'127.0.0.1','PICKLESHELL_MEMORY_BACKEND_PORT':str(backend_port),'PICKLESHELL_MEMORY_BACKEND_TOKEN':backend_token,
                 'MEM0_DATA_DIR':str(temp/'data'),'MEM0_LLM_PROVIDER':'ollama','MEM0_LLM_MODEL':'fixture','MEM0_LLM_BASE_URL':'http://127.0.0.1:9',
                 'MEM0_EMBED_PROVIDER':'ollama','MEM0_EMBED_MODEL':'fixture','MEM0_EMBED_BASE_URL':'http://127.0.0.1:9','MEM0_EMBEDDING_DIMS':'32'}
            log=open(temp/'backend.log','w')
            proc=subprocess.Popen([str(ROOT/'pickleshell-memory-backend/.venv/bin/python'),'-m','uvicorn','memory_multi_principal_backend:app','--host','127.0.0.1','--port',str(backend_port),'--no-access-log','--log-level','warning'],env=env,stdout=log,stderr=log)
            broker=None
            try:
                for _ in range(200):
                    if proc.poll() is not None:self.fail((temp/'backend.log').read_text())
                    try:
                        c=http.client.HTTPConnection('127.0.0.1',backend_port,timeout=.2);c.request('GET','/health',headers={'Authorization':'Bearer '+backend_token});r=c.getresponse();ready=r.status==200;r.read();c.close()
                        if ready:break
                    except OSError:pass
                    time.sleep(.05)
                else:self.fail('isolated backend readiness timeout')
                principals=[]
                for name in ['codex','opencode','reader','operator']:
                    token=secrets.token_urlsafe(48);p=temp/name;p.write_text(token);p.chmod(0o400)
                    self.assertNotEqual(token,backend_token)
                    principals.append({'name':name,'token_sha256':hashlib.sha256(token.encode()).hexdigest(),'private_scope':'codex-bos-v1' if name=='codex' else 'agent:'+name+':bos-v1','shared':{'shared/project/pickleshell':{'scope':'project:pickleshell:shared','read':True,'write':name!='reader'}}})
                principals[-1].update(role='admin', admin_targets={
                    'private/codex': {'read': True, 'delete': True},
                    'shared/project/pickleshell': {'read': True, 'delete': False}})
                policy=temp/'policy.json';policy.write_text(json.dumps({'version':1,'principals':principals}));policy.chmod(0o600)
                broker=BoundedHTTPServer(('127.0.0.1',0),BrokerHandler);broker.broker_config=(None,None,f'http://127.0.0.1:{backend_port}',backend_token);broker.principal_policy=load_policy(policy)
                self.assertNotIn(broker.server_port,[8765,8766,8767]);threading.Thread(target=broker.serve_forever,daemon=True).start()
                def client(name,operations=None,discover=None):
                    request={'credential':str(temp/name),'url':f'http://127.0.0.1:{broker.server_port}','audit':str(temp/(name+'.audit')),'operations':operations,'discover':discover,'exposeAdmin':True}
                    childenv={k:v for k,v in os.environ.items() if not k.startswith(('PICKLESHELL_MEMORY_','MEM0_'))}
                    result=subprocess.run(['node',str(ROOT/'test/memory-principal-client.mjs')],input=json.dumps(request),text=True,capture_output=True,env=childenv,timeout=30)
                    self.assertEqual(result.returncode,0,result.stderr);self.assertNotIn(backend_token,result.stdout+result.stderr);return json.loads(result.stdout)
                def op(name,**args):return {'name':name,'arguments':args}
                def ok(name,operation):
                    r=client(name,[operation])[0];self.assertFalse(r['error'],r);return r['value']
                unknown=temp/'unknown';unknown.write_text(secrets.token_urlsafe(48));unknown.chmod(0o400)
                rejected=client('unknown',[op('memory_search',query='project knowledge')])[0]
                self.assertTrue(rejected['error']);self.assertEqual(rejected['value']['status'],401)
                for name in ('codex','opencode'):
                    self.assertEqual(ok(name,op('memory_capabilities'))['principal'],name)
                    for field in ('user_id','principal','namespace','scope','agent_id'):
                        denied=client(name,[op('memory_search',query='project knowledge',**{field:'forged'})])[0]
                        self.assertTrue(denied['error']);self.assertEqual(denied['value']['status'],403)
                print('PASS actual MCP/broker/backend path: unknown credential 401, both principals reject all raw identity/scope overrides')
                target='shared/project/pickleshell';marker='DISPOSABLE_MULTI_PRINCIPAL_A_71b9'
                shared=ok('codex',op('memory_add',target=target,infer=False,text='One broker endpoint authenticates agents with credential digests so runtimes share project knowledge. '+marker))['results'][0]['id']
                distractor=ok('codex',op('memory_add',target=target,infer=False,text='Garden soil and plants need water. Disposable unrelated fact.'))['results'][0]['id']
                codex_private=ok('codex',op('memory_add',infer=False,text='Private Codex personal secret disposable.'))['results'][0]['id']
                opencode_private=ok('opencode',op('memory_add',infer=False,text='Private OpenCode personal secret disposable.'))['results'][0]['id']
                self.assertEqual(ok('codex',op('memory_get',target=target,memory_id=shared))['id'],shared)
                self.assertIn(shared,[r['id'] for r in ok('codex',op('memory_search',target=target,query='agent shared project broker',limit=3))['results']])
                query='How can runtimes collaborate using an authenticated gateway for project knowledge?'
                self.assertNotIn(marker,query);self.assertNotIn(shared,query)
                b=client('opencode',discover={'query':query,'target':target})
                self.assertEqual(b[0]['value']['results'][0]['id'],shared)
                self.assertGreater(b[0]['value']['results'][0]['score'],.7)
                self.assertIn(marker,b[1]['value']['memory'])
                print('PASS independent OpenCode principal: semantic query only -> vector search -> returned ID -> get Codex shared marker; distractor excluded')
                self.assertEqual(ok('codex',op('memory_get',memory_id=codex_private))['user_id'],'codex-bos-v1')
                for name,foreign in [('opencode',codex_private),('codex',opencode_private)]:
                    for tool in ('memory_get','memory_history','memory_update','memory_delete'):
                        args={'memory_id':foreign};args.update({'text':'denied'} if tool=='memory_update' else {})
                        r=client(name,[op(tool,**args)])[0];self.assertTrue(r['error']);self.assertEqual(r['value']['status'],404)
                    r=client(name,[op('memory_get',target=target,memory_id=foreign)])[0];self.assertTrue(r['error']);self.assertEqual(r['value']['status'],404)
                print('PASS cross-private get/history/update/delete denied both directions, including known IDs via shared target')
                self.assertEqual(ok('reader',op('memory_get',target=target,memory_id=shared))['id'],shared)
                denied=client('reader',[op('memory_update',target=target,memory_id=shared,text='denied')])[0];self.assertTrue(denied['error']);self.assertEqual(denied['value']['status'],403)
                ok('opencode',op('memory_update',target=target,memory_id=shared,text='Updated shared project broker knowledge '+marker))
                self.assertIn('Updated',ok('codex',op('memory_get',target=target,memory_id=shared))['memory'])
                # ChatGPT administration follows the same independent stdio/broker path.
                self.assertEqual(ok('operator',op('memory_capabilities'))['role'],'admin')
                self.assertEqual(ok('operator',op('memory_admin_status'))['backend_health'],'ok')
                self.assertFalse(ok('operator',op('memory_admin_policy'))['policy_mutation_supported'])
                self.assertEqual(len(ok('operator',op('memory_admin_principals'))['principals']),4)
                self.assertEqual(ok('operator',op('memory_admin_get',target='private/codex',memory_id=codex_private))['id'],codex_private)
                for tool,args in [('memory_admin_status',{}),('memory_admin_get',{'target':'private/codex','memory_id':codex_private})]:
                    r=client('codex',[op(tool,**args)])[0]
                    self.assertEqual(r['value']['error'],'admin_required')
                for admin_target,mid in [('private/opencode',opencode_private),('private/codex',opencode_private)]:
                    r=client('operator',[op('memory_admin_get',target=admin_target,memory_id=mid)])[0]
                    self.assertTrue(r['error'])
                found=ok('operator',op('memory_admin_search',target='private/codex',query='private secret'))
                self.assertIn(codex_private,[m['id'] for m in found['results']])
                denied=client('operator',[op('memory_admin_search',target='private/opencode',query='private secret')])[0]
                self.assertEqual(denied['value']['error'],'target_not_allowed')
                shared_found=ok('operator',op('memory_admin_search',target=target,query=query))
                self.assertIn(shared,[m['id'] for m in shared_found['results']])
                denied=client('operator',[op('memory_admin_delete',target='private/codex',memory_id=opencode_private,confirm_memory_id=opencode_private)])[0]
                self.assertEqual(denied['value']['error'],'memory_not_found')
                self.assertEqual(ok('opencode',op('memory_get',memory_id=opencode_private))['id'],opencode_private)
                disposable=ok('codex',op('memory_add',text='Disposable private administration record',infer=False))['results'][0]['id']
                for args in [dict(target=target,memory_id=shared,confirm_memory_id=shared),
                             dict(target='private/codex',memory_id=disposable,confirm_memory_id='wrong')]:
                    self.assertTrue(client('operator',[op('memory_admin_delete',**args)])[0]['error'])
                ok('operator',op('memory_admin_delete',target='private/codex',memory_id=disposable,confirm_memory_id=disposable))
                self.assertEqual(client('codex',[op('memory_get',memory_id=disposable)])[0]['value']['error'],'memory_not_found')
                events=[json.loads(line) for line in (temp/'operator.audit').read_text().splitlines()]
                self.assertTrue(any(e['tool']=='memory_admin_delete' and e['outcome']=='ok' for e in events))
                # Complete normal private lifecycle, including history, via independent clients.
                ok('codex',op('memory_update',memory_id=codex_private,text='Updated private secret'))
                self.assertTrue(ok('codex',op('memory_history',memory_id=codex_private))['results'])
                self.assertEqual(ok('codex',op('memory_list_targets'))['targets'][0]['scope'],'codex-bos-v1')
                print('PASS broker-authorized administration, private lifecycle/history and explicit single-record admin deletion')
                for name,id_,which in [('codex',shared,target),('opencode',distractor,target),('codex',codex_private,'private'),('opencode',opencode_private,'private')]:
                    ok(name,op('memory_delete',target=which,memory_id=id_))
                    r=client(name,[op('memory_get',target=which,memory_id=id_)])[0];self.assertTrue(r['error']);self.assertEqual(r['value']['status'],404)
                for name in ('codex','opencode'):
                    self.assertEqual(ok(name,op('memory_search',target=target,query=query,limit=5))['results'],[])
                    self.assertEqual(ok(name,op('memory_search',query='private secret',limit=5))['results'],[])
                print('PASS explicit shared write/read-only policy, codex-bos-v1 compatibility, all four disposable records deleted and searches empty')
                print('PASS one broker endpoint for every principal; backend credential absent from MCP environments/results')
            finally:
                if broker:broker.shutdown();broker.server_close()
                proc.terminate();proc.wait(timeout=10);log.close()


if __name__=='__main__':unittest.main()
