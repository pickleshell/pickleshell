# Model Allowlist

PickleShell accepts model overrides only when the requested model ID is present
in the Gateway allowlist. The maintained example allowlist lives in
`gateway/config.example.json`; operators should keep production config narrower
when a deployment does not need every provider.

The allowlist is an operator control, not a provider capability list. A client
may request a model with `send-chat.model`, but the Gateway rejects IDs that are
not allowed. If no model override is supplied, the Gateway uses the chat config
model and then the configured `default_model`.

Runtime selection is separate from model selection. `runtime` chooses the local
agent adapter, such as `opencode` or `codex`; `model` chooses an allowed provider
model for that adapter when the runtime supports model overrides. Runtime model
names may be mapped by the adapter before execution, so the ID accepted by the
Gateway is the stable control-plane value, not necessarily the final provider
wire value.

Codex also has an internal transport selector while the public runtime remains
`codex`. `codex.transport` accepts `exec` or `mcp` and defaults to `exec`;
`chats.<chat_id>.codex.transport` can override the global value. The
experimental `mcp` transport is version-sensitive and currently requires the
Codex `0.143.0` MCP surface with exactly `codex` and `codex-reply`. Invalid,
unavailable, or incompatible transport selection is rejected without automatic
fallback to exec.

Provider availability also depends on local authentication and account access.
A model can be present in the allowlist and still fail at runtime when the
corresponding provider credentials, subscription, regional access, or backend
entitlement are missing.

For programming work, prefer OpenCode with `opencode-go/gpt-5.6-luna` when it is
authorized for the deployment. For host-level DevOps work, use Codex as the
persistent operator runtime so it can maintain session continuity and apply
local engineering checks.

## Maintained Allowed Model IDs

```text
opencode/big-pickle
opencode/deepseek-v4-flash-free
opencode/mimo-v2.5-free
opencode/mimo-v2-pro-free
opencode/laguna-s-2.1-free
opencode/ling-3.0-flash-free
opencode/north-mini-code-free
opencode/nemotron-3-ultra-free
opencode/minimax-m2.5-free
opencode/qwen3.6-plus-free
opencode-go/deepseek-v4-flash
opencode-go/deepseek-v4-pro
opencode-go/glm-5.1
opencode-go/glm-5.2
opencode-go/gpt-5.6-luna
opencode-go/grok-4.5
opencode-go/hy3
opencode-go/kimi-k2.6
opencode-go/kimi-k2.7-code
opencode-go/kimi-k3
opencode-go/mimo-v2.5
opencode-go/mimo-v2.5-pro
opencode-go/minimax-m2.7
opencode-go/minimax-m3
opencode-go/qwen3.6-plus
opencode-go/qwen3.7-max
opencode-go/qwen3.7-plus
anthropic/claude-sonnet-4-20250514
qwen/qwen3-coder
```
