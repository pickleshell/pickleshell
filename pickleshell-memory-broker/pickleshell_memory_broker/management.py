"""Closed broker management API. No raw backend routes, scopes or policy writes."""
import json
import re
from http.client import HTTPConnection
from pathlib import Path
from urllib.parse import urlsplit

OPERATIONS = {
    'list_targets', 'admin_status', 'admin_principals', 'admin_policy',
    'admin_inventory', 'admin_search', 'admin_get', 'admin_delete',
    'admin_principal_status', 'admin_health',
}


def status(handler):
    """Probe readiness without returning any backend-supplied strings."""
    _, _, backend, token = handler.server.broker_config
    url = urlsplit(backend)
    connection = HTTPConnection(url.hostname, url.port, timeout=handler.server.upstream_timeout)
    ready = False
    try:
        connection.request('GET', '/health', headers={'Authorization': 'Bearer ' + token})
        response = connection.getresponse()
        data = response.read(65537)
        ready = response.status == 200 and len(data) <= 65536 and response.length in (None, 0) and json.loads(data).get('status') == 'ok'
    except Exception:
        pass
    finally:
        connection.close()
    release = Path(__file__).resolve().parents[2].name
    release = release if re.fullmatch('[0-9a-f]{40}', release) else None
    policy = handler.server.principal_policy
    return {'broker_health': 'ok', 'backend_health': 'ok' if ready else 'unavailable',
            'backend_ready': ready, 'degraded': not ready,
            'error': None if ready else 'backend_unavailable',
            'loaded_memory_release': release, 'policy_version': 1, 'policy_loaded': True,
            'principal_count': len(policy.by_name),
            'shared_target_count': sum(t.startswith('shared/') for t in policy.admin_catalog),
            'principal_authorization': 'authenticated', 'policy_mutation_supported': False,
            'service_information_supported': False, 'release_config_consistency': 'not_verified'}


def handle(handler, policy, operation, payload):
    principal = handler.principal
    if operation.startswith('admin_') and principal.get('role', 'agent') != 'admin':
        return handler.send_error_json(403, 'admin_required')
    if operation not in OPERATIONS:
        return handler.send_error_json(404, 'operation_not_allowed')
    fields = {
        'admin_search': {'target', 'query', 'limit'},
        'admin_get': {'target', 'memory_id'},
        'admin_delete': {'target', 'memory_id', 'confirm_memory_id'},
        'admin_principal_status': {'subject'},
    }.get(operation, set())
    required = fields - {'limit'}
    if not isinstance(payload, dict) or set(payload) - fields or not required <= set(payload):
        return handler.send_error_json(400, 'invalid_request')
    if operation == 'list_targets':
        return handler.send_json(200, policy.public(principal))
    if operation in {'admin_status', 'admin_health'}:
        return handler.send_json(200, status(handler))
    if operation in {'admin_principals', 'admin_policy'}:
        result = {'principals': [policy.sanitized(p) for p in policy.by_name.values()]}
        if operation == 'admin_policy':
            result.update(version=1, policy_mutation_supported=False)
        return handler.send_json(200, result)
    if operation == 'admin_principal_status':
        subject = payload['subject']
        if not isinstance(subject, str) or subject not in policy.by_name:
            return handler.send_error_json(404, 'principal_not_found')
        return handler.send_json(200, {**policy.sanitized(policy.by_name[subject]),
                                     'policy_binding_valid': True, 'credential_delivery': 'not_probed',
                                     'recent_activity_supported': False})
    if operation == 'admin_inventory':
        return handler.send_json(200, {'targets': [
            {**t, 'principal': t['target'][8:] if t['target'].startswith('private/') else None,
             'memory_count': None, 'last_activity': None}
            for t in policy.administrative_targets(principal)],
            'counts_supported': False, 'content_included': False})
    target = payload['target']
    if not isinstance(target, str) or not re.fullmatch(r'(private/[a-z][a-z0-9_-]{0,63}|shared/[a-z][a-z0-9_/-]{0,120})', target) or '//' in target or target.endswith('/'):
        return handler.send_error_json(400, 'invalid_request')
    grant = principal.get('admin_targets', {}).get(target)
    if not grant or not grant['delete' if operation == 'admin_delete' else 'read']:
        return handler.send_error_json(403, 'target_not_allowed')
    scope = policy.admin_catalog[target]
    handler.audit_target = target
    handler.audit_scope = scope
    if operation == 'admin_search':
        query, limit = payload['query'], payload.get('limit', 5)
        if not isinstance(query, str) or not 1 <= len(query) <= 8000 or type(limit) is not int or not 1 <= limit <= 100:
            return handler.send_error_json(400, 'invalid_request')
        return handler.forward('POST', '/search', {}, json.dumps({'query': query, 'limit': limit, 'user_id': scope}).encode())
    memory_id = payload['memory_id']
    if not isinstance(memory_id, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,199}', memory_id):
        return handler.send_error_json(400, 'invalid_request')
    handler.audit_memory_id = memory_id
    if operation == 'admin_delete' and payload['confirm_memory_id'] != memory_id:
        return handler.send_error_json(400, 'invalid_request')
    return handler.forward('DELETE' if operation == 'admin_delete' else 'GET',
                           '/memories/' + memory_id, {'user_id': [scope]}, b'')
