#!/usr/bin/env bash
# Exchange account balances: list your exchange accounts, then read one account's balances,
# as recorded and from the venue now, and its deposit history. Reads only.
#
# Needs bash, curl, jq and openssl. Reads:
#   TETRAFI_BASE_URL          https://api.tetrafi.io in production
#   TETRAFI_API_KEY           your API key, with Treasury read switched on
#   TETRAFI_WORKSPACE_ID      your workspace id: the path names it
#   TETRAFI_SIGNING_SECRET    the key's signing secret, when the key signs its requests
#   TETRAFI_VENUE_ACCOUNT_ID  optional: the venue account to read; else the first listed
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
# GET …/accounts?kind=venueAccount lists the workspace's exchange accounts:
# pass nextCursor back as cursor until it is null. Each item's ref.resourceId
# is the {venueAccountId} of the reads below.
account=${TETRAFI_VENUE_ACCOUNT_ID:-} cursor=''
for _ in 1 2 3 4 5; do
  page=$(tetrafi GET "/api/v1/workspaces/$TETRAFI_WORKSPACE_ID/accounts?kind=venueAccount&limit=20${cursor:+&cursor=$cursor}")
  jq -c '.items[:3][] | {venueAccountId: .ref.resourceId, provider, displayName,
    environment, reading: .readingState.status}' <<<"$page" >&2
  [[ -n $account ]] || account=$(jq -r '.items[0].ref.resourceId // empty' <<<"$page")
  cursor=$(jq -r '.nextCursor // empty' <<<"$page")
  [[ -n $account || -z $cursor ]] && break
done
# endregion
if [[ -z $account ]]; then
  echo '{"balances":null,"reason":"NO_EXCHANGE_ACCOUNT"}'
  exit 0
fi

# region venue-balances
# GET …/balances?accountId={venueAccountId} reads the account's balances as the
# venue last reported them, one row per asset; follow nextCursor for the rest.
# amount is the total, available what you can trade now (null when unknown),
# locked what the venue holds back. valueUsd is null without a price, never 0.
# An account that could not be read is in unreachable, never a zero row.
path="/api/v1/workspaces/$TETRAFI_WORKSPACE_ID/balances?accountId=$account"
balances=$(tetrafi GET "$path&limit=20")
jq -c '{rows: [.items[:5][] | {asset, amount, available, locked, valueUsd,
  observedAt, source, freshness}], unreachable}' <<<"$balances" >&2
# Cache-Control: no-cache reads the venue now, for one venue account only. A
# venue that refuses the read is a named error; the recorded rows still stand.
if fresh=$(tetrafi GET "$path&limit=20" "" "Cache-Control: no-cache" 2>/dev/null)
then
  jq -c '{rows: (.items | length), observedAt: .items[0].observedAt,
    expiresAt: .items[0].expiresAt, unreachable}' <<<"$fresh" >&2
else
  jq -c '{refused: .error, message}' <<<"$fresh" >&2
  fresh=$balances
fi
# endregion

# region venue-deposit-history
# GET …/deposit-history lists the deposits the venue credited, every asset and network in one request:
# omit asset and network for the whole account, or pass comma lists (asset=USDC,USDT&network=eip155:1).
# Each credit names its asset and network (null for an asset the venue declares no network for, read by
# asset only). An empty items is a read that found none only for pairs absent from unreachable; a pair
# that was not read has an unreachable entry whose id is the pair and whose reason says why.
# include=observation returns each pair's own window and status, keyed by the same pair id.
history=$(tetrafi GET "/api/v1/workspaces/$TETRAFI_WORKSPACE_ID/venue-accounts/$account/deposit-history?include=observation")
jq -c '{deposits: (.items | length),
  pairs: [.included.observation | to_entries[] | {pair: .key, status: .value.value.status,
    since: .value.value.since}],
  unreachable: [.unreachable[] | {id, reason}]}' <<<"$history" >&2
# endregion

jq -e 'has("items") and has("nextCursor") and has("unreachable")' <<<"$balances" \
  >/dev/null || fail BALANCES_SHAPE
jq -e '.items | all(has("asset") and has("amount") and has("available")
  and has("locked") and has("observedAt"))' <<<"$fresh" >/dev/null \
  || fail BALANCE_LINE_SHAPE
jq -e 'has("items") and has("unreachable")' <<<"$history" >/dev/null || fail DEPOSIT_HISTORY_SHAPE

# A cursor the list did not issue is refused by name, never read as an empty page.
if foreign=$(tetrafi GET "/api/v1/workspaces/$TETRAFI_WORKSPACE_ID/accounts?kind=venueAccount&cursor=not-issued-by-this-list" 2>/dev/null); then
  fail FOREIGN_CURSOR_READ
fi
[[ $(jq -r '.error // empty' <<<"$foreign") == CURSOR_INVALID ]] || fail FOREIGN_CURSOR_REFUSAL
# no-cache without one venue account of this workspace is refused, naming
# Cache-Control, never answered from what is recorded.
if unknown=$(tetrafi GET "/api/v1/workspaces/$TETRAFI_WORKSPACE_ID/balances" "" \
  "Cache-Control: no-cache" 2>/dev/null); then
  fail NO_CACHE_WITHOUT_ACCOUNT_READ
fi
[[ $(jq -r '.error + ":" + .details.field' <<<"$unknown") == INVALID_REQUEST:Cache-Control ]] \
  || fail NO_CACHE_WITHOUT_ACCOUNT_REFUSAL

jq -cn --argjson b "$fresh" --argjson h "$history" '{assets: ($b.items | length),
  unreachable: ($b.unreachable | length), noCacheWithoutAccount: "INVALID_REQUEST",
  foreignCursor: "CURSOR_INVALID",
  depositHistory: (if ($h.unreachable | length) > 0 then "unavailable" else ($h.items | length) end)}'
