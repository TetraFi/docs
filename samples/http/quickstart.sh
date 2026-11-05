#!/usr/bin/env bash
# Quickstart: list assets, request quotes, place an order on the best quote and read its status.
#
# Needs bash, curl, jq, openssl and bc (for an exact minimum receive). Reads:
#   TETRAFI_BASE_URL        https://api.tetrafi.io in production
#   TETRAFI_API_KEY         your API key
#   TETRAFI_WORKSPACE_ID    optional: an API key implies its workspace (a session must send it)
#   TETRAFI_SIGNING_SECRET  the key's signing secret, when request signing is on (venue trading needs it)
# Optional:
#   TETRAFI_SELL, TETRAFI_BUY, TETRAFI_AMOUNT  the pair and the amount you sell (default 10 USDC for USDT)
#   TETRAFI_VENUES          comma-separated venue ids to ask, instead of every venue
#   TETRAFI_SLIPPAGE_BPS    how far below a quote that is not firm you accept, in basis points (default 50)
#   TETRAFI_PLACE_ORDER=1 places the order; without it the script stops before ordering
#
# The last line printed is one JSON summary. An API error prints its error body and exits 1.
set -euo pipefail

# region quickstart-client
: "${TETRAFI_BASE_URL:?Set TETRAFI_BASE_URL}"
: "${TETRAFI_API_KEY:?Set TETRAFI_API_KEY}"

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
  if ! response=$(curl -sS --connect-timeout 10 --max-time 60 -X "$method" \
    "$TETRAFI_BASE_URL$path" "${headers[@]}" ${body:+--data "$body"} -w $'\n%{http_code}'); then
    echo 'Request failed in transport; its outcome may be unknown.' >&2
    return 1
  fi
  status=${response##*$'\n'}
  response=${response%$'\n'*}
  printf '%s\n' "$response"
  if [[ ! $status =~ ^2[0-9]{2}$ ]]; then
    printf '%s\n' "$response" >&2
    return 1
  fi
}

# Pair and amount used by the following steps. Keep these in the client snippet
# so copying the guide's cURL blocks works just like running this script.
sell=${TETRAFI_SELL:-USDC}
buy=${TETRAFI_BUY:-USDT}
amount=${TETRAFI_AMOUNT:-10}
# endregion

# region quickstart-assets
assets=$(tetrafi GET /api/v1/assets)
for asset in "$sell" "$buy"; do
  if ! jq -e --arg a "$asset" 'any(.assets[]; .assetId == $a)' <<<"$assets" >/dev/null; then
    echo "{\"error\":\"ASSET_NOT_LISTED\",\"asset\":\"$asset\"}" >&2
    exit 1
  fi
done
echo "assets: $(jq '.assets | length' <<<"$assets") listed, quoting $sell for $buy" >&2
# endregion

# region quickstart-quote
request=$(jq -n --arg sell "$sell" --arg buy "$buy" --arg amount "$amount" \
  --arg venues "${TETRAFI_VENUES:-}" '{
    kind: "pair",
    sell: {asset: $sell},
    buy: {asset: $buy},
    sellAmount: $amount
  } + (if $venues == "" then {} else {filters: {venues: {include: ($venues | split(","))}}} end)')
quotes=$(tetrafi POST /api/v1/quotes "$request")

# Quotes arrive best first (most received, net of fees). Take the best one you can order now.
quote=$(jq -c 'first(.quotes[] | select(.next.kind == "order")) // empty' <<<"$quotes")
if [[ -z $quote ]]; then
  # Every venue asked is listed in sources with its outcome, so an empty result says why.
  jq -c '{error: "NO_ACTIONABLE_QUOTE", sources: [.sources[] | {venue: .venue.id, status, reason}]}' <<<"$quotes" >&2
  exit 1
fi
quote_id=$(jq -r '.id' <<<"$quote")
jq -c '{quoteId: .id, venue: .legs[0].venue.id, mode: .legs[0].venue.integrationMode,
  sell: .sell.amount, buy: .buy.amount, next: .next.kind, expiresAt}' <<<"$quote" >&2
# endregion

if [[ ${TETRAFI_PLACE_ORDER:-} != 1 && ${TETRAFI_PLACE_ORDER:-} != yes ]]; then
  # Stop before ordering: you did not ask to place the order.
  jq -c -n --arg q "$quote_id" '{quoteId: $q, ordered: false}'
  exit 0
fi

# region quickstart-order
# Only decimal strings enter bc: no binary floats, exponent notation or rounding up.
minimum_receive() {
  local amount=$1 bps=$2 decimals=$3 minimum
  if [[ ! $amount =~ ^[0-9]+([.][0-9]+)?$ ||
        ! $bps =~ ^(0|[1-9][0-9]{0,3})$ ||
        ! $decimals =~ ^(0|[1-9][0-9]{0,2})$ ]] || (( decimals > 255 )); then
    echo 'Invalid decimal amount, slippage (0-9999 bps), or asset decimals (0-255).' >&2
    return 1
  fi
  minimum=$(printf 'scale=%s; %s * (10000 - %s) / 10000\n' "$decimals" "$amount" "$bps" | bc)
  minimum=${minimum//$'\\\n'/} # bc may wrap a long result; remove only its line continuations.
  [[ $minimum != .* ]] || minimum="0$minimum"
  if [[ ! $minimum =~ ^[0-9]+([.][0-9]+)?$ || ! $minimum =~ [1-9] ]]; then
    echo 'Minimum receive must be positive; this amount is below the asset precision.' >&2
    return 1
  fi
  printf '%s\n' "$minimum"
}

# Save ./tetrafi-order-<quoteId>.json in the current directory BEFORE sending anything.
# Keep this file after success too. It contains the exact body string, never your API credentials.
[[ $quote_id =~ ^[A-Za-z0-9_-]+$ ]] || { echo 'Invalid quote id.' >&2; exit 1; }
order_record="./tetrafi-order-$quote_id.json"
order_recovery() {
  cat >&2 <<RECOVERY
Order outcome may be unknown. Keep $order_record. Do not rerun the whole script,
request a fresh quote, generate a new key, or place a fresh order to retry this trade.
In a Bash session with the tetrafi helper from step 1, resend the saved body with
the SAME key, then read by quote even if that replay fails:
  order_record='$order_record'
RECOVERY
  cat >&2 <<'RECOVERY'
  saved_record=$(jq -cn '[inputs] | if length == 1 then .[0] else error("ORDER_RECORD_INVALID") end' "$order_record")
  quote_id=$(jq -er '.quoteId' <<<"$saved_record")
  idempotency_key=$(jq -er '.idempotencyKey' <<<"$saved_record")
  order_body=$(jq -er '.exactBody' <<<"$saved_record")
  if ! tetrafi POST /api/v1/orders "$order_body" "Idempotency-Key: $idempotency_key"; then
    echo 'Replay unresolved; still read by quote.' >&2
  fi
  tetrafi GET "/api/v1/orders/by-quote/$quote_id"
ordered: follow statusUrl. unknown or a failed read: wait and read again, never order again.
notOrdered: retry only the saved body and key, and only while expired is false.
RECOVERY
}

if [[ ! -e $order_record && ! -L $order_record ]]; then
  order_body=$(jq -c '{quoteId: .id}' <<<"$quote")
  if [[ $(jq -r '.minReceiveRequired' <<<"$quote") == true ]]; then
    # Without a buy chain, use the lowest precision listed for the native asset.
    decimals=$(jq -er --arg a "$(jq -r '.buy.asset' <<<"$quote")" \
      --arg c "$(jq -r '.buy.chain // empty' <<<"$quote")" '[.assets[] | select(.assetId == $a)
        | .variants[] | select(.kind == "native") | .deployments[]
        | select($c == "" or .chain == $c) | .decimals]
        | if length > 0 then min else error("RECEIVE_ASSET_DECIMALS_MISSING") end' <<<"$assets")
    minimum=$(minimum_receive "$(jq -er '.buy.amount | strings' <<<"$quote")" \
      "${TETRAFI_SLIPPAGE_BPS:-50}" "$decimals")
    order_body=$(jq -c --arg minimum "$minimum" '{quoteId: .id, minReceive: $minimum}' <<<"$quote")
  fi
  idempotency_key=$(openssl rand -hex 16)
  # noclobber also prevents a concurrent run from overwriting the first request's key.
  if ! jq -n --arg q "$quote_id" --arg k "$idempotency_key" --arg b "$order_body" \
    '{quoteId: $q, idempotencyKey: $k, exactBody: $b}' \
    | (umask 077; set -o noclobber; cat > "$order_record"); then
    echo 'Could not save the order record; no order was sent by this run.' >&2
    order_recovery
    exit 1
  fi
fi
# This is local data, not an API response. Read exactly one saved JSON record.
if ! saved_record=$(jq -cn '[inputs] | if length == 1 then .[0] else error("ORDER_RECORD_INVALID") end' "$order_record"); then
  order_recovery
  exit 1
fi
# Re-entering this step for the same quote always reuses its saved key AND body.
if ! jq -e --arg q "$quote_id" '.quoteId == $q
  and (.idempotencyKey | type == "string" and test("^[a-f0-9]{32}$"))
  and (.exactBody | type == "string")
  and (.exactBody | fromjson | .quoteId == $q)' <<<"$saved_record" >/dev/null; then
  echo 'Order record is unreadable or mismatched. Do not replace it with a new key.' >&2
  order_recovery
  exit 1
fi
idempotency_key=$(jq -er '.idempotencyKey' <<<"$saved_record")
order_body=$(jq -er '.exactBody' <<<"$saved_record")
# Any failed POST (including 5xx and 409 IDEMPOTENCY_*) needs recovery, not a new order.
if ! placed=$(tetrafi POST /api/v1/orders "$order_body" "Idempotency-Key: $idempotency_key"); then
  order_recovery
  exit 1
fi
if ! jq -e --arg q "$quote_id" 'type == "object"
  and (.kind | type == "string" and length > 0)
  and (.orderId | type == "string" and length > 0)
  and (.statusUrl | type == "string" and startswith("/api/v1/orders/"))
  and (.status | type == "string" and length > 0)
  and (.terminal | type == "boolean")
  and (.quoteId == null or .quoteId == $q)' <<<"$placed" >/dev/null \
  || [[ $(jq -s 'length' <<<"$placed") != 1 ]]; then
  echo 'Order answer is unreadable; it is not proof that nothing was placed.' >&2
  order_recovery
  exit 1
fi
echo "Order request saved in $order_record; reuse it for every retry." >&2
jq -c '{kind, quoteId}' <<<"$placed" >&2
# endregion

# region quickstart-status
# Read the order at the statusUrl the answer gave: one envelope for Basic and Advanced orders.
# terminal says whether it can still change; next, when present, says what to do meanwhile.
order=$(tetrafi GET "$(jq -r '.statusUrl' <<<"$placed")")
jq -c --arg k "$idempotency_key" '{kind, status, terminal, next, idempotencyKey: $k}' <<<"$order"
# endregion
