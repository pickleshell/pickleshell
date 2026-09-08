"""Management authorization over real HTTP with a bounded recording upstream."""
import copy
import importlib.util
import io
import json
from pathlib import Path
import unittest
from contextlib import redirect_stdout

spec = importlib.util.spec_from_file_location('principals', Path(__file__).with_name('memory-multi-principal.test.py'))
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)


def admin_document():
    doc = base.document()
    doc['principals'][0].update(role='admin', admin_targets={
        'private/opencode': {'read': True, 'delete': True},
        'shared/project/pickleshell': {'read': True, 'delete': False}})
    return doc


class ManagementTests(base.PrincipalProtocolTests):
    def setUp(self):
        super().setUp()
        self.broker.principal_policy = base.PrincipalPolicy(admin_document())

    def manage(self, operation, args=None, principal='codex'):
        status, body = self.request('POST', '/management/' + operation, args or {}, principal=principal)
        self.assertNotIn(base.legacy.TOKEN, body.decode())
        for token in base.TOKENS.values():
            self.assertNotIn(token, body.decode())
        return status, json.loads(body)

    def test_all_admin_tools_deny_ordinary_principal_before_upstream(self):
        from pickleshell_memory_broker.management import OPERATIONS
        for operation in OPERATIONS - {'list_targets'}:
            status, result = self.manage(operation, principal='opencode')
            self.assertEqual((status, result['error']), (403, 'admin_required'))
        self.assertEqual(base.legacy.Backend.requests, [])

    def test_discovery_status_policy_inventory_are_safe(self):
        for operation in ('admin_status', 'admin_health', 'admin_policy', 'admin_principals', 'admin_inventory', 'list_targets'):
            status, data = self.manage(operation)
            self.assertEqual(status, 200)
            self.assertNotIn('token_sha256', json.dumps(data))
            for p in admin_document()['principals']:
                self.assertNotIn(p['token_sha256'], json.dumps(data))
        self.assertFalse(self.manage('admin_policy')[1]['policy_mutation_supported'])
        self.assertFalse(self.manage('admin_inventory')[1]['counts_supported'])
        targets=self.manage('list_targets', principal='opencode')[1]['targets']
        self.assertEqual([t['target'] for t in targets], ['private','shared/project/pickleshell'])
        self.assertEqual(self.manage('admin_principal_status', {'subject':'opencode'})[1]['credential_delivery'], 'not_probed')
        self.assertEqual(self.manage('admin_principal_status', {'subject':'unknown'})[0],404)

    def test_explicit_admin_grants_and_single_delete_audit(self):
        self.assertEqual(self.manage('admin_search', {'query':'q','target':'private/opencode'})[0],200)
        body=json.loads(base.legacy.Backend.requests[-1][3])
        self.assertEqual(body['user_id'],'agent:opencode:bos-v1')
        self.assertEqual(self.manage('admin_get', {'memory_id':'id','target':'private/opencode'})[0],200)
        events=io.StringIO()
        with redirect_stdout(events):
            self.assertEqual(self.manage('admin_delete', {'memory_id':'id','confirm_memory_id':'id','target':'private/opencode'})[0],200)
            # Wait for handler completion so audit is captured before redirect exits.
            import time
            time.sleep(.02)
        audit=[json.loads(line) for line in events.getvalue().splitlines()]
        self.assertTrue(any(e['administrative_destructive'] and e['memory_id']=='id' and e['role']=='admin' and e['target']=='private/opencode' and e['timestamp'] for e in audit))
        for args in ({'memory_id':'id','target':'private/opencode'},
                     {'memory_id':'id','target':'private/opencode','confirm_memory_id':'other'},
                     {'memory_id':'*','target':'private/opencode','confirm_memory_id':'*'},
                     {'memory_id':'id','target':'shared/project/pickleshell','confirm_memory_id':'id'}):
            count=len(base.legacy.Backend.requests)
            self.assertGreaterEqual(self.manage('admin_delete',args)[0],400)
            self.assertEqual(len(base.legacy.Backend.requests),count)

    def test_injection_invalid_targets_and_closed_routes(self):
        for target in ('private/codex','private/unknown','shared/unknown','shared//x','shared/x/','*',[],None):
            self.assertGreaterEqual(self.manage('admin_search',{'query':'q','target':target})[0],400)
        for key in ('user_id','principal','scope','namespace','actor','role','admin_targets','endpoint'):
            self.assertEqual(self.manage('admin_search',{'query':'q','target':'private/opencode',key:'evil'})[0],400)
        self.assertEqual(self.manage('admin_wipe')[0],404)
        self.assertEqual(self.manage('admin_policy',{'principals':[]})[0],400)
        self.assertEqual(base.legacy.Backend.requests,[])

    def test_admin_role_alone_does_not_grant_record_access(self):
        doc=admin_document();doc['principals'][0]['admin_targets']={}
        self.broker.principal_policy=base.PrincipalPolicy(doc)
        self.assertEqual(self.manage('admin_policy')[0],200)
        self.assertEqual(self.manage('admin_search',{'target':'private/opencode','query':'q'})[0],403)
        self.assertEqual(base.legacy.Backend.requests,[])

    def test_backend_failure_is_safe_and_structured(self):
        self.broker.broker_config=(None,None,'http://127.0.0.1:1',base.legacy.TOKEN)
        self.assertEqual(self.manage('admin_get',{'target':'private/opencode','memory_id':'id'}),
                         (503,{'error':'backend_unavailable','status':503}))
        self.assertTrue(self.manage('admin_health')[1]['degraded'])

    def test_tokens_in_upstream_response_are_redacted(self):
        base.legacy.Backend.response_body=json.dumps({'secret':base.legacy.TOKEN,'credential':base.TOKENS['codex']}).encode()
        self.assertEqual(self.manage('admin_get',{'target':'private/opencode','memory_id':'id'})[0],200)
        # JSON escaping must not defeat secret filtering.
        escaped_secret = 'backend-' + '\"' * 32
        self.broker.broker_config = (*self.broker.broker_config[:3], escaped_secret)
        base.legacy.Backend.response_body = json.dumps({'secret': escaped_secret}).encode()
        self.assertEqual(self.manage('admin_get',{'target':'private/opencode','memory_id':'id'})[1]['secret'], '[redacted]')


class AdminPolicyTests(unittest.TestCase):
    def test_explicit_role_and_validated_names_required(self):
        for edit in [lambda p:p.update(role='owner'),lambda p:p.update(role=[]),
                     lambda p:p.update(role='agent'),
                     lambda p:p.update(admin_targets={'private/missing':{'read':True,'delete':True}}),
                     lambda p:p.update(admin_targets={'private/opencode':{'read':True,'delete':1}}),
                     lambda p:p.update(admin_targets={'*':{'read':True,'delete':True}}),
                     lambda p:p.update(admin_targets={'private/opencode':{'read':True,'delete':True,'scope':'evil'}})]:
            doc=copy.deepcopy(admin_document());edit(doc['principals'][0])
            with self.assertRaises(ValueError):base.PrincipalPolicy(doc)


if __name__ == '__main__': unittest.main()
