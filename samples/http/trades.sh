#!/usr/bin/env bash
# Trade history: one list of your workspace's trades, the orders you placed through the API and the
# trades on your exchange accounts alike, paged with a cursor. Reads only.
#
# Needs bash, curl, jq and openssl. Reads:
#   TETRAFI_BASE_URL        https://api.tetrafi.io in production
#   TETRAFI_API_KEY         your API key, with Read trades
#   TETRAFI_WORKSPACE_ID    your workspace id: the trades path names it
#   TETRAFI_SIGNING_SECRET  the key's signing secret, when request signing is on
#
# The last line printed is one JSON summary. The script exits 1 when an answer breaks the contract
# it checks.
set -euo pipefail

: "${TETRAFI_BASE_URL:?Set TETRAFI_BASE_URL}"
: "${TETRAFI_API_KEY:?Set TETRAFI_API_KEY}"
: "${TETRAFI_WORKSPACE_ID:?Set TETRAFI_WORKSPACE_ID}"

# tetrafi METHOD PATH [BODY] [HEADER] [HEADERS_FILE]
# Sends one request and prints the response body. On an error status it also prints the body to
# stderr and returns 1. With TETRAFI_SIGNING_SECRET set, it signs the request. With HEADERS_FILE,
# the response headers are written there.
tetrafi() {
  local method=$1 path=$2 body=${3:-} extra=${4:-} dump=${5:-}
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
    ${body:+--data "$body"} ${dump:+-D "$dump"} -w $'\n%{http_code}')
  status=${response##*$'\n'}
  response=${response%$'\n'*}
  printf '%s\n' "$response"
  if (( status >= 400 )); then
    printf '%s\n' "$response" >&2
    return 1
  fi
}

fail() { echo "{\"error\":\"$1\"}" >&2; exit 1; }

# region trades-list
# The path names your workspace: the workspaceId GET /api/v1/me answers for your key.
workspace=$TETRAFI_WORKSPACE_ID
# GET /api/v1/workspaces/{workspaceId}/trades lists the workspace's trades, newest first. Every row
# has tradeId, kind (order or venueTrade) and projection. Filter with kind, status, from and to;
# follow nextCursor until it is null. coverage lists kinds whose rows could not be read: the page
# is then partial, not shorter.
since=$(date -u -v-30d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '30 days ago' +%Y-%m-%dT%H:%M:%SZ)
page=$(tetrafi GET "/api/v1/workspaces/$workspace/trades?limit=5&from=$since")
jq -c '{total, nextCursor: (.nextCursor != null), coverage, excludedKinds}' <<<"$page" >&2
jq -c '.items[:3][] | {tradeId, kind, projection, createdAt}' <<<"$page" >&2
cursor=$(jq -r '.nextCursor // empty' <<<"$page")
if [[ -n $cursor ]]; then
  next=$(tetrafi GET "/api/v1/workspaces/$workspace/trades?limit=5&from=$since&cursor=$cursor")
  jq -c '{page: 2, rows: (.items | length)}' <<<"$next" >&2
fi
# endregion

# region trade-detail
# GET …/trades/{tradeId} reads one trade through the same view. An order's settlement says how it
# ended: status pending, settled, failed, refunded or unknown, and failureReason, a sentence
# saying why, when it failed or was refunded.
failed=$(tetrafi GET "/api/v1/workspaces/$workspace/trades?kind=order&status=failed&limit=1")
trade_id=$(jq -r '.items[0].tradeId // empty' <<<"$failed")
if [[ -z $trade_id ]]; then
  trade_id=$(tetrafi GET "/api/v1/workspaces/$workspace/trades?kind=order&limit=1" | jq -r '.items[0].tradeId // empty')
fi
if [[ -n $trade_id ]]; then
  trade=$(tetrafi GET "/api/v1/workspaces/$workspace/trades/$trade_id")
  jq -c '{tradeId, kind, settlement: (.settlement | if . == null then null else {status, failureReason} end)}' <<<"$trade" >&2
fi
# endregion

jq -e '(.items | all(has("tradeId") and has("kind") and has("projection")))' <<<"$page" >/dev/null \
  || fail TRADE_ROW_MISSING_IDENTITY
if [[ -n ${trade:-} ]]; then
  jq -e 'has("tradeId") and has("kind")' <<<"$trade" >/dev/null || fail TRADE_DETAIL_MISSING_IDENTITY
  jq -e '(.settlement == null) or (.settlement | has("status"))' <<<"$trade" >/dev/null || fail SETTLEMENT_STATUS_MISSING
  # Fields an API key never reads on a trade.
  jq -e '[paths | .[-1] | select(. == "compliance" or . == "snapshotCompliance" or . == "complianceProofs"
    or . == "travelRuleTransmission" or . == "intent")] | length == 0' <<<"$trade" >/dev/null || fail TRADE_DETAIL_WITHHELD_FIELD
fi
jq -c '{total, rows: (.items | length), kinds: ([.items[].kind] | unique), more: (.nextCursor != null), partial: ((.coverage // []) | length > 0)}' <<<"$page"
