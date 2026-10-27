#!/usr/bin/env bash
# Quickstart: list assets, request quotes, preflight the best quote, place an order and read its status.
#
# Needs bash, curl, jq and openssl. Reads:
#   TETRAFI_BASE_URL        https://api.tetrafi.io in production
#   TETRAFI_API_KEY         your API key
#   TETRAFI_WORKSPACE_ID    the workspace the key belongs to
#   TETRAFI_SIGNING_SECRET  the key's signing secret, when request signing is on (venue trading needs it)
# Optional:
#   TETRAFI_PAY, TETRAFI_RECEIVE, TETRAFI_AMOUNT  the pair and the amount you pay (default 10 USDC for USDT)
#   TETRAFI_VENUES          comma-separated venue ids to ask, instead of every venue
#   TETRAFI_SLIPPAGE_BPS    how far below a quote that is not firm you accept, in basis points (default 50)
#   TETRAFI_PLACE_ORDER=1 places the order; without it the script stops before ordering
#
# The last line printed is one JSON summary. An API error prints its error body and exits 1.
set -euo pipefail

# region quickstart-client
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
# endregion

pay=${TETRAFI_PAY:-USDC}
receive=${TETRAFI_RECEIVE:-USDT}
amount=${TETRAFI_AMOUNT:-10}

# region quickstart-assets
assets=$(tetrafi GET /api/v1/assets)
for asset in "$pay" "$receive"; do
  if ! jq -e --arg a "$asset" 'any(.assets[]; .assetId == $a)' <<<"$assets" >/dev/null; then
    echo "{\"error\":\"ASSET_NOT_LISTED\",\"asset\":\"$asset\"}" >&2
    exit 1
  fi
done
echo "assets: $(jq '.assets | length' <<<"$assets") listed, quoting $pay for $receive" >&2
# endregion

# region quickstart-quote
request=$(jq -n --arg pay "$pay" --arg receive "$receive" --arg amount "$amount" \
  --arg venues "${TETRAFI_VENUES:-}" '{
    pay: {asset: $pay},
    receive: {asset: $receive},
    amount: $amount,
    side: "payExact"
  } + (if $venues == "" then {} else {filters: {venues: {include: ($venues | split(","))}}} end)')
quotes=$(tetrafi POST /api/v1/quotes "$request")

# Quotes arrive best first (most received, net of fees). Take the best one you can act on now.
quote=$(jq -c 'first(.quotes[] | select(.next.kind == "order" or .next.kind == "preflight")) // empty' <<<"$quotes")
if [[ -z $quote ]]; then
  # Every venue asked is listed in sources with its outcome, so an empty result says why.
  jq -c '{error: "NO_ACTIONABLE_QUOTE", sources: [.sources[] | {venue: .venue.id, status, reason}]}' <<<"$quotes" >&2
  exit 1
fi
quote_id=$(jq -r '.id' <<<"$quote")
jq -c '{quoteId: .id, venue: .legs[0].venue.id, mode: .legs[0].venue.integrationMode,
  pay: .pay.amount, receive: .receive.amount, next: .next.kind, expiresAt}' <<<"$quote" >&2
# endregion

# region quickstart-preflight
# Preflight checks an on-chain (Advanced) quote and lists what must happen before ordering.
# A venue (Basic) quote needs no preflight: it answers 409 PREFLIGHT_NOT_APPLICABLE.
needs_wallet=false
if preflight=$(tetrafi POST /api/v1/orders/preflight "{\"quoteId\":\"$quote_id\"}" 2>/dev/null); then
  jq -c '{canSubmit, nextActions: [.nextActions[]? | {type, purpose, actor}]}' <<<"$preflight" >&2
  if jq -e 'any(.nextActions[]?; .actor == "userWallet") or (.canSubmit != true)' <<<"$preflight" >/dev/null; then
    needs_wallet=true
  fi
elif [[ $(jq -r '.error // empty' <<<"$preflight" 2>/dev/null) == PREFLIGHT_NOT_APPLICABLE ]]; then
  echo "preflight: not applicable, this is a venue quote" >&2
else
  printf '%s\n' "$preflight" >&2
  exit 1
fi
# endregion

if [[ $needs_wallet == true || ${TETRAFI_PLACE_ORDER:-} != 1 && ${TETRAFI_PLACE_ORDER:-} != yes ]]; then
  # Stop before ordering: your wallet must act first, or you did not ask to place the order.
  jq -c -n --arg q "$quote_id" --argjson w "$needs_wallet" \
    '{quoteId: $q, ordered: false, walletActionRequired: $w}'
  exit 0
fi

# region quickstart-order
order_body=$(jq -c '{quoteId: .id}' <<<"$quote")
if [[ $(jq -r '.commitment.firm' <<<"$quote") != true ]]; then
  # minReceive is the quoted receive less slippage (default 50 bps), rounded down.
  # Without a receive chain, use the lowest precision listed for the native asset.
  decimals=$(jq -er --arg a "$(jq -r '.receive.asset' <<<"$quote")" \
    --arg c "$(jq -r '.receive.chain // empty' <<<"$quote")" '[.assets[] | select(.assetId == $a)
      | .variants[] | select(.kind == "native") | .deployments[]
      | select($c == "" or .chain == $c) | .decimals]
      | if length > 0 then min else error("RECEIVE_ASSET_DECIMALS_MISSING") end' <<<"$assets")
  order_body=$(jq -c --argjson bps "${TETRAFI_SLIPPAGE_BPS:-50}" --argjson d "$decimals" '{quoteId: .id,
    minReceive: ((.receive.amount | tonumber) * (10000 - $bps) / 10000
      | . * pow(10; $d) | floor | . / pow(10; $d) | tostring)}' <<<"$quote")
fi
# One Idempotency-Key per order. Keep it: retrying with the same key and body
# returns the first answer instead of placing a second order.
idempotency_key=$(openssl rand -hex 16)
placed=$(tetrafi POST /api/v1/orders "$order_body" "Idempotency-Key: $idempotency_key")
jq -c '{kind, quoteId}' <<<"$placed" >&2
# endregion

# region quickstart-status
# An Advanced order is read at /orders/{orderId}; a Basic venue trade at its venue connection.
case $(jq -r '.kind' <<<"$placed") in
  advancedTrade)
    order=$(tetrafi GET "/api/v1/orders/$(jq -r '.order.orderId' <<<"$placed")")
    jq -c --arg k "$idempotency_key" \
      '{kind: "advancedTrade", id: .orderId, status, terminal, idempotencyKey: $k}' <<<"$order"
    ;;
  basicTrade)
    path=$(jq -r --arg ws "$TETRAFI_WORKSPACE_ID" '.operation |
      "/api/v1/workspaces/\($ws)/venue-connections/\(.connectionId)/trade-preparations/\(.operationId)"' <<<"$placed")
    trade=$(tetrafi GET "$path")
    jq -c --arg k "$idempotency_key" \
      '{kind: "basicTrade", id: .operationId, status: .executionStatus, idempotencyKey: $k}' <<<"$trade"
    ;;
esac
# endregion
