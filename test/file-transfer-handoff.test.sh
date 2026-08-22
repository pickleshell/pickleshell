#!/usr/bin/env bash
set -Eeuo pipefail

# This checks the Unix boundary used by MCP staging and Gateway consumption.
# It is opt-in because it requires root and two real service identities.
if [[ ${PICKLESHELL_RUN_FILE_HANDOFF_INTEGRATION:-0} != 1 ]]; then
  printf '%s\n' 'file-transfer handoff integration skipped (set PICKLESHELL_RUN_FILE_HANDOFF_INTEGRATION=1 as root)'
  exit 0
fi

[[ $(id -u) == 0 ]] || { printf '%s\n' 'file-transfer handoff integration requires root' >&2; exit 77; }
command -v setpriv >/dev/null || { printf '%s\n' 'file-transfer handoff integration requires setpriv' >&2; exit 77; }

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
GATEWAY_USER=${PICKLESHELL_GATEWAY_USER:-pickleshell}
MCP_USER=${PICKLESHELL_MCP_USER:-pickleshell-tunnel}
MCP_GROUP=${PICKLESHELL_MCP_GROUP:-pickleshell-tunnel}
NODE_EXECUTABLE=${PICKLESHELL_NODE_EXECUTABLE:-$(command -v node)}

id "$GATEWAY_USER" >/dev/null
id "$MCP_USER" >/dev/null
getent group "$MCP_GROUP" >/dev/null
[[ -x $NODE_EXECUTABLE ]]

gateway_uid=$(id -u "$GATEWAY_USER")
gateway_gid=$(id -g "$GATEWAY_USER")
mcp_gid=$(getent group "$MCP_GROUP" | awk -F: '{ print $3 }')
tmp=$(mktemp -d /tmp/pickleshell-file-handoff.XXXXXX)
trap 'rm -rf -- "$tmp"' EXIT
# Let the two service identities traverse the otherwise private test parent,
# without granting them permission to list it.
chmod 0711 "$tmp"

stage_root=$tmp/mcp-temp
stage_dir=$stage_root/mcp-files-integration
source_file=$stage_dir/payload.txt
workspace=$tmp/workspace
transfer_module=$tmp/file-transfer.js
install -d -o "$MCP_USER" -g "$MCP_GROUP" -m 0710 "$stage_root"
install -d -o "$MCP_USER" -g "$MCP_GROUP" -m 0710 "$stage_dir"
printf 'handoff payload\n' | runuser -u "$MCP_USER" -- tee "$source_file" >/dev/null
chmod 0640 "$source_file"
install -d -o "$GATEWAY_USER" -g "$gateway_gid" -m 0700 "$workspace"
install -o root -g root -m 0644 "$ROOT_DIR/gateway/src/file-transfer.js" "$transfer_module"

gateway() {
  setpriv --reuid="$gateway_uid" --regid="$gateway_gid" \
    --groups="$gateway_gid,$mcp_gid" --inh-caps=-all -- "$@"
}

[[ $(gateway cat "$source_file") == 'handoff payload' ]]
if gateway ls "$stage_root" >/dev/null 2>&1; then
  printf '%s\n' 'Gateway unexpectedly listed the MCP staging root' >&2
  exit 1
fi
if gateway sh -c 'printf altered > "$1"' sh "$source_file" >/dev/null 2>&1; then
  printf '%s\n' 'Gateway unexpectedly modified the staged source file' >&2
  exit 1
fi

gateway "$NODE_EXECUTABLE" -e '
  const fs = require("fs");
  const transfer = require(process.argv[1]);
  const [source, workspace] = process.argv.slice(2);
  const inbox = transfer.copyFilesToWorkspace([{ name: "payload.txt", path: source }], workspace, undefined, "integration");
  const explicit = transfer.copyFilesToWorkspace([{ name: "payload-explicit.txt", path: source }], workspace, "handoff", "integration");
  if (fs.readFileSync(inbox[0].path, "utf8") !== "handoff payload\n") process.exit(1);
  if (fs.readFileSync(explicit[0].path, "utf8") !== "handoff payload\n") process.exit(1);
' "$transfer_module" "$source_file" "$workspace"

printf '%s\n' 'file-transfer handoff integration passed'
