#!/usr/bin/env bash
# Credit and settlement: monitor each venue account's credit, read its ledger, then follow what it owes
# through the settlement plan, its windows, its obligations, the movements that pay them and one trade's
# settlement. Reads only: agreeing, disputing, marking a payment sent and paying are done by signed-in
# members in the app, and an API key calling them gets 403 JWT_REQUIRED.
#
# Needs bash, curl, jq and openssl. Reads:
#   TETRAFI_BASE_URL          https://api.tetrafi.io in production
#   TETRAFI_API_KEY           your API key, with Treasury read and Read settlements
#   TETRAFI_WORKSPACE_ID      your workspace id: the paths name it
#   TETRAFI_SIGNING_SECRET    the key's signing secret, when request signing is on
#   TETRAFI_VENUE_ACCOUNT_ID  optional: the venue account to follow; the first one listed otherwise
#   TETRAFI_TRADE_ID          optional: a venue trade whose settlement to read
#
# The last line printed is one JSON summary. The script exits 1 when an answer is refused or breaks the
# contract it checks; a refused read prints its body, with the code and the scope or fix it names.
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
    local timestamp digest signature canonical
    timestamp=$(date +%s)
    digest=$(printf '%s' "$body" | openssl dgst -sha256 -r | cut -d' ' -f1)
    canonical=$timestamp
    case $method in POST | PUT | PATCH | DELETE)
      # A write carries a fresh X-Nonce (base64url, accepted once) as the second signed line.
      local nonce
      nonce=$(openssl rand -base64 18 | tr '+/' '-_' | tr -d '=')
      canonical+=$'\n'$nonce
      headers+=(-H "X-Nonce: $nonce") ;;
    esac
    signature=$(printf '%s\n%s\n%s\n%s' "$canonical" "$method" "$path" "$digest" \
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

workspace=$TETRAFI_WORKSPACE_ID

# region credit-monitor
# List the venue accounts (Treasury read); each accountId is a venueAccountId. A wallet-based venue has no
# accountId and no credit line. GET …/venue-accounts/{venueAccountId}/credit reads the line:
# observation.state reported carries limit, used, available and overrun; notReported and unavailable carry
# no figures, never zeros. positions are the signed positions from the last recorded ledger read.
accounts=$(tetrafi GET "/api/v1/workspaces/$workspace/venue-enablements?limit=50")
for id in $(jq -r '.items[] | .accountId // empty' <<<"$accounts" | head -n 5); do
  credit=$(tetrafi GET "/api/v1/workspaces/$workspace/venue-accounts/$id/credit")
  jq -c '{venueAccountId, line: (.observation | if .state == "reported"
      then {limit, used, available, overrun, currency, observedAt} else {state, code: .error} end),
    facility: .facility.state, positions: (.positions | if .state == "observed"
      then [.value[] | {asset, netPosition}] else {state} end), readAt}' <<<"$credit" >&2
done
# endregion

account=${TETRAFI_VENUE_ACCOUNT_ID:-$(jq -r '[.items[] | .accountId // empty][0] // empty' <<<"$accounts")}
[[ -n $account ]] || fail NO_VENUE_ACCOUNT
base="/api/v1/workspaces/$workspace/venue-accounts/$account"

# region credit-ledger
# The ledger: signed positions and the credit line from the last recorded observation. A key never starts
# a venue read: source is recorded, and stale is true past an hour. 409 LEDGER_NOT_OBSERVED means nothing
# is recorded yet; a member opening the account in the app records a read.
if ledger=$(tetrafi GET "$base/ledger" 2>/dev/null); then
  jq -c '{source, stale, observedAt, readAt, positions: [.positions[] | {asset, amount}]}' <<<"$ledger" >&2
else
  jq -c '{refused: .error, message}' <<<"$ledger" >&2
fi
# endregion

# region settlement-plan
# What is due across every venue account (Read settlements). complete false lists in failedReads what
# could not be read: the plan is partial then, not "nothing due".
plan=$(tetrafi GET "/api/v1/workspaces/$workspace/settlement/plan?horizonDays=30")
jq -c '{state, complete, accounts: (.accountSummaries | length), windows: (.windows | length),
  failedReads: [.failedReads[].error] | unique, more: (.nextCursor != null)}' <<<"$plan" >&2
# endregion

# region settlement-windows
# The account's windows, newest first; filter with state and follow nextCursor until it is null. A ready
# window's statement says its provenance, whether each price was available, and whether the minimum
# settlement makes it due.
windows=$(tetrafi GET "$base/settlement/windows?limit=20")
jq -c '.items[:3][] | {windowId, state, snapshotAt, paymentDeadlineAt, dueState}' <<<"$windows" >&2
window_id=$(jq -r '.items[0].windowId // empty' <<<"$windows")
if [[ -n $window_id ]]; then
  window=$(tetrafi GET "$base/settlement/windows/$window_id")
  jq -c '{windowId, state, provenance: .statement.provenance, prices: [.statement.prices[]?.status],
    minimum: .statement.minimumSettlement.outcome}' <<<"$window" >&2
fi
# endregion

# region settlement-obligations
# What each side owes and by when. Filter with windowId or tradeId; the detail adds its events and the
# movements matched to it.
obligations=$(tetrafi GET "$base/settlement/obligations${window_id:+?windowId=$window_id}")
jq -c '.items[] | {obligationId, payer, asset, remainingAmount, dueAt, state, dueState}' <<<"$obligations" >&2
obligation_id=$(jq -r '.items[0].obligationId // empty' <<<"$obligations")
if [[ -n $obligation_id ]]; then
  tetrafi GET "$base/settlement/obligations/$obligation_id" | jq -c '{obligationId, events: [.events[].kind]}' >&2
fi
# endregion

# region settlement-movements
# Deposits and withdrawals as TetraFi recorded them. observationState and lastSuccessfulReadAt say how
# current the page is; unavailable with a reasonCode is not "no movements".
movements=$(tetrafi GET "$base/settlement/movements?limit=20")
jq -c '{observationState, reasonCode, lastSuccessfulReadAt, count: (.movements | length)}' <<<"$movements" >&2
# endregion

# region trade-settlement
# One venue trade's settlement: the obligations that cover it, each with its venue account, window and
# state. A venue trade settled only through its window has no separate settlement record: GET
# …/trades/{tradeId}/settlement answers a named 404 for it.
if [[ -n ${TETRAFI_TRADE_ID:-} ]]; then
  tetrafi GET "/api/v1/workspaces/$workspace/trades/$TETRAFI_TRADE_ID/settlement/obligations" \
    | jq -c --arg trade "$TETRAFI_TRADE_ID" '{tradeId: $trade, obligations: [.items[] | {windowId, obligationId, state}]}' >&2
fi
# endregion

jq -e 'has("items") and has("readAt")' <<<"$windows" >/dev/null || fail WINDOWS_PAGE_SHAPE
jq -e 'has("complete") and has("failedReads")' <<<"$plan" >/dev/null || fail PLAN_SHAPE
jq -e 'has("observationState")' <<<"$movements" >/dev/null || fail MOVEMENTS_SHAPE
jq -c --arg account "$account" '{venueAccount: $account, windows: (.items | length), more: (.nextCursor != null)}' <<<"$windows"
