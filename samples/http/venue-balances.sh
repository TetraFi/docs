#!/usr/bin/env bash
# Exchange account balances: list your exchange accounts, then read one account's balances and
# its deposit history. Reads only.
#
# Needs bash, curl, jq and openssl. Reads:
#   TETRAFI_BASE_URL          https://api.tetrafi.io in production
#   TETRAFI_API_KEY           your API key, with Read treasury switched on
#   TETRAFI_WORKSPACE_ID      your workspace id: the path names it
#   TETRAFI_SIGNING_SECRET    the key's signing secret, when the key signs its requests
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

fail() { echo "{\"error\":\"$1\"}" >&2; exit 1; }

# region venue-accounts-list
# GET …/venue-enablements lists the workspace's exchange accounts, oldest first: pass nextCursor
# back as cursor until it is null. Each item's accountId is the {venueAccountId} of the reads below.
# Take one that is configured and holds its money at the venue (venueKind accountBased).
account='' cursor=''
for _ in 1 2 3 4 5; do
  page=$(tetrafi GET "/api/v1/workspaces/$TETRAFI_WORKSPACE_ID/venue-enablements?limit=20${cursor:+&cursor=$cursor}")
  jq -c '.items[:3][] | {accountId, venueId, label, lifecycle, venueKind}' <<<"$page" >&2
  account=$(jq -r 'first(.items[] | select(.lifecycle == "configured" and .venueKind == "accountBased")
    | .accountId) // empty' <<<"$page")
  cursor=$(jq -r '.nextCursor // empty' <<<"$page")
  [[ -n $account || -z $cursor ]] && break
done
# endregion
if [[ -z $account ]]; then
  echo '{"balances":null,"reason":"NO_CONFIGURED_EXCHANGE_ACCOUNT"}'
  exit 0
fi

# region venue-balances
# GET …/venue-accounts/{venueAccountId}/balances reads the account's balances as the venue last
# reported them. balances null means no observation; [] is a real empty account. available is the
# venue's free balance less TetraFi's open trades and withdrawals, null when unknown; usdValue is
# null without a reference price, never 0. A balance never authorizes a payment.
balances=$(tetrafi GET "/api/v1/workspaces/$TETRAFI_WORKSPACE_ID/venue-accounts/$account/balances")
jq -c '{state, observedAt, expiresAt, balances: (.balances | if . == null then null else
  [.[] | {asset, total, free, available, usdValue}] end)}' <<<"$balances" >&2
# endregion

# region venue-deposit-history
# GET …/deposit-instructions lists the asset and network pairs the account takes deposits on
# (options); GET …/deposit-history?asset=…&chainRef=… lists the deposits the venue credited on one
# of them. credits null means the history is unavailable (reason says why), never an empty history.
instructions=$(tetrafi GET "/api/v1/workspaces/$TETRAFI_WORKSPACE_ID/venue-accounts/$account/deposit-instructions")
read -r asset chain < <(jq -r '(.options // [])[0] | "\(.asset // "") \(.chainRef // "")"' <<<"$instructions")
if [[ -z $asset ]]; then
  # A venue that declares no deposit network answers options [] and names its assets in
  # unconfirmedNetworkAssets: ask for one of them on a chain GET /api/v1/assets lists for it.
  asset=$(jq -r '.unconfirmedNetworkAssets // [] | if index("USDC") then "USDC" else .[0] // "" end' <<<"$instructions")
  chain=$(tetrafi GET /api/v1/assets | jq -r --arg a "$asset" 'first(.items[] | select(.assetId == $a)
    | .variants[] | select(.kind == "native") | .deployments[] | .chain) // ""')
fi
[[ -n $asset && -n $chain ]] || fail NO_DEPOSIT_OPTION
history=$(tetrafi GET "/api/v1/workspaces/$TETRAFI_WORKSPACE_ID/venue-accounts/$account/deposit-history?asset=$asset&chainRef=$chain")
jq -c '{asset, chainRef, state, reason, credits: (.credits | if . == null then null else length end)}' <<<"$history" >&2
# endregion

jq -e 'has("balances") and has("state") and has("observedAt")' <<<"$balances" >/dev/null || fail BALANCES_SHAPE
jq -e '(.balances // []) | all(has("asset") and has("total") and has("free"))' <<<"$balances" >/dev/null \
  || fail BALANCE_LINE_SHAPE
jq -e 'has("credits") and has("state")' <<<"$history" >/dev/null || fail DEPOSIT_HISTORY_SHAPE

# A cursor the list did not issue is refused by name, never read as an empty page.
if foreign=$(tetrafi GET "/api/v1/workspaces/$TETRAFI_WORKSPACE_ID/venue-enablements?cursor=not-issued-by-this-list" 2>/dev/null); then
  fail FOREIGN_CURSOR_READ
fi
[[ $(jq -r '.error // empty' <<<"$foreign") == INVALID_CURSOR ]] || fail FOREIGN_CURSOR_REFUSAL
# An account id this workspace doesn't hold is refused by name, never read as an empty account.
if unknown=$(tetrafi GET "/api/v1/workspaces/$TETRAFI_WORKSPACE_ID/venue-accounts/00000000-0000-4000-8000-000000000000/balances" 2>/dev/null); then
  fail UNKNOWN_ACCOUNT_READ
fi
[[ $(jq -r '.error // empty' <<<"$unknown") == VENUE_ACCOUNT_NOT_FOUND ]] || fail UNKNOWN_ACCOUNT_REFUSAL

jq -cn --argjson b "$balances" --argjson h "$history" '{state: $b.state,
  assets: (($b.balances // []) | length), unknownAccount: "VENUE_ACCOUNT_NOT_FOUND", foreignCursor: "INVALID_CURSOR",
  depositHistory: (if $h.credits == null then "unavailable" else ($h.credits | length) end)}'
