# One Memory broker, multiple principals

PickleShell Memory is an optional PickleShell component. Backend/admin remains
`MCP -> 127.0.0.1:8766`; scoped agents use one broker at `127.0.0.1:8767`.
A port identifies the service, never an agent. Do not allocate per-agent ports.

This change prepares multi-principal deployment; it does not deploy it. The
previous managed Codex experiment proved cross-session recall. The deterministic
integration test now proves cross-principal policy and shared vector retrieval
with independent MCP processes, real Mem0/Qdrant, and offline embedding doubles.
Neither is a claim of a real Codex-to-OpenCode production handoff. That experiment
remains a separate operational acceptance step.

## Trust boundary

Each principal has a random 256-bit-or-stronger bearer credential. Its launcher
reads only that principal's OS-protected credential file. Requests carry the
credential in `Authorization: Bearer ...`; they do not carry a trusted principal
name. The broker hashes the credential and looks up the operator policy. A
caller-controlled actor label, tool argument, `X-Agent`, or `X-Principal` cannot
choose identity. Missing, unknown, duplicate, or malformed authorization fails
closed. A client Authorization value is never forwarded: the broker replaces it
with its private backend credential when contacting 8766.

The backend credential remains in operator-only `backend.env`, projected to the
broker by systemd `LoadCredential`. Direct admin MCP still uses its existing
operator-authorized credential path; agent launchers never read that path.
Policy contains credential **digests**, scope mappings and permissions, not
backend credentials or plaintext principal credentials.

Use different, non-root Unix accounts for different principals. Each principal
credential is owned by its runtime UID, mode `0400` (or `0600`), under root-owned
non-writable directories. No shared credential group or cross-account sudo is
allowed for these runtime accounts. The accounts must not share process/debug
access. Two agents running arbitrary code under the same UID are the same OS
trust boundary and cannot be isolated by separate files. Root/operator access
is trusted and can bypass these controls. A bearer credential grants its entire
principal's policy; it is not a per-tool sandbox against that principal's own
shell access. Rotate a compromised credential and restart its MCP plus broker.

The installed `src/principal.js` launcher accepts only its credential-file and
audit-file paths. It fixes the broker URL to 8767, selects agent mode, and does
not accept raw scope, backend token, principal name or alternate endpoint.
`src/index.js` remains configurable for admin, legacy clients and isolated tests.

## Operator policy (version 1)

```json
{
  "version": 1,
  "principals": [
    {
      "name": "codex",
      "token_sha256": "<64 lowercase hex characters: SHA-256 of Codex credential>",
      "private_scope": "codex-bos-v1",
      "shared": {
        "shared/project/pickleshell": {
          "scope": "project:pickleshell:shared",
          "read": true,
          "write": true
        }
      }
    },
    {
      "name": "opencode",
      "token_sha256": "<64 lowercase hex characters: SHA-256 of OpenCode credential>",
      "private_scope": "agent:opencode:bos-v1",
      "shared": {
        "shared/project/pickleshell": {
          "scope": "project:pickleshell:shared",
          "read": true,
          "write": false
        }
      }
    }
  ]
}
```

Replace placeholders with actual digests before validation. Set OpenCode's
`write` explicitly to `true` to permit the initial bidirectional shared-write
experiment. Read and write are independent: search/list/get/history require
read; add/update/delete require write. Private memory always grants both to
only its mapped principal. A missing target or denied permission returns 403.
Even a known foreign memory ID must belong to the resolved scope; the backend
checks ownership for get/update/delete/history. Shared access does not grant
access to either private namespace.

Policies reject duplicate JSON keys, duplicate principal names or credential
digests, duplicate private scopes, private/shared collisions, inconsistent
shared aliases, unknown fields, missing/non-boolean permissions and oversized
input. There are at most 64 principals and 64 shared targets per principal.
The policy is loaded once at broker startup; changing it requires an operator
restart. Tools cannot edit policy. Broker audit events report the authenticated
principal, recognized target, resolved scope, operation, HTTP method and response status;
no memory text, query, memory IDs or credentials are recorded. These events go
to stdout (the systemd journal); MCP continues to use its existing JSONL audit. MCP audit actor
labels remain diagnostic and do not replace broker-authenticated identity.

## Agent-facing interface

All agent memory tools accept optional `target`, defaulting to `private`:

```json
{"query":"How is project memory authenticated?", "target":"shared/project/pickleshell", "limit":5}
```

There is no `user_id` field in the agent schema. Raw `user_id`, `principal`,
`scope`, `namespace`, `actor` or `agent_id` injections are denied. The MCP sends
`target` to the broker; only the broker translates it to backend `user_id`.
Targets are selectors, not trusted permissions: editing the target never
bypasses the operator policy. `memory_capabilities` reports the authenticated
principal and explicit available targets/read/write grants. Admin mode keeps
its existing explicit per-call `user_id` schema and direct 8766 path.

## Codex compatibility and migration

Keep **`codex-bos-v1` as Codex's canonical private scope** in the first policy.
Existing memories remain visible, with no copying, read-both window or changed
IDs. The agent-facing class is `private`; the physical scope does not need to
be renamed to `agent:codex:bos-v1`. Do not remap it without a separately designed
and backed-up migration. Shared project memory starts in a separate namespace;
existing Codex private facts are not automatically published there.

The installer without `--broker-policy` retains the historical single-principal
compatibility mode and explicitly renders `legacy-codex`. It is not the mode
for a multi-principal deployment. With `--broker-policy`, startup is strictly
`principals`: missing or invalid credentials/policy never fall back to legacy.
The broker executable itself requires an explicit mode. Keep the old client
launcher until the authenticated broker and new launcher are switched together.

## Prepare installation (operator action, not performed by this change)

1. Provision separate non-root runtime accounts and root-owned credential parent
   directories. Give each account only its own token file, no admin config group
   membership. Generate each credential with `secrets.token_urlsafe(48)` or an
   equivalent CSPRNG; store it directly in the protected file without terminal
   output, shell arguments, Git, or logs. Record its SHA-256 in policy. Do not use
   runtime names, passwords, reused tokens or the backend bearer as credentials.
2. Install the policy as `CONFIG_ROOT/broker-policy.json`, root-owned `0600`.
   Its directory and ancestors must be operator-owned, non-symlinked and not
   writable by service/runtime accounts. Keep each principal token in its own
   root-controlled directory; install files as runtime-UID-owned `0400`, with no
   group/other permissions. The policy may validate all digests, but no launcher
   gets the policy's other credentials. Never copy a token between accounts.
3. Validate policy and deploy a clean approved commit using the canonical
   installer, adding only:

   ```bash
   sudo deploy/memory-release.sh \
     --source /path/to/clean/checkout --root /opt/pickleshell-memory \
     --commit <approved-full-sha> \
     --node-executable /path/to/node --python-executable /path/to/python3.12 \
     --broker-policy /etc/pickleshell-memory/broker-policy.json
   ```

   Policy validation runs before deployment writes. The systemd unit projects
   both `backend.env` and the policy into separate private credentials. Because
   systemd can project a credential as 0440, the broker unit installs the policy
   as a broker-owned 0400 file in its private 0700 RuntimeDirectory before
   starting. The strict policy validator reads that copy; it still rejects 0440,
   group/world writes, unsafe owners and symlinks. The operator source remains
   root-owned 0600, and agent identities cannot traverse the runtime directory. Each
   immutable release records its policy pathname in `.broker-policy-path`;
   the source policy remains operator-managed, not copied into a release or Git.
   No new TCP listener is introduced.
4. Wire each runtime's local stdio MCP entry to its installed launcher:

   ```text
   command: /path/to/node
   args:
     /opt/pickleshell-memory/active/pickleshell-memory-mcp/src/principal.js
     /path/to/that-runtime-only/credential
     /path/to/that-runtime-writable/audit.jsonl
   ```

   Codex and OpenCode use this same executable and endpoint, but different
   credential files/Unix accounts. The file paths belong to trusted runtime
   configuration, not memory tool arguments. Do not put credentials themselves
   in either runtime configuration. No OpenCode configuration is changed here.
5. Before acceptance, verify OS cross-account file reads are denied; then run
   fresh runtime lifecycle, private isolation, shared read/write policy,
   unauthorized requests, admin regression and restart tests. Preserve private
   data and delete disposable acceptance records. The real OpenCode production
   semantic-recall experiment is still required before claiming cross-runtime
   production handoff.

For rollback, use the canonical `--rollback` with the same deployment paths and
**omit `--broker-policy`**. Rendering uses the target release's recorded mode and
policy path; it does not silently inherit the currently requested mode. A failed
activation restores the prior release's mode. Rollback to a principal release
validates its policy first. Keep policy backups: policy *contents* are operator
state, not versioned release data. Restore the matching prior client launchers
and policy snapshot if those were changed. Rollback to pre-principal code
requires the previous single-principal Codex launcher; keep OpenCode disconnected
until the multi-principal release is activated again. Existing immutable releases
and backend data are not removed by this feature.

## Verification and Core relationship

```bash
python3 test/memory-broker.test.py
python3 test/memory-multi-principal.test.py
npm --prefix pickleshell-memory-mcp test
bash test/memory-backend.test.sh
python3 test/memory-multi-principal-e2e.test.py
bash test/memory-deployment.test.sh
```

The real-engine E2E uses independent stdio processes, a single ephemeral test
broker, disposable Qdrant data, and a deterministic semantic embedding double
with synonym concepts plus an unrelated distractor. OpenCode's discovery client
receives only a semantic query and safe target, not Codex's transcript, marker
or memory ID; it gets the ID from vector search. It also verifies bidirectional
private-ID isolation, explicit shared writes, a read-only principal, and cleanup.
This is protocol/engine evidence, not an LLM recall-quality benchmark. Test
principal credentials live in isolated fixtures under the test account; production
OS-account separation is a separate installation acceptance requirement.

Native agent context/memory remains runtime-owned and follows that runtime's
lifecycle. PickleShell Memory is explicit, persistent external knowledge with
operator-governed private and shared scopes. The demonstrated memory handoff and
multi-principal tests are proven engineering precursors to a future Core
shared/organizational knowledge layer. PickleShell Memory remains optional today;
this change neither introduces that Core layer nor changes Gateway, Terminal or
Browser behavior.
