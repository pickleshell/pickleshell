import copy
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'pickleshell-memory-broker'))
from pickleshell_memory_broker.policy import PrincipalPolicy, load_policy
from pickleshell_memory_broker.server import BrokerHandler, BoundedHTTPServer, config
spec = importlib.util.spec_from_file_location('legacy_tests', ROOT / 'test/memory-broker.test.py')
legacy = importlib.util.module_from_spec(spec); spec.loader.exec_module(legacy)
TOKENS = {name: hashlib.sha256(name.encode()).hexdigest() for name in ('codex', 'opencode', 'reader')}


def document():
    return {'version': 1, 'principals': [
        {'name': name, 'token_sha256': hashlib.sha256(token.encode()).hexdigest(),
         'private_scope': 'codex-bos-v1' if name == 'codex' else f'agent:{name}:bos-v1',
         'shared': {'shared/project/pickleshell': {'scope': 'project:pickleshell:shared', 'read': True, 'write': name != 'reader'}}}
        for name, token in TOKENS.items()]}


class PolicyTests(unittest.TestCase):
    def test_identity_and_explicit_permissions(self):
        policy = PrincipalPolicy(document())
        for name, token in TOKENS.items():
            p = policy.authenticate('Bearer ' + token)
            self.assertEqual(p['name'], name)
            self.assertEqual(policy.resolve(p, 'shared/project/pickleshell', False), 'project:pickleshell:shared')
            self.assertEqual(policy.resolve(p, 'shared/project/pickleshell', True) is not None, name != 'reader')
        self.assertIsNone(policy.authenticate('Bearer ' + 'x' * 64))
        self.assertIsNone(policy.authenticate(None))
        self.assertEqual(policy.resolve(policy.authenticate('Bearer '+TOKENS['codex']), 'private', False), 'codex-bos-v1')

    def test_malformed_duplicate_and_conflicting_policies(self):
        mutations = [
            lambda d: d.update(version=True),
            lambda d: d.update(principals=[]),
            lambda d: d.update(backend_token='forbidden'),
            lambda d: d['principals'].append(copy.deepcopy(d['principals'][0])),
            lambda d: d['principals'][1].update(token_sha256=d['principals'][0]['token_sha256']),
            lambda d: d['principals'][1].update(private_scope='codex-bos-v1'),
            lambda d: d['principals'][1]['shared']['shared/project/pickleshell'].update(scope='different'),
            lambda d: d['principals'][0].update(private_scope='project:pickleshell:shared'),
            lambda d: d['principals'][0]['shared']['shared/project/pickleshell'].update(read=1),
            lambda d: d['principals'][0]['shared']['shared/project/pickleshell'].pop('write'),
            lambda d: d['principals'][0]['shared'].update({'shared/alias': {'scope':'project:pickleshell:shared','read':True,'write':True}}),
        ]
        for mutate in mutations:
            d = document(); mutate(d)
            with self.subTest(document=d), self.assertRaises(ValueError): PrincipalPolicy(d)

    def test_policy_file_modes_owner_symlink_and_duplicate_json(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)/'policy.json'; path.write_text(json.dumps(document())); path.chmod(0o600)
            load_policy(path)
            for mode in (0o644, 0o640, 0o666):
                path.chmod(mode)
                with self.assertRaises(ValueError): load_policy(path)
            path.chmod(0o600)
            info = path.stat()
            class WrongOwner:
                st_mode=info.st_mode
                st_uid=1234567
            with patch('pickleshell_memory_broker.policy.os.fstat', return_value=WrongOwner()), self.assertRaises(ValueError): load_policy(path)
            link=Path(temp)/'link';link.symlink_to(path)
            with self.assertRaises(ValueError):load_policy(link)
            path.write_text('{"version":1,"version":1,"principals":[]}')
            with self.assertRaises(ValueError):load_policy(path)
            path.write_text('{broken')
            with self.assertRaises(ValueError):load_policy(path)

    def test_main_missing_malformed_policy_or_reused_backend_credential_never_falls_back(self):
        with tempfile.TemporaryDirectory() as temp:
            temp=Path(temp);backend=temp/'backend.env';backend.write_text('PICKLESHELL_MEMORY_BACKEND_TOKEN='+TOKENS['codex']+'\n')
            policy=temp/'policy.json';policy.write_text(json.dumps(document()));policy.chmod(0o600)
            base={**os.environ,'PYTHONPATH':str(ROOT/'pickleshell-memory-broker'),'PICKLESHELL_MEMORY_BACKEND_ENV_FILE':str(backend)}
            base.pop('PICKLESHELL_MEMORY_BROKER_MODE',None);base.pop('PICKLESHELL_MEMORY_BROKER_POLICY_FILE',None)
            for extra in ({},{'PICKLESHELL_MEMORY_BROKER_MODE':'principals'},
                          {'PICKLESHELL_MEMORY_BROKER_MODE':'principals','PICKLESHELL_MEMORY_BROKER_POLICY_FILE':str(temp/'missing')},
                          {'PICKLESHELL_MEMORY_BROKER_MODE':'principals','PICKLESHELL_MEMORY_BROKER_POLICY_FILE':str(policy)}):
                r=subprocess.run([sys.executable,'-m','pickleshell_memory_broker.server'],env={**base,**extra},capture_output=True,text=True,timeout=3)
                self.assertNotEqual(r.returncode,0);self.assertNotIn(TOKENS['codex'],r.stdout+r.stderr)
            policy.write_text('{broken')
            r=subprocess.run([sys.executable,'-m','pickleshell_memory_broker.server'],env={**base,'PICKLESHELL_MEMORY_BROKER_MODE':'principals','PICKLESHELL_MEMORY_BROKER_POLICY_FILE':str(policy)},capture_output=True,text=True,timeout=3)
            self.assertNotEqual(r.returncode,0)

    def test_production_backend_cannot_be_retargeted(self):
        for url in ('http://127.0.0.1:8768', 'http://example.test:8766', 'http://127.0.0.1:8766/path', 'https://127.0.0.1:8766'):
            with self.assertRaises(ValueError):config({'PICKLESHELL_MEMORY_BROKER_BACKEND_URL':url})


class PrincipalProtocolTests(unittest.TestCase):
    def setUp(self):
        legacy.Backend.requests=[];legacy.Backend.partial_mode=None;legacy.Backend.response_body=b'{"status":"ok"}'
        self.backend=legacy.ThreadingHTTPServer(('127.0.0.1',0),legacy.Backend)
        threading.Thread(target=self.backend.serve_forever,daemon=True).start()
        self.broker=BoundedHTTPServer(('127.0.0.1',0),BrokerHandler,max_connections=4)
        self.broker.broker_config=(None,None,f'http://127.0.0.1:{self.backend.server_port}',legacy.TOKEN)
        self.broker.principal_policy=PrincipalPolicy(document())
        self.broker.read_deadline=.25;self.broker.upstream_timeout=.25
        threading.Thread(target=self.broker.serve_forever,daemon=True).start()

    def tearDown(self):
        self.broker.shutdown();self.broker.server_close();self.backend.shutdown();self.backend.server_close()

    def request(self,method,path,body=None,principal='codex',headers=None):
        h={} if principal is None else {'Authorization':'Bearer '+TOKENS.get(principal,'z'*64)}
        h.update(headers or {})
        c=http.client.HTTPConnection('127.0.0.1',self.broker.server_port,timeout=2)
        c.request(method,path,body=json.dumps(body) if isinstance(body,dict) else body,headers=h)
        r=c.getresponse();data=r.read();c.close();return r.status,data

    def test_missing_unknown_and_forged_identity_fail_before_backend(self):
        for principal in (None,'unknown'):
            self.assertEqual(self.request('GET','/health',principal=principal)[0],401)
        self.assertEqual(self.request('GET','/health',headers={'X-Agent':'opencode'})[0],403)
        self.assertEqual(self.request('GET','/health',headers={'Authorization':'Bearer codex'})[0],401)
        self.assertEqual(legacy.Backend.requests,[])

    def test_targets_and_raw_identity_injections(self):
        for field in ('user_id','principal','agent_id','namespace','scope'):
            self.assertEqual(self.request('POST','/search',{'query':'x',field:'opencode'})[0],403)
            self.assertEqual(self.request('GET','/memories?'+field+'=opencode')[0],403)
        for target in ('codex-bos-v1','agent:opencode:bos-v1','shared/project/unknown',[],''):
            self.assertEqual(self.request('POST','/search',{'query':'x','target':target})[0],403)
        self.assertEqual(self.request('POST','/search','{"query":"x","target":"private","target":"private"}')[0],400)
        self.assertEqual(self.request('GET','/memories?target=private&target=private')[0],403)
        self.assertEqual(legacy.Backend.requests,[])

    def test_permissions_and_upstream_credentials(self):
        for method,path,body in [('POST','/memories',{'text':'x','target':'shared/project/pickleshell'}),('PUT','/memories/id',{'text':'x','target':'shared/project/pickleshell'}),('DELETE','/memories/id?target=shared/project/pickleshell',None)]:
            self.assertEqual(self.request(method,path,body,principal='reader')[0],403)
        self.assertEqual(legacy.Backend.requests,[])
        for name in ('codex','opencode','reader'):
            self.assertEqual(self.request('POST','/search',{'query':'x','target':'shared/project/pickleshell'},principal=name)[0],200)
            _,_,headers,body=legacy.Backend.requests[-1]
            self.assertEqual(headers['Authorization'],'Bearer '+legacy.TOKEN)
            self.assertEqual(json.loads(body)['user_id'],'project:pickleshell:shared')
            self.assertNotIn('target',json.loads(body))
        for name in ('codex','opencode'):
            self.assertEqual(self.request('GET','/memories/id',principal=name)[0],200)
            self.assertIn('user_id='+('codex-bos-v1' if name=='codex' else 'agent%3Aopencode%3Abos-v1'),legacy.Backend.requests[-1][1])

    def test_capabilities_are_authenticated_and_sanitized(self):
        legacy.Backend.response_body=json.dumps({'status':'ok','token':legacy.TOKEN}).encode()
        status,body=self.request('GET','/health',principal='opencode')
        self.assertEqual(status,200); data=json.loads(body)
        self.assertEqual(data['broker']['principal'],'opencode')
        self.assertEqual(data['broker']['targets'][0]['target'],'private')
        self.assertNotIn(legacy.TOKEN,body.decode())
        self.assertNotIn(TOKENS['opencode'],body.decode())

    def test_route_response_bounds_redirects_and_deadline(self):
        self.assertEqual(self.request('GET','/not-allowed')[0],404)
        self.assertEqual(self.request('PATCH','/memories')[0],405)
        self.assertEqual(self.request('GET','http://example.test/health')[0],404)
        self.assertEqual(self.request('POST','/search',b'x'*65537)[0],413)
        legacy.Backend.response_body=b'x'*(256*1024+1)
        self.assertEqual(self.request('GET','/memories')[0],502)
        legacy.Backend.response_body=b'{}'
        original=legacy.Backend.send_response
        def redirect(handler,code,message=None):return original(handler,302,message)
        with patch.object(legacy.Backend,'send_response',redirect):self.assertEqual(self.request('GET','/memories')[0],503)
        # Authenticated principal mode retains absolute header/body deadlines and cap.
        sockets=[socket.create_connection(('127.0.0.1',self.broker.server_port),timeout=2) for _ in range(4)]
        try:
            for s in sockets:s.sendall(b'POST /search HTTP/1.1\r\nAuthorization: Bearer '+TOKENS['codex'].encode()+b'\r\nContent-Length: 50\r\n\r\n{')
            time.sleep(.05)
            with socket.create_connection(('127.0.0.1',self.broker.server_port),timeout=2) as extra:
                try:self.assertEqual(extra.recv(1),b'')
                except ConnectionResetError:pass
            time.sleep(.35)
            for s in sockets:
                try:self.assertEqual(s.recv(4096),b'')
                except ConnectionResetError:pass
            self.assertEqual(self.request('GET','/health')[0],200)
        finally:
            for s in sockets:s.close()


if __name__=='__main__':unittest.main()
