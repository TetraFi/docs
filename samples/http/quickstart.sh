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
#
# The functions below are this script's plumbing: request signing, input checks, the local order
# record and recovery guidance. The regions further down (published on the Quickstart page) are the
# API flow itself.
set -euo pipefail

# ---------------------------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------------------------

# add_signature METHOD PATH BODY
# Appends X-Timestamp and X-Signature (and, on a write, X-Nonce) to the caller's `headers` array.
add_signature() {
  local method=$1 path=$2 body=$3 timestamp digest signature canonical
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
}

# send_request METHOD URL BODY [CURL_ARGS...]
# Prints the response body. On a transport error, or a non-2xx status (whose body it also prints
# to stderr), it returns 1.
send_request() {
  local method=$1 url=$2 body=$3 response status
  shift 3
  if ! response=$(curl -sS --connect-timeout 10 --max-time 60 -X "$method" \
    "$url" "$@" ${body:+--data "$body"} -w $'\n%{http_code}'); then
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

# fail_no_actionable_quote QUOTES_RESPONSE: prints each venue's outcome from sources, then exits 1.
fail_no_actionable_quote() {
  jq -c '{error: "NO_ACTIONABLE_QUOTE", sources: [.sources[] | {venue: .venue.id, status, reason}]}' <<<"$1" >&2
  exit 1
}

# minimum_receive AMOUNT BPS DECIMALS
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

# quote_min_receive QUOTE ASSETS_RESPONSE BPS
# The quote's buy.amount less BPS, rounded down to the receive asset's decimals. Without a buy
# chain, it uses the lowest precision listed for the native asset.
quote_min_receive() {
  local quote=$1 assets=$2 bps=$3 decimals buy_amount
  decimals=$(jq -er --arg a "$(jq -r '.buy.asset' <<<"$quote")" \
    --arg c "$(jq -r '.buy.chain // empty' <<<"$quote")" '[.items[] | select(.assetId == $a)
      | .variants[] | select(.kind == "native") | .deployments[]
      | select($c == "" or .chain == $c) | .decimals]
      | if length > 0 then min else error("RECEIVE_ASSET_DECIMALS_MISSING") end' <<<"$assets") || return 1
  buy_amount=$(jq -er '.buy.amount | strings' <<<"$quote") || buy_amount=''
  minimum_receive "$buy_amount" "$bps" "$decimals"
}

# order_record_path QUOTE_ID: ./tetrafi-order-<quoteId>.json in the current directory.
order_record_path() {
  [[ $1 =~ ^[A-Za-z0-9_-]+$ ]] || { echo 'Invalid quote id.' >&2; return 1; }
  printf '%s\n' "./tetrafi-order-$1.json"
}

# order_recovery: what to do when the order's outcome may be unknown (reads $order_record).
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

# save_order_record QUOTE_ID IDEMPOTENCY_KEY BODY
# Writes {quoteId, idempotencyKey, exactBody} to $order_record, readable only by you. It holds the
# exact body string, never your API credentials. noclobber also stops a concurrent run from
# overwriting the first request's key. On failure it prints recovery guidance and exits 1.
save_order_record() {
  if ! jq -n --arg q "$1" --arg k "$2" --arg b "$3" \
    '{quoteId: $q, idempotencyKey: $k, exactBody: $b}' \
    | (umask 077; set -o noclobber; cat > "$order_record"); then
    echo 'Could not save the order record; no order was sent by this run.' >&2
    order_recovery
    exit 1
  fi
}

# load_order_record QUOTE_ID
# Reads exactly one saved JSON record from $order_record (local data, not an API response), checks
# it belongs to QUOTE_ID, and sets idempotency_key and order_body from it. Re-entering the order
# step for the same quote therefore always reuses its saved key AND body. On a bad record it prints
# recovery guidance and exits 1.
load_order_record() {
  local quote_id=$1 saved_record
  if ! saved_record=$(jq -cn '[inputs] | if length == 1 then .[0] else error("ORDER_RECORD_INVALID") end' "$order_record"); then
    order_recovery
    exit 1
  fi
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
}

# check_order_answer ANSWER QUOTE_ID: returns 1 unless ANSWER is one well-formed order envelope.
check_order_answer() {
  if ! jq -e --arg q "$2" 'type == "object"
    and (.kind | type == "string" and length > 0)
    and (.orderId | type == "string" and length > 0)
    and (.statusUrl | type == "string" and startswith("/api/v1/orders/"))
    and (.status | type == "string" and length > 0)
    and (.terminal | type == "boolean")
    and (.quoteId == null or .quoteId == $q)' <<<"$1" >/dev/null \
    || [[ $(jq -s 'length' <<<"$1") != 1 ]]; then
    echo 'Order answer is unreadable; it is not proof that nothing was placed.' >&2
    return 1
  fi
}

# ---------------------------------------------------------------------------------------------
# The API flow
# ---------------------------------------------------------------------------------------------

# region quickstart-client
: "${TETRAFI_BASE_URL:?Set TETRAFI_BASE_URL}"
: "${TETRAFI_API_KEY:?Set TETRAFI_API_KEY}"

# tetrafi METHOD PATH [BODY] [HEADER]: sends one request with your key and prints the response body.
tetrafi() {
  local method=$1 path=$2 body=${3:-} extra=${4:-}
  local headers=(-H "X-API-Key: $TETRAFI_API_KEY" -H "Accept: application/json")
  if [[ -n ${TETRAFI_WORKSPACE_ID:-} ]]; then headers+=(-H "X-Workspace-Id: $TETRAFI_WORKSPACE_ID"); fi
  if [[ -n $body ]]; then headers+=(-H "Content-Type: application/json"); fi
  if [[ -n $extra ]]; then headers+=(-H "$extra"); fi
  # With request signing on, sign every request: X-Timestamp and X-Signature, plus X-Nonce on writes.
  if [[ -n ${TETRAFI_SIGNING_SECRET:-} ]]; then add_signature "$method" "$path" "$body"; fi
  send_request "$method" "$TETRAFI_BASE_URL$path" "$body" "${headers[@]}"
}

# The pair and the amount you sell.
sell=${TETRAFI_SELL:-USDC}
buy=${TETRAFI_BUY:-USDT}
amount=${TETRAFI_AMOUNT:-10}
# endregion

# region quickstart-assets
assets=$(tetrafi GET /api/v1/assets)
for asset in "$sell" "$buy"; do
  if ! jq -e --arg a "$asset" 'any(.items[]; .assetId == $a)' <<<"$assets" >/dev/null; then
    echo "{\"error\":\"ASSET_NOT_LISTED\",\"asset\":\"$asset\"}" >&2
    exit 1
  fi
done
echo "assets: $(jq '.items | length' <<<"$assets") listed, quoting $sell for $buy" >&2
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
# If there is none, sources lists every venue asked with its status and reason.
quote=$(jq -c 'first(.quotes[] | select(.next.kind == "order")) // empty' <<<"$quotes")
[[ -n $quote ]] || fail_no_actionable_quote "$quotes"
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
# Save the order before sending it: quote id, a new Idempotency-Key and the exact body.
# A retry with the same key and body returns the first answer, never a second order.
order_record=$(order_record_path "$quote_id")
if [[ ! -e $order_record && ! -L $order_record ]]; then
  order_body=$(jq -c '{quoteId: .id}' <<<"$quote")
  if [[ $(jq -r '.minReceiveRequired' <<<"$quote") == true ]]; then
    # minReceive: the quoted buy.amount less your slippage, rounded down to the asset's decimals.
    min_receive=$(quote_min_receive "$quote" "$assets" "${TETRAFI_SLIPPAGE_BPS:-50}")
    order_body=$(jq -c --arg m "$min_receive" '{quoteId: .id, minReceive: $m}' <<<"$quote")
  fi
  save_order_record "$quote_id" "$(openssl rand -hex 16)" "$order_body"
fi
load_order_record "$quote_id" # every retry for this quote reuses the saved key and body

# A timeout, 5xx, 409 IDEMPOTENCY_* or unreadable answer does not prove the order failed:
# resend the saved body with the same key, then read GET /api/v1/orders/by-quote/{quoteId}.
if ! placed=$(tetrafi POST /api/v1/orders "$order_body" "Idempotency-Key: $idempotency_key") \
  || ! check_order_answer "$placed" "$quote_id"; then
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
