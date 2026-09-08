# ChatGPT Memory MCP

PickleShell Memory gives ChatGPT explicit persistent memory, independently of
Agent, Terminal, Browser, or native conversation context. The repository-owned
stdio server runs behind the existing Secure MCP Tunnel:

```text
ChatGPT -> Secure MCP Tunnel -> installed chatgpt.js
        -> credential-authenticated Memory broker (127.0.0.1:8767)
        -> authenticated Mem0 backend (127.0.0.1:8766)
```

ChatGPT never connects directly to the backend. This is the existing
multi-principal architecture with a broker management API, not another Memory
service or a per-principal port. Codex and OpenCode keep their current launchers,
private scopes and shared grants. No production principal names are hardcoded.

## Normal and admin modes

`chatgpt.js` takes a protected principal credential file, an absolute audit log
path, and optional `normal` (default) or `admin`. These are **operator launch
configuration**, never tool arguments or ChatGPT Settings. Normal mode lists nine
tools; admin mode lists eighteen. Both use the same implementation and broker.

The `admin` launch selector only exposes tool schemas. The broker independently
requires a credential bound to `role: "admin"` in its validated operator policy.
An ordinary credential with admin schemas exposed receives `admin_required`.
There is no tool to become admin, select caller identity, or change policy.
An operator should use a separate protected runtime identity and separate tunnel
exposure for administration. Anyone allowed to use that admin connector can
exercise its configured grants; ChatGPT login identity is not automatically a
Memory principal. Do not share an operator connector with ordinary users.

Normal tools on an admin-enabled surface still use that admin principal's own
private/shared grants. Cross-principal record access is available only through
admin tools and their explicit `admin_targets` grants.

## Tools

Names use the existing underscore convention. All errors use the MCP `isError`
flag with a JSON text body containing `error`, `status`, and `retryable`.

| Tool | Arguments | Result / boundary |
|---|---|---|
| `memory_capabilities` | none | Authenticated principal/role, allowed targets, permissions, supported operations, safe backend health; fails closed if discovery fails |
| `memory_list_targets` | none | Own private/shared aliases, resolved scopes, `read` and `write`; no unrelated targets |
| `memory_search` | `query`, optional `target`, `limit` | Semantic search in one allowed target; limit 1–100, default 5 |
| `memory_list` | optional `target`, `limit` | Bounded listing; default 20, maximum 100 |
| `memory_get` | `memory_id`, optional `target` | Authorized single-record read |
| `memory_add` | `text`, optional `target`, `infer` | Create; inference defaults true; use false to store exact text |
| `memory_update` | `memory_id`, `text`, optional `target` | Update in place; target is an ownership check, never a move |
| `memory_delete` | `memory_id`, optional `target` | Delete one authorized record |
| `memory_history` | `memory_id`, optional `target` | Authorized version/change history |
| `memory_admin_status` | none | Broker/backend health, loaded immutable release, policy version, principal/shared-target counts, degraded status |
| `memory_admin_principals` | none | Sanitized configured principals and grants |
| `memory_admin_policy` | none | Sanitized effective policy, `policy_mutation_supported: false` |
| `memory_admin_inventory` | none | Caller's explicit administrative aliases/scopes and read/delete grants, no memory content |
| `memory_admin_search` | `target`, `query`, optional `limit` | Search one explicit administrative target; repeat for selected targets |
| `memory_admin_get` | `target`, `memory_id` | Read only where the admin has an explicit read grant |
| `memory_admin_delete` | `target`, `memory_id`, `confirm_memory_id` | Single-record deletion with a separate delete grant and matching repeated ID |
| `memory_admin_principal_status` | `subject` | Inspect a configured principal by name; does not select caller identity |
| `memory_admin_health` | none | Broker-to-backend probe, policy-loaded and authenticated-path status, safe diagnostics |

The current backend does not support caller metadata on writes or an efficient
count/last-activity endpoint. These are not simulated: metadata is unavailable,
and inventory returns `counts_supported: false`, null counts/activity. Inventory
never retrieves memory content to count it. Record operations remain transparent
Mem0 results, except authentication material is redacted and backend errors are
projected to safe codes.

## Targets and isolation

Normal `target` defaults to `private`; use an approved alias such as
`shared/project/pickleshell` for shared knowledge. Discover aliases first. The
broker alone resolves aliases to backend scope strings. `read` governs
search/list/get/history, and `write` governs add/update/delete. An ID does not
confer access: the backend checks the resolved scope for every ID operation,
including admin get/delete. Passing another target cannot move a record.

No ChatGPT schema accepts raw `user_id`, `principal`, `scope`, `namespace`, role
or credential selection. Unexpected arguments are rejected before forwarding.
Normal target denial retains the existing `target_access_denied` convention;
admin target denial is `target_not_allowed`. Other errors include
`admin_required`, `principal_unauthorized`, `memory_not_found`,
`operation_not_allowed`, `invalid_request`, and `backend_unavailable`.
A missing/invalid policy prevents broker startup entirely; there is no legacy
fallback in principal mode.

## Operator policy and sanitized administration

Version 1 policies retain their original meaning: an omitted role means `agent`.
An operator may add these fields to a principal (illustrative fragments only):

```json
{
  "role": "admin",
  "admin_targets": {
    "private/research_assistant": {"read": true, "delete": false},
    "shared/project/pickleshell": {"read": true, "delete": true}
  }
}
```

`private/research_assistant` must refer to a principal configured in this same
policy. A shared alias must already exist in normal shared policy. Each grant
requires explicit boolean `read` and `delete`. Unknown aliases, wildcards,
extra fields and administrative grants on an agent are rejected. An admin with
no administrative targets can inspect policy/status but cannot read or delete
cross-principal records. Administrative targets do not accept physical scopes.

Policy inspection returns principal names, roles, private scopes, private/shared
permissions and administrative grants. It omits credential digests, plaintext
credentials, filesystem locations and arbitrary backend fields. `configured`
indicates policy presence; the policy has no enabled/disabled flag. Principal
status confirms schema-valid binding, but reports credential delivery as
`not_probed`: reading other principals' credential files is not an MCP operation.

Policy mutation remains operator/deployment-owned. Update and validate protected
policy through the [existing deployment procedure](memory-principals.md), keep a
rollback snapshot, and restart the broker. There is no runtime policy editor,
credential provisioning tool, backend endpoint proxy, shell/SQL execution,
filesystem access, wildcard deletion or backend wipe.

## Destructive actions and audit

For administrative deletion, discover an allowed target, inspect the record,
then supply both `memory_id` and an equal `confirm_memory_id` together with that
explicit target. A read grant alone never permits deletion. The confirmation
prevents omission/mismatched IDs; it is not an interactive human approval token.
Use ChatGPT's tool approval controls according to operator policy.

The broker writes content-free JSON audit events with timestamp, authenticated
principal/role, operation, recognized target/scope, validated memory ID and HTTP
status. Admin deletion sets `administrative_destructive: true`. The MCP also
writes its existing local JSONL audit. MCP actor/role fields describe the local
launch configuration; the broker event is authoritative for authenticated role.
Neither log contains queries, memory content, bearer tokens or request headers.
MCP audit failure after deletion returns `mutation_outcome: "uncertain"` and is
not retryable; inspect state before another destructive request.

## Deployment configuration (not deployed by this change)

1. Use the canonical `deploy/memory-release.sh` with an approved clean commit and
   validated `--broker-policy`. The existing generic installer archives the
   whole Memory MCP and broker packages, including `src/chatgpt.js` and management
   code, into its immutable release. No additional listener or installer is
   needed. Keep policy and credential provisioning operator-owned.
2. Provision the ChatGPT principal using the same protected credential model as
   Codex/OpenCode: a separate non-root runtime UID, a 0400/0600 credential file
   under operator-controlled parent directories, no shared credential group or
   cross-account sudo/debug access. Bind its SHA-256 only in protected policy.
   Give the tunnel's stdio child access only to this credential and its audit log.
3. Configure the selected tunnel's stdio MCP entry with generic operator paths:

   ```text
   command: /path/to/node
   args:
     /path/to/memory/active/pickleshell-memory-mcp/src/chatgpt.js
     /path/to/principal-only/credential
     /path/to/principal-audit/memory.jsonl
     normal
   ```

   For a trusted operator connector, use `admin` and an independently provisioned
   admin credential. The launch selector cannot upgrade an ordinary credential.
   Pin a specific installed `releases/<full-sha>` instead of `active` when desired.
4. Follow the [existing ChatGPT tunnel connection guide](chatgpt.md) to expose this
   stdio server as its own Memory surface and refresh tool discovery. Do not
   publish 8767 or 8766. Do not use the historical direct-backend admin `index.js`
   configuration for ChatGPT. The fixed ChatGPT launcher ignores endpoint/scope/
   role environment overrides and refuses a backend-token environment variable.
5. Verify discovery, a disposable private lifecycle, shared grants and denied
   private IDs through the configured connector. Verify admin denial with an
   ordinary credential, then inspect admin status with the approved credential.
   Roll back using the canonical Memory release process and matching policy
   snapshot; restart the tunnel child to load the selected immutable code.

Only the broker reads the backend bearer. The ChatGPT process receives a scoped
principal credential from its protected file; tool results and ChatGPT-visible
configuration never contain that credential or the backend token. The historical
operator-only direct backend interface remains available separately for existing
installations; it is not used by this surface.

Status reports `loaded_memory_release` from the running immutable code directory
(null in a checkout). It does not claim that a newly switched `active` link has
already restarted every process. Service/restart information is unsupported,
release/config consistency is `not_verified`, and deep health does not run a
write probe or verify an external embedding/LLM provider. A broker outage returns
a structured transport error; a reachable broker with failed backend readiness
returns degraded diagnostics. Live ChatGPT UI/tunnel acceptance remains a later
operator deployment step.

## Example workflows

“Search my private memory for the last PickleShell release decision.”

Call `memory_capabilities`, then `memory_search` with the query and default
private target. Use `memory_get` on a returned ID if more detail is needed.

“Store this architecture note in shared/project/pickleshell.”

Call `memory_list_targets`, verify `write: true`, then `memory_add` with `text`,
`target: "shared/project/pickleshell"` and `infer: false` for an exact note.

“Show Memory health and configured principals.”

On the approved admin surface, call `memory_admin_health` and
`memory_admin_principals`. An ordinary principal receives `admin_required`.

“Search shared project memory across approved administrative targets.”

Call `memory_admin_inventory`, select the shared targets with `read: true`, then
call `memory_admin_search` once per selected alias. There is no implicit global
search or raw backend scope selector.

## Verification

```bash
npm --prefix pickleshell-memory-mcp test
python3 test/memory-broker.test.py
python3 test/memory-multi-principal.test.py
python3 test/memory-management.test.py
python3 test/memory-multi-principal-e2e.test.py
bash test/memory-deployment.test.sh
git diff --check
```

The real-engine E2E uses disposable data, ephemeral ports and deterministic
embedding doubles, plus independent stdio clients. It exercises the existing
Codex/OpenCode handoff and the new administrative grants without production data.
