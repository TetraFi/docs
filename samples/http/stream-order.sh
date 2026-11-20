#!/usr/bin/env bash
# Live prices order: read Live prices for one size, take a tradable row's priceId, and order it
# directly with {kind: "stream", priceId, slippageBps}. No quote is requested first: the priceId
# names the venue, the pair, the size you sell and the price you saw; you add only your limit.
#
# Needs bash, curl, jq and openssl. Reads:
#   TETRAFI_BASE_URL        https://api.tetrafi.io in production
#   TETRAFI_API_KEY         your API key, with Read quotes (prices_read) and Place orders (orders_write)
#   TETRAFI_SIGNING_SECRET  the key's signing secret, when request signing is on (venue trading needs it)
# Optional:
#   TETRAFI_SELL, TETRAFI_BUY  the pair (default USD for AAVE)
#   TETRAFI_SIZE               the amount you sell (default 5)
#   TETRAFI_SLIPPAGE_BPS       your limit below the row's receive amount, in basis points (default 100)
#   TETRAFI_PLACE_ORDER=1      actually place the order (otherwise the script stops before ordering)
#
# The last line printed is one JSON summary. An API error prints its error body and exits 1.
set -euo pipefail

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

sell=${TETRAFI_SELL:-USD}
buy=${TETRAFI_BUY:-AAVE}
size=${TETRAFI_SIZE:-5}
slippage_bps=${TETRAFI_SLIPPAGE_BPS:-100}
if [[ ! $slippage_bps =~ ^[0-9]{1,4}$ ]]; then
  echo "TETRAFI_SLIPPAGE_BPS is a whole number of basis points from 0 to 9999." >&2
  exit 1
fi

# region stream-order-price
# A row is tradable when its venue streams executable prices to you.
# Each of its sizes then has a priceId, good for validFor seconds.
prices=$(tetrafi GET "/api/v1/prices?sell=$sell&buy=$buy&sizes=$size")
pick='[.sizes[] | select(.priceId != null)
  | select((.sell | tonumber) == ($size | tonumber))][0]'
row=$(jq -c --arg size "$size" "[.rows[] | select(.tradable == true)
  | select($pick != null)][0] // empty" <<<"$prices")
if [[ -z $row ]]; then
  # notTradableReason says why not: quoteOnly, sizeNotStreamed, ...
  jq -c '{error: "NO_TRADABLE_ROW",
    rows: [.rows[] | {venue: .venue.id, notTradableReason}]}' \
    <<<"$prices" >&2
  exit 1
fi
point=$(jq -c --arg size "$size" "$pick" <<<"$row")
jq -c --argjson p "$point" \
  '{venue: .venue.id, sell: $p.sell, buy: $p.buy, validFor}' <<<"$row" >&2
# endregion

if [[ ${TETRAFI_PLACE_ORDER:-} != 1 ]]; then
  jq -nc --argjson row "$row" --argjson p "$point" \
    '{ok: true, venue: $row.venue.id, sell: $p.sell, buy: $p.buy, validFor: $row.validFor, ordered: false}'
  exit 0
fi

# region stream-order-place
# Exactly one limit: slippageBps below the price's receive amount,
# or minReceive. Order at once: the priceId lapses after validFor
# seconds, and it orders only once.
price_id=$(jq -r '.priceId' <<<"$point")
order_body=$(jq -nc --arg id "$price_id" --argjson bps "$slippage_bps" \
  '{kind: "stream", priceId: $id, slippageBps: $bps}')
# Save the key with the exact body first: a retry after a timeout
# resends both unchanged and gets the first answer, never a 2nd order.
key=$(openssl rand -hex 16)
record=${TETRAFI_ORDER_RECORD:-stream-order-$key.json}
jq -nc --arg k "$key" --argjson b "$order_body" \
  '{idempotencyKey: $k, body: $b}' >"$record"
placed=$(tetrafi POST /api/v1/orders "$order_body" "Idempotency-Key: $key")
# Now an ordinary order: read statusUrl until terminal is true.
status_url=$(jq -r '.statusUrl' <<<"$placed")
order=$(tetrafi GET "$status_url")
for _ in $(seq 1 60); do
  [[ $(jq -r '.terminal' <<<"$order") == true ]] && break
  sleep 2
  order=$(tetrafi GET "$status_url")
done
jq -c '{orderId, kind, status, terminal}' <<<"$order" >&2
# endregion

jq -nc --argjson row "$row" --argjson p "$point" --argjson o "$order" --arg k "$key" \
  '{ok: true, venue: $row.venue.id, sell: $p.sell, buy: $p.buy, ordered: true,
    orderId: $o.orderId, status: $o.status, terminal: $o.terminal, idempotencyKey: $k}'
