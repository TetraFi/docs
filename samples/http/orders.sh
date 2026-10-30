#!/usr/bin/env bash
# Orders: requote a quote, place an order safely with an Idempotency-Key, replay it, recover it
# by quote, read its status, and refresh a quote that expired.
#
# Needs bash, curl, jq and openssl. Reads:
#   TETRAFI_BASE_URL        https://api.tetrafi.io in production
#   TETRAFI_API_KEY         your API key
#   TETRAFI_WORKSPACE_ID    optional: an API key implies its workspace (a session must send it)
#   TETRAFI_SIGNING_SECRET  the key's signing secret, when request signing is on (venue trading needs it)
# Optional:
#   TETRAFI_PAY, TETRAFI_RECEIVE, TETRAFI_AMOUNT  the pair and the amount you pay (default 5 USDC for USDT)
#   TETRAFI_VENUES          comma-separated venue ids to ask, instead of every venue
#   TETRAFI_PLACE_ORDER=1   places one order, replays it and recovers it by quote (yes also works)
#   TETRAFI_EXPIRED=yes     waits for the first quote to expire, tries to order it, then requotes it
#
# Progress goes to stderr; the last line printed is one JSON summary. An unexpected API error
# prints its error body and exits 1.
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

# error_of RESPONSE: the error code of a refusal body, or nothing.
error_of() { jq -r '.error // empty' <<<"$1" 2>/dev/null; }

pay=${TETRAFI_PAY:-USDC}
receive=${TETRAFI_RECEIVE:-USDT}
amount=${TETRAFI_AMOUNT:-5}
summary='{}'

request=$(jq -n --arg pay "$pay" --arg receive "$receive" --arg amount "$amount" \
  --arg venues "${TETRAFI_VENUES:-}" '{
    pay: {asset: $pay}, receive: {asset: $receive}, amount: $amount, side: "payExact"
  } + (if $venues == "" then {} else {filters: {venues: {include: ($venues | split(","))}}} end)')
quotes=$(quote "$request")
first=$(jq -c 'first(.quotes[] | select(.next.kind == "order")) // empty' <<<"$quotes")
if [[ -z $first ]]; then
  jq -c '{error: "NO_ORDERABLE_QUOTE", sources: [.sources[] | {venue: .venue.id, status, reason}]}' <<<"$quotes" >&2
  exit 1
fi
quote_id=$(jq -r '.id' <<<"$first")
jq -c '{quoteId: .id, venue: .legs[0].venue.id, commitment, receive: .receive.amount, minOut, expiresAt}' <<<"$first" >&2

# region requote-again
# Ask the same venue again for the same pair, amount and side. The answer is a new quote whose
# requoteOf names the original. The original stays orderable until its own expiresAt.
requoted=$(quote "{\"requote\":\"$quote_id\"}")
fresh=$(jq -c '.quotes[0]' <<<"$requoted")
jq -c '{quoteId: .id, requoteOf, commitment, receive: .receive.amount, minOut, expiresAt}' <<<"$fresh" >&2
# endregion
summary=$(jq -c --argjson q "$fresh" '. + {requote: {id: $q.id, requoteOf: $q.requoteOf}}' <<<"$summary")

# region requote-protection
# Change the price protection for the new quote. A wider protection lowers minOut, the least
# a non-firm quote may deliver.
protected=$(quote "{\"requote\":\"$quote_id\",\"priceProtectionBps\":50}")
jq -c '.quotes[0] | {quoteId: .id, requoteOf, receive: .receive.amount, minOut}' <<<"$protected" >&2
# endregion
# Quotes expire within seconds, so the order below uses the newest quote.
order_quote=$(jq -r '.quotes[0].id' <<<"$protected")

if [[ ${TETRAFI_PLACE_ORDER:-} == 1 || ${TETRAFI_PLACE_ORDER:-} == yes ]]; then
  # region order-place
  # Generate one Idempotency-Key per order and store it with the order before you send it.
  idempotency_key=$(openssl rand -hex 16)
  order_body="{\"quoteId\":\"$order_quote\"}"
  placed=$(tetrafi POST /api/v1/orders "$order_body" "Idempotency-Key: $idempotency_key")
  # A basicTrade names its venue trade in operation; an advancedTrade names its order in order.
  jq -c '{kind, quoteId} + if .kind == "basicTrade" then {operation: (.operation | {connectionId, operationId})}
    else {order: (.order | {orderId})} end' <<<"$placed" >&2
  # endregion

  # region order-idempotent-replay
  # Same key, same body: you get the first answer back and no second order is placed.
  # Use this to retry after a timeout or a dropped connection.
  replayed=$(tetrafi POST /api/v1/orders "$order_body" "Idempotency-Key: $idempotency_key")
  jq -n -c --argjson a "$placed" --argjson b "$replayed" \
    '{replayedSameOrder: (($a.operation.operationId // $a.order.orderId) == ($b.operation.operationId // $b.order.orderId))}' >&2
  # endregion

  # region order-idempotency-conflict
  # Same key, different body: refused with 409 IDEMPOTENCY_CONFLICT. Nothing is placed.
  changed="{\"quoteId\":\"$order_quote\",\"minReceive\":\"1000000\"}"
  if conflict=$(tetrafi POST /api/v1/orders "$changed" "Idempotency-Key: $idempotency_key" 2>/dev/null); then
    echo '{"error":"EXPECTED_IDEMPOTENCY_CONFLICT"}' >&2
    exit 1
  fi
  echo "{\"reusedKeyWithNewBody\":\"$(error_of "$conflict")\"}" >&2
  # endregion

  # region order-recover-by-quote
  # When you cannot tell whether an order was placed, read it by its quote id before doing
  # anything else. ordered: read the order at statusUrl. notOrdered: nothing was placed.
  # unknown: wait, then read again.
  recovered=$(tetrafi GET "/api/v1/orders/by-quote/$order_quote")
  jq -c '{state, statusUrl}' <<<"$recovered" >&2
  unordered=$(tetrafi GET "/api/v1/orders/by-quote/$quote_id")
  jq -c '{state, expired}' <<<"$unordered" >&2
  # endregion
  summary=$(jq -c --argjson p "$placed" --argjson r "$recovered" --arg c "$(error_of "$conflict")" '. + {order: {
    kind: $p.kind, quoteId: $p.quoteId, id: ($p.operation.operationId // $p.order.orderId),
    conflict: $c, recovered: $r.state}}' <<<"$summary")

  # region order-status
  # Read the order at the statusUrl its answer gave: the same envelope as POST /orders, for
  # Basic and Advanced orders alike. Poll every 10 to 15 seconds until terminal is true. While it
  # is not, next can say what to do: wait (retryAfter) or contact support with its reference.
  # A status you do not recognise is "other": keep following terminal.
  status_url=$(jq -r '.statusUrl' <<<"$placed")
  for _ in $(seq 1 12); do
    read_order=$(tetrafi GET "$status_url")
    jq -c '{kind, status, terminal, next}' <<<"$read_order" >&2
    [[ $(jq -r '.terminal' <<<"$read_order") == true ]] && break
    wait=$(jq -r '.next | select(.kind == "wait") | .retryAfter | capture("^PT(?<s>[0-9]+)S$").s' \
      <<<"$read_order" 2>/dev/null || true)
    sleep "${wait:-10}"
  done
  # endregion
  summary=$(jq -c --arg s "$(jq -r '.status' <<<"$read_order")" --arg t "$(jq -r '.terminal' <<<"$read_order")" \
    '.order.status = $s | .order.terminal = ($t == "true")' <<<"$summary")
fi

if [[ ${TETRAFI_EXPIRED:-} == yes ]]; then
  refreshed='{}'
  # region requote-expired
  # Ordering a quote after its expiresAt is refused with 410 QUOTE_EXPIRED and next.kind
  # "requote". Requote it, up to 10 minutes after it expired, to get a fresh price from that venue.
  expires=$(jq -r '.expiresAt' <<<"$first")
  until [[ $(date -u +%Y-%m-%dT%H:%M:%S) > ${expires%.*} ]]; do sleep 1; done
  if lapsed=$(tetrafi POST /api/v1/orders "{\"quoteId\":\"$quote_id\"}" \
    "Idempotency-Key: $(openssl rand -hex 16)" 2>/dev/null); then
    echo '{"error":"EXPECTED_QUOTE_EXPIRED"}' >&2
    exit 1
  fi
  jq -c '{error, next}' <<<"$lapsed" >&2
  if [[ $(error_of "$lapsed") == QUOTE_EXPIRED ]]; then
    refreshed=$(quote "{\"requote\":\"$quote_id\"}")
    jq -c '.quotes[0] | {quoteId: .id, requoteOf, receive: .receive.amount, expiresAt}' <<<"$refreshed" >&2
  fi
  # endregion
  summary=$(jq -c --arg e "$(error_of "$lapsed")" --argjson n "$(jq -c '.next' <<<"$lapsed")" \
    --arg r "$(jq -r '.quotes[0].requoteOf // empty' <<<"$refreshed")" \
    '. + {expired: {error: $e, next: $n, requoteOf: $r}}' <<<"$summary")
fi

jq -c --arg q "$quote_id" '{quoteId: $q} + .' <<<"$summary"
