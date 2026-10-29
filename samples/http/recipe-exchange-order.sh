#!/usr/bin/env bash
# Recipe: trade on one connected exchange account with an API key. Scope the search to that
# account's venue, check the account holds enough, place the order, recover it by its quote
# as you would after a lost response, and read its status until it ends.
#
# Needs bash, curl, jq and openssl. Reads:
#   TETRAFI_BASE_URL        https://api.tetrafi.io in production
#   TETRAFI_API_KEY         your API key, with venue trading switched on
#   TETRAFI_WORKSPACE_ID    the workspace the key belongs to
#   TETRAFI_SIGNING_SECRET  the key's signing secret (venue trading needs request signing)
# Optional:
#   TETRAFI_VENUE           the venue id of your exchange account (default: the venue of the best
#                           off-chain quote a plain search returns)
#   TETRAFI_PAY, TETRAFI_RECEIVE, TETRAFI_AMOUNT  the pair and the amount you pay (default 5 USDC for USDT)
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

pay=${TETRAFI_PAY:-USDC}
receive=${TETRAFI_RECEIVE:-USDT}
amount=${TETRAFI_AMOUNT:-5}

# region recipe-exchange-venue
# Without TETRAFI_VENUE, find your exchange accounts' venues from one off-chain search: only your
# connected venue accounts answer it.
venue=${TETRAFI_VENUE:-}
if [[ -z $venue ]]; then
  found=$(quote "$(jq -nc --arg pay "$pay" --arg receive "$receive" --arg amount "$amount" '{
    pay: {asset: $pay}, receive: {asset: $receive}, amount: $amount, side: "payExact",
    filters: {locations: ["offChain"]}}')")
  jq -c '.sources[] | select(.status != "filteredOut") | {venue: .venue.id, status, reason}' <<<"$found" >&2
  venue=$(jq -r 'first(.quotes[] | select(.legs[0].venue.integrationMode == "basic") | .legs[0].venue.id) // empty' <<<"$found")
fi
if [[ -z $venue ]]; then
  echo '{"orderable":false,"reason":"NO_VENUE_ACCOUNT_QUOTE"}'
  exit 0
fi
# endregion

# region recipe-exchange-quote
# Ask that venue only. Its quote trades on your account there: tradingSource names it (kind venueAccount).
request=$(jq -nc --arg pay "$pay" --arg receive "$receive" --arg amount "$amount" --arg venue "$venue" '{
  pay: {asset: $pay}, receive: {asset: $receive}, amount: $amount, side: "payExact",
  filters: {venues: {include: [$venue]}}
}')
quotes=$(quote "$request")
jq -c '.sources[] | select(.status != "filteredOut") | {venue: .venue.id, status, reason}' <<<"$quotes" >&2
quote=$(jq -c 'first(.quotes[] | select(.tradingSource.kind == "venueAccount")) // empty' <<<"$quotes")
if [[ -z $quote ]]; then
  jq -c --arg v "$venue" '{venue: $v, orderable: false, sources: [.sources[] | {venue: .venue.id, status, reason}]}' <<<"$quotes"
  exit 0
fi
jq -c '{quoteId: .id, venue: .legs[0].venue.id, mode: .legs[0].venue.integrationMode, commitment: .commitment.kind,
  pay: .pay.amount, receive: .receive.amount, minOut, next: .next.kind, expiresAt}' <<<"$quote" >&2
quote_id=$(jq -r '.id' <<<"$quote")
# endregion

# region recipe-exchange-funds
# An API key cannot read the account's balances, but each quote says whether the account holds
# enough to trade it: readiness "funded", or "shortfall" with the amount missing and next "fund".
jq -c '{readiness}' <<<"$quote" >&2
if [[ $(jq -r '.next.kind' <<<"$quote") != order ]]; then
  jq -c '{quoteId: .id, orderable: false, next: .next.kind, readiness}' <<<"$quote"
  exit 0
fi
# endregion

if [[ ${TETRAFI_PLACE_ORDER:-} != 1 && ${TETRAFI_PLACE_ORDER:-} != yes ]]; then
  jq -c '{quoteId: .id, venue: .legs[0].venue.id, orderable: true, ordered: false}' <<<"$quote"
  exit 0
fi

# region recipe-exchange-order
# An indicative quote executes within your limit: send minReceive, here the quoted amount less
# TETRAFI_SLIPPAGE_BPS (default 50), rounded down to 8 decimal places.
order_body=$(jq -c --argjson bps "${TETRAFI_SLIPPAGE_BPS:-50}" '{quoteId: .id}
  + (if .commitment.kind == "indicative" then {minReceive: ((.receive.amount | tonumber) * (10000 - $bps) / 10000
      | . * 100000000 | floor | . / 100000000 | tostring)} else {} end)' <<<"$quote")
# Store the Idempotency-Key with your record of the order before you send it.
idempotency_key=$(openssl rand -hex 16)
if placed=$(tetrafi POST /api/v1/orders "$order_body" "Idempotency-Key: $idempotency_key"); then
  jq -c '{kind, quoteId, operation: (.operation | {connectionId, operationId})}' <<<"$placed" >&2
elif [[ -n $(jq -r '.error // empty' <<<"$placed" 2>/dev/null) ]]; then
  # A refusal names its code, for example FUNDING_SHORTFALL, and nothing was placed.
  exit 1
fi
# endregion

# region recipe-exchange-recover
# If the order response is lost (a timeout, a dropped connection), never order again with a new
# key. Read the order by its quote: "ordered" gives its address, "notOrdered" means nothing was
# placed, "unknown" means wait and read again.
recovered=$(tetrafi GET "/api/v1/orders/by-quote/$quote_id")
jq -c '{state, order}' <<<"$recovered" >&2
if [[ $(jq -r '.state' <<<"$recovered") != ordered ]]; then
  jq -c --arg q "$quote_id" '{quoteId: $q, ordered: false, state}' <<<"$recovered"
  exit 0
fi
# endregion

# region recipe-exchange-status
# Read the trade at the address the quote gave back. Poll every 10 seconds until it is filled or
# unfilled. outcome_unknown is not a failure: the trade may have filled, so keep reading.
path=$(jq -r --arg ws "$TETRAFI_WORKSPACE_ID" '.order |
  "/api/v1/workspaces/\($ws)/venue-connections/\(.connectionId)/trade-preparations/\(.operationId)"' <<<"$recovered")
for _ in $(seq 1 30); do
  trade=$(tetrafi GET "$path")
  status=$(jq -r '.executionStatus' <<<"$trade")
  echo "{\"executionStatus\":\"$status\"}" >&2
  case $status in filled | unfilled | needs_review) break ;; esac
  sleep 10
done
# Amounts can be null when the venue has not reported them. Bounds are limits, not a fill.
jq -c '{executionStatus, settlementStatus, bounds: (.bounds | {debitAsset, receiptAsset, maximumDebit, minimumReceipt}),
  dispatch: (.dispatch | if . == null then null else {inputSpent, outputReceived, venueOrderId} end)}' <<<"$trade" >&2
# endregion

jq -c --arg q "$quote_id" --arg v "$venue" --arg s "$status" --arg k "$idempotency_key" \
  '{venue: $v, quoteId: $q, kind: .order.kind, id: .order.operationId, status: $s, idempotencyKey: $k}' <<<"$recovered"
