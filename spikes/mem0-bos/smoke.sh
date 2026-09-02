#!/usr/bin/env bash
set -euo pipefail

base_url="${MEM0_URL:-http://127.0.0.1:8765}"
infer="${MEM0_SMOKE_INFER:-true}"
case "$infer" in
  true|false) ;;
  *) echo "MEM0_SMOKE_INFER must be true or false" >&2; exit 2 ;;
esac
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
user_id="${MEM0_SMOKE_USER_ID:-pickleshell-mem0-smoke-$run_id}"
memory_text="The archive token $user_id is stored in the indigo drawer beneath the north telescope."
query="Where is archive token $user_id stored?"

printf 'USER_ID=%s\nINFER=%s\nFACT=%s\nQUERY=%s\n' \
  "$user_id" "$infer" "$memory_text" "$query"

curl --fail --silent --show-error \
  -H 'Content-Type: application/json' \
  -d "$(jq -cn --arg text "$memory_text" --arg user_id "$user_id" --argjson infer "$infer" '{text:$text,user_id:$user_id,infer:$infer}')" \
  "$base_url/memories"
printf '\n'
curl --fail --silent --show-error \
  -H 'Content-Type: application/json' \
  -d "$(jq -cn --arg query "$query" --arg user_id "$user_id" '{query:$query,user_id:$user_id,limit:5}')" \
  "$base_url/search"
printf '\n'
