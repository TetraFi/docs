#!/usr/bin/env bash
# Workspace balances: every balance your key can read, across the workspace's wallets and exchange
# accounts, in one paged list. Reads only, from the last observation: it starts no refresh.
#
# Needs bash, curl, jq and openssl. Reads:
#   TETRAFI_BASE_URL          https://api.tetrafi.io in production
#   TETRAFI_API_KEY           your API key, with Treasury read switched on
#   TETRAFI_WORKSPACE_ID      your workspace id: the path names it
#   TETRAFI_SIGNING_SECRET    the key's signing secret, when the key signs its requests
#   TETRAFI_BALANCE_KIND      the account kind to read on its own: wallet (the default), venueAccount
#                             or bankAccount. Pick one your workspace holds: the script expects rows.
#
# The last line printed is one JSON summary. The script exits 1 when an answer breaks the contract
# it checks.
set -euo pipefail

: "${TETRAFI_BASE_URL:?Set TETRAFI_BASE_URL}"
: "${TETRAFI_API_KEY:?Set TETRAFI_API_KEY}"
: "${TETRAFI_WORKSPACE_ID:?Set TETRAFI_WORKSPACE_ID}"

# tetrafi METHOD PATH [BODY] [HEADER]
# Sends one request and prints the response body. On an error status it also prints
# the body to stderr and returns 1. With TETRAFI_SIGNING_SECRET set, it signs the request.
tetrafi() {
  local method=$1 path=$2 body=${3:-} extra=${4:-}
  local headers=(
    -H "X-API-Key: $TETRAFI_API_KEY"
    -H "Accept: application/json"
  )
  if [[ -n ${TETRAFI_WORKSPACE_ID:-} ]]; then headers+=(-H "X-Workspace-Id: $TETRAFI_WORKSPACE_ID"); fi
  if [[ -n $body ]]; then headers+=(-H "Content-Type: application/json"); fi
  if [[ -n $extra ]]; then headers+=(-H "$extra"); fi
  if [[ -n ${TETRAFI_SIGNING_SECRET:-} ]]; then
    local timestamp digest signature
    timestamp=$(date +%s)
    digest=$(printf '%s' "$body" | openssl dgst -sha256 -r | cut -d' ' -f1)
    signature=$(printf '%s\n%s\n%s\n%s' "$timestamp" "$method" "$path" "$digest" \
      | openssl dgst -sha256 -mac HMAC -macopt "hexkey:$TETRAFI_SIGNING_SECRET" -r | cut -d' ' -f1)
    headers+=(-H "X-Timestamp: $timestamp" -H "X-Signature: $signature")
  fi
  local response status
  response=$(curl -sS -X "$method" "$TETRAFI_BASE_URL$path" "${headers[@]}" \
    ${body:+--data "$body"} -w $'\n%{http_code}')
  status=${response##*$'\n'}
  response=${response%$'\n'*}
  printf '%s\n' "$response"
  if (( status >= 400 )); then
    printf '%s\n' "$response" >&2
    return 1
  fi
}

# region balances-list
# GET …/balances lists one row per account, asset and chain. Pass nextCursor back as cursor until
# it is null. amount is a decimal string in whole asset units; asOf is when it was observed.
rows='[]' cursor='' pages=0
for _ in 1 2 3 4 5; do
  page=$(tetrafi GET "/api/v1/workspaces/$TETRAFI_WORKSPACE_ID/balances?limit=50${cursor:+&cursor=$cursor}")
  pages=$((pages + 1))
  rows=$(jq -c --argjson rows "$rows" '$rows + .items' <<<"$page")
  cursor=$(jq -r '.nextCursor // empty' <<<"$page")
  [[ -z $cursor ]] && break
done
jq -c '.[:3][] | {accountKind, accountId, asset, chain, amount, asOf, freshness}' <<<"$rows" >&2
# endregion

# region balances-filter
# Narrow the list with asset, accountKind (wallet, venueAccount or bankAccount) and accountId.
kind=${TETRAFI_BALANCE_KIND:-wallet}
filtered=$(tetrafi GET "/api/v1/workspaces/$TETRAFI_WORKSPACE_ID/balances?accountKind=$kind&limit=50")
jq -c '.items[:3][] | {accountKind, accountId, asset, amount}' <<<"$filtered" >&2
# endregion

# region balances-unavailable
# An account whose balance cannot be read is listed in unavailable with its reasonCode, on every
# page. It is never shown as a zero row: show it as "unavailable". incomplete, when present, means
# the workspace's access settings could not be read, so the list may leave accounts out.
jq -c '.unavailable[:3][] | {accountKind, accountId, asset, reasonCode}' <<<"$page" >&2
incomplete=$(jq -r '.incomplete.reason // empty' <<<"$page")
[[ -n $incomplete ]] && echo "{\"incomplete\":\"$incomplete\"}" >&2
# endregion

# The contract this script checks.
jq -e 'has("items") and has("nextCursor") and (.unavailable | type == "array")' <<<"$page" >/dev/null \
  || fail BALANCES_SHAPE_UNEXPECTED
jq -e 'all(.[]; (.amount | type == "string" and test("^[0-9]+(\\.[0-9]+)?$")) and (.asOf | type == "string"))' \
  <<<"$rows" >/dev/null || fail BALANCE_AMOUNT_NOT_DECIMAL_STRING
# A filter check on no rows proves nothing, so the kind must have at least one row.
jq -e '.items | length > 0' <<<"$filtered" >/dev/null || fail NO_BALANCE_ROWS_FOR_KIND
jq -e --arg kind "$kind" 'all(.items[]; .accountKind == $kind)' <<<"$filtered" >/dev/null || fail BALANCE_FILTER_IGNORED

jq -nc --argjson rows "$rows" --argjson page "$page" --argjson pages "$pages" --arg kind "$kind" \
  --argjson kindRows "$(jq '.items | length' <<<"$filtered")" \
  '{rows: ($rows | length), pages: $pages, kinds: ($rows | map(.accountKind) | unique), kind: $kind, kindRows: $kindRows,
    unavailable: ($page.unavailable | length), incomplete: ($page.incomplete.reason // null)}'
