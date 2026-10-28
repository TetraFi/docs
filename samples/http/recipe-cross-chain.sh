#!/usr/bin/env bash
# Recipe: move USDC from one chain to another with an API key. Find USDC's chains, quote a
# cross-chain move, order a quote TetraFi executes from your organisation wallet, and follow
# it until it ends.
#
# Needs bash, curl, jq and openssl. Reads:
#   TETRAFI_BASE_URL        https://api.tetrafi.io in production
#   TETRAFI_API_KEY         your API key
#   TETRAFI_WORKSPACE_ID    the workspace the key belongs to
#   TETRAFI_SIGNING_SECRET  the key's signing secret, when request signing is on (venue trading needs it)
# Optional:
#   TETRAFI_ASSET           the asset to move (default USDC)
#   TETRAFI_FROM_CHAIN      CAIP-2 chain you pay on (default: the first chain GET /assets lists)
#   TETRAFI_TO_CHAIN        CAIP-2 chain you receive on (default: the next chain GET /assets lists)
#   TETRAFI_AMOUNT          the amount you pay (default 1)
#   TETRAFI_SLIPPAGE_BPS    how far below an indicative quote you accept, in basis points (default 50)
#   TETRAFI_PLACE_ORDER=1   places the order (yes also works); without it the script stops before ordering
#
# Progress goes to stderr; the last line printed is one JSON summary. A search with no quote you
# can order is an answer, not an error: the summary says why. Any other API error prints its
# error body and exits 1.
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
    -H "X-Workspace-Id: $TETRAFI_WORKSPACE_ID"
    -H "Accept: application/json"
  )
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

# quote BODY: POST /api/v1/quotes. You may send one live quote request every 3 seconds;
# on 429 QUOTE_RATE_LIMITED it waits details.retryAfter (an ISO 8601 duration) and sends once more.
quote() {
  local answer wait
  if answer=$(tetrafi POST /api/v1/quotes "$1" 2>/dev/null); then printf '%s\n' "$answer"; return 0; fi
  if [[ $(jq -r '.error // empty' <<<"$answer" 2>/dev/null) != QUOTE_RATE_LIMITED ]]; then
    printf '%s\n' "$answer" >&2
    return 1
  fi
  wait=$(jq -r '.details.retryAfter // "PT3S" | ltrimstr("PT") | rtrimstr("S") | tonumber | ceil' <<<"$answer")
  sleep "$wait"
  tetrafi POST /api/v1/quotes "$1"
}

asset=${TETRAFI_ASSET:-USDC}
amount=${TETRAFI_AMOUNT:-1}

# region recipe-cross-chain-chains
# The chains an asset is on come from GET /assets: every deployment of its native variant.
assets=$(tetrafi GET /api/v1/assets)
chains=$(jq -c --arg a "$asset" '[.assets[] | select(.assetId == $a) | .variants[]
  | select(.kind == "native") | .deployments[].chain] | unique' <<<"$assets")
echo "{\"asset\":\"$asset\",\"chains\":$chains}" >&2
from_chain=${TETRAFI_FROM_CHAIN:-$(jq -r '.[0] // empty' <<<"$chains")}
to_chain=${TETRAFI_TO_CHAIN:-$(jq -r --arg f "$from_chain" 'map(select(. != $f))[0] // empty' <<<"$chains")}
for chain in "$from_chain" "$to_chain"; do
  if ! jq -e --arg c "$chain" 'index($c) != null' <<<"$chains" >/dev/null; then
    jq -nc --arg a "$asset" --arg c "$chain" '{error: "ASSET_NOT_ON_CHAIN", asset: $a, chain: $c}' >&2
    exit 1
  fi
done
# endregion

# region recipe-cross-chain-quote
# The same asset on both sides, each side pinned to its chain, and only cross-chain quotes kept.
request=$(jq -nc --arg asset "$asset" --arg amount "$amount" --arg from "$from_chain" --arg to "$to_chain" '{
  pay: {asset: $asset, chain: $from},
  receive: {asset: $asset, chain: $to},
  amount: $amount,
  side: "payExact",
  filters: {locations: ["crossChain"]}
}')
quotes=$(quote "$request")

# Every venue asked, with its outcome. apiKeyOrganisationWalletScopeRequired means the key
# has no organisation wallet granted to it yet.
jq -c '.sources[] | select(.status != "filteredOut") | {venue: .venue.id, status, reason}' <<<"$quotes" >&2

# next "order": TetraFi executes the move from an organisation wallet, so the key can order it.
# next "preflight", "sign" or "transact": your own wallet has to act first, which a key cannot do.
jq -c '.quotes[] | {quoteId: .id, venue: .legs[0].venue.id, next: .next.kind,
  pay: "\(.pay.amount) on \(.pay.chain)", receive: "\(.receive.amount) on \(.receive.chain)",
  eta, paysFrom: .binding.wallets[.pay.chain], receivesAt: .binding.wallets[.receive.chain]}' <<<"$quotes" >&2
quote=$(jq -c 'first(.quotes[] | select(.next.kind == "order")) // empty' <<<"$quotes")
# endregion

if [[ -z $quote ]]; then
  jq -c --arg f "$from_chain" --arg t "$to_chain" '{from: $f, to: $t, orderable: false,
    ownWallet: [.quotes[] | select(.next.kind != "order") | {venue: .legs[0].venue.id, next: .next.kind}],
    reasons: [.sources[] | select(.status == "unavailable") | {venue: .venue.id, reason}]}' <<<"$quotes"
  exit 0
fi
quote_id=$(jq -r '.id' <<<"$quote")

if [[ ${TETRAFI_PLACE_ORDER:-} != 1 && ${TETRAFI_PLACE_ORDER:-} != yes ]]; then
  jq -c --arg f "$from_chain" --arg t "$to_chain" \
    '{from: $f, to: $t, orderable: true, quoteId: .id, venue: .legs[0].venue.id, ordered: false}' <<<"$quote"
  exit 0
fi

# region recipe-cross-chain-order
# A quote that is not firm executes within your limit: send minReceive, the least you accept, here
# the quoted amount less TETRAFI_SLIPPAGE_BPS (default 50), rounded down to the asset's decimals.
decimals=$(jq -r --arg a "$asset" --arg c "$to_chain" '[.assets[] | select(.assetId == $a) | .variants[]
  | select(.kind == "native") | .deployments[] | select(.chain == $c) | .decimals][0]' <<<"$assets")
order_body=$(jq -c --argjson bps "${TETRAFI_SLIPPAGE_BPS:-50}" --argjson d "$decimals" '{quoteId: .id}
  + (if .commitment.firm != true then {minReceive: ((.receive.amount | tonumber) * (10000 - $bps) / 10000
      | . * pow(10; $d) | floor | . / pow(10; $d) | tostring)} else {} end)' <<<"$quote")
# One Idempotency-Key per order, stored before you send it: a retry with the same key and body
# returns the first answer instead of moving the funds twice.
idempotency_key=$(openssl rand -hex 16)
placed=$(tetrafi POST /api/v1/orders "$order_body" "Idempotency-Key: $idempotency_key")
# A basicTrade names its venue trade in operation; an advancedTrade names its order in order.
jq -c '{kind, quoteId} + if .kind == "basicTrade" then {operation: (.operation | {connectionId, operationId})}
  else {order: (.order | {orderId})} end' <<<"$placed" >&2
# endregion

# region recipe-cross-chain-status
# Follow the order where the response points until it ends. A move TetraFi executes for you is a
# venue trade (basicTrade): poll every 10 seconds until it is filled or unfilled. An on-chain order
# (advancedTrade) is polled until terminal is true.
case $(jq -r '.kind' <<<"$placed") in
  basicTrade)
    path=$(jq -r --arg ws "$TETRAFI_WORKSPACE_ID" '.operation |
      "/api/v1/workspaces/\($ws)/venue-connections/\(.connectionId)/trade-preparations/\(.operationId)"' <<<"$placed")
    for _ in $(seq 1 60); do
      state=$(tetrafi GET "$path")
      status=$(jq -r '.executionStatus' <<<"$state")
      echo "{\"executionStatus\":\"$status\"}" >&2
      case $status in filled | unfilled) break ;; esac
      sleep 10
    done
    ;;
  advancedTrade)
    path="/api/v1/orders/$(jq -r '.order.orderId' <<<"$placed")"
    for _ in $(seq 1 60); do
      state=$(tetrafi GET "$path")
      status=$(jq -r '.status | if type == "object" then keys[0] else . end' <<<"$state")
      echo "{\"status\":\"$status\",\"terminal\":$(jq '.terminal' <<<"$state")}" >&2
      if jq -e '.terminal == true' <<<"$state" >/dev/null; then break; fi
      sleep 10
    done
    ;;
esac
# endregion

# region recipe-cross-chain-arrival
# Read the documented amounts and bounds, not transaction details outside the public contract.
# A missing amount is unknown, never zero. Confirm arrival in the destination wallet's app balance.
if [[ $status == filled ]]; then
  jq -c '{executionStatus, settlementStatus, bounds: (.bounds | {debitAsset, receiptAsset, maximumDebit, minimumReceipt}),
    dispatch: (.dispatch | if . == null then null else {inputSpent, outputReceived, venueOrderId} end)}' <<<"$state" >&2
fi
# endregion

jq -c --arg f "$from_chain" --arg t "$to_chain" --arg q "$quote_id" --arg k "$idempotency_key" \
  --arg s "$status" --argjson p "$placed" \
  '{from: $f, to: $t, quoteId: $q, kind: $p.kind, id: ($p.operation.operationId // $p.order.orderId),
    status: $s, idempotencyKey: $k}' <<<'{}'
