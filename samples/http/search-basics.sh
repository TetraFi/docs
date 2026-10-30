#!/usr/bin/env bash
# Search basics: one quote request for each way you can shape a search, plus the free price read.
#
# Needs bash, curl, jq and openssl. Reads:
#   TETRAFI_BASE_URL        https://api.tetrafi.io in production
#   TETRAFI_API_KEY         your API key
#   TETRAFI_WORKSPACE_ID    optional: an API key implies its workspace (a session must send it)
#   TETRAFI_SIGNING_SECRET  the key's signing secret, when request signing is on (venue trading needs it)
# Optional:
#   TETRAFI_PAY, TETRAFI_RECEIVE   the pair (default USDC for ETH); both must be listed by GET /assets
#   TETRAFI_AMOUNT                 the amount you pay (default 10)
#   TETRAFI_RECEIVE_AMOUNT         the amount you receive, for the receive-exact search (default 0.001)
#   TETRAFI_CROSS_AMOUNT           the amount you move between chains (default 1)
#   TETRAFI_FROM_CHAIN, TETRAFI_TO_CHAIN  CAIP-2 chains for the cross-chain search (default: the
#                                  first two chains GET /assets lists for the pay asset)
#
# Every search asks for quotes only: nothing is ordered. The last line printed is one JSON
# summary of every request. An API error prints its error body and exits 1.
set -euo pipefail

: "${TETRAFI_BASE_URL:?Set TETRAFI_BASE_URL}"
: "${TETRAFI_API_KEY:?Set TETRAFI_API_KEY}"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

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

# quote_request BODY
# POST /api/v1/quotes through tetrafi. You may send one live quote request every 3 seconds;
# a faster one answers 429 QUOTE_RATE_LIMITED with a Retry-After header, and the same wait in
# details.retryAfter (for example PT1S). This waits that long and tries once more.
quote_request() {
  local response wait
  if response=$(tetrafi POST /api/v1/quotes "$1" 2>/dev/null); then
    printf '%s\n' "$response"
    return 0
  fi
  wait=$(jq -r 'select(.error == "QUOTE_RATE_LIMITED") | .details.retryAfter
    | capture("^PT(?<s>[0-9]+)S$").s' <<<"$response" 2>/dev/null || true)
  if [[ -z $wait ]]; then
    printf '%s\n' "$response" >&2
    return 1
  fi
  sleep "$wait"
  tetrafi POST /api/v1/quotes "$1"
}

# stream_request BODY
# POST /api/v1/quotes with Accept: text/event-stream, printing the events as they arrive.
# The response headers land in $tmp/stream-headers so the caller can check the status.
stream_request() {
  local body=$1 headers=(
    -H "X-API-Key: $TETRAFI_API_KEY"
    -H "Accept: text/event-stream"
    -H "Content-Type: application/json"
  )
  if [[ -n ${TETRAFI_WORKSPACE_ID:-} ]]; then headers+=(-H "X-Workspace-Id: $TETRAFI_WORKSPACE_ID"); fi
  if [[ -n ${TETRAFI_SIGNING_SECRET:-} ]]; then
    local timestamp digest signature
    timestamp=$(date +%s)
    digest=$(printf '%s' "$body" | openssl dgst -sha256 -r | cut -d' ' -f1)
    signature=$(printf '%s\n%s\n%s\n%s' "$timestamp" POST /api/v1/quotes "$digest" \
      | openssl dgst -sha256 -mac HMAC -macopt "hexkey:$TETRAFI_SIGNING_SECRET" -r | cut -d' ' -f1)
    headers+=(-H "X-Timestamp: $timestamp" -H "X-Signature: $signature")
  fi
  curl -sS -N -X POST "$TETRAFI_BASE_URL/api/v1/quotes" "${headers[@]}" \
    -D "$tmp/stream-headers" --data "$body"
}

# outcome NAME RESPONSE: one summary entry for a quote set. Quotes, and every venue's
# outcome counted by status. Treat a status you do not know as "other".
results='[]'
outcome() {
  local entry
  entry=$(jq -c --arg name "$1" '{
    request: $name,
    quotes: (.quotes | length),
    locations: ([.quotes[].location.kind] | unique),
    commitments: ([.quotes[].commitment | if .kind == "executable" then (if .firm then "firm" else "executable" end) else .kind end] | unique),
    sources: (.sources | length),
    outcomes: (reduce .sources[] as $s ({}; .[$s.status] += 1))
  }' <<<"$2")
  results=$(jq -c --argjson e "$entry" '. + [$e]' <<<"$results")
}

pay=${TETRAFI_PAY:-USDC}
receive=${TETRAFI_RECEIVE:-ETH}
amount=${TETRAFI_AMOUNT:-10}
receive_amount=${TETRAFI_RECEIVE_AMOUNT:-0.001}
cross_amount=${TETRAFI_CROSS_AMOUNT:-1}

# Discover the pair from GET /assets: every Asset your workspace can reach, each variant with
# the chains it is deployed on (CAIP-2) and the off-chain venues that hold it.
assets=$(tetrafi GET /api/v1/assets)
for asset in "$pay" "$receive"; do
  if ! jq -e --arg a "$asset" 'any(.assets[]; .assetId == $a)' <<<"$assets" >/dev/null; then
    jq -nc --arg a "$asset" '{error: "ASSET_NOT_LISTED", asset: $a}' >&2
    exit 1
  fi
done
chains_of() { jq -c --arg a "$1" '[.assets[] | select(.assetId == $a) | .variants[].deployments[].chain] | unique' <<<"$assets"; }
pay_chains=$(chains_of "$pay")
shared_chains=$(jq -c --argjson r "$(chains_of "$receive")" 'map(select(. as $c | $r | index($c)))' <<<"$pay_chains")

# region search-pay-exact
# Pay exactly `amount` of the pay asset. Each quote states what you would receive.
request=$(jq -nc --arg pay "$pay" --arg receive "$receive" --arg amount "$amount" '{
  pay: {asset: $pay},
  receive: {asset: $receive},
  amount: $amount,
  side: "payExact"
}')
pay_exact=$(quote_request "$request")
jq -c '.quotes[] | {venue: .legs[0].venue.id, location: .location.kind,
  commitment: .commitment.kind, pay: .pay.amount, receive: .receive.amount, expiresAt}' <<<"$pay_exact" >&2
# endregion
outcome payExact "$pay_exact"

# region search-receive-exact
# Receive exactly `receive_amount` of the receive asset. Each quote states what you would pay.
# A venue that only prices the amount you pay is listed in sources as unsupported.
request=$(jq -nc --arg pay "$pay" --arg receive "$receive" --arg amount "$receive_amount" '{
  pay: {asset: $pay},
  receive: {asset: $receive},
  amount: $amount,
  side: "receiveExact"
}')
receive_exact=$(quote_request "$request")
jq -c '.quotes[] | {venue: .legs[0].venue.id, pay: .pay.amount, receive: .receive.amount}' <<<"$receive_exact" >&2
jq -c '[.sources[] | select(.status == "unsupported") | {venue: .venue.id, reason}]' <<<"$receive_exact" >&2
# endregion
outcome receiveExact "$receive_exact"

# region search-single-chain
# Pin both sides to one chain and keep only quotes that execute on it.
# The chain comes from discovery: one both assets are deployed on, preferring one a venue just quoted.
chain=$(jq -r '[.quotes[] | select(.location.kind == "singleChain") | .pay.chain][0] // empty' <<<"$pay_exact")
if [[ -z $chain ]]; then chain=$(jq -r '.[0] // empty' <<<"$shared_chains"); fi
if [[ -z $chain ]]; then
  jq -nc --arg p "$pay" --arg r "$receive" '{error: "NO_SHARED_CHAIN", pay: $p, receive: $r}' >&2
  exit 1
fi
request=$(jq -nc --arg pay "$pay" --arg receive "$receive" --arg amount "$amount" --arg chain "$chain" '{
  pay: {asset: $pay, chain: $chain},
  receive: {asset: $receive, chain: $chain},
  amount: $amount,
  side: "payExact",
  filters: {locations: ["singleChain"]}
}')
single_chain=$(quote_request "$request")
jq -c '{chain: $c, quotes: [.quotes[] | {venue: .legs[0].venue.id, receive: .receive.amount}]}' \
  --arg c "$chain" <<<"$single_chain" >&2
# endregion
outcome singleChain "$single_chain"

# region search-cross-chain
# Move the pay asset from one chain to another. The same asset on both sides needs a chain pin,
# or the request is refused with SAME_ASSET_NEEDS_CHAIN.
from_chain=${TETRAFI_FROM_CHAIN:-$(jq -r '.[0] // empty' <<<"$pay_chains")}
to_chain=${TETRAFI_TO_CHAIN:-$(jq -r '.[1] // empty' <<<"$pay_chains")}
if [[ -z $to_chain ]]; then
  jq -nc --arg a "$pay" '{error: "ONE_CHAIN_ONLY", asset: $a}' >&2
  exit 1
fi
request=$(jq -nc --arg asset "$pay" --arg amount "$cross_amount" --arg from "$from_chain" --arg to "$to_chain" '{
  pay: {asset: $asset, chain: $from},
  receive: {asset: $asset, chain: $to},
  amount: $amount,
  side: "payExact",
  filters: {locations: ["crossChain"]}
}')
cross_chain=$(quote_request "$request")
jq -c '{from: $f, to: $t, quotes: [.quotes[] | {venue: .legs[0].venue.id, receive: .receive.amount, eta}]}' \
  --arg f "$from_chain" --arg t "$to_chain" <<<"$cross_chain" >&2
# endregion
outcome crossChain "$cross_chain"

# region search-off-chain
# Keep only quotes that execute on a venue account (an exchange or desk). No chain pins:
# a pinned chain with only offChain allowed is refused with CHAIN_PIN_NEEDS_ON_CHAIN.
request=$(jq -nc --arg pay "$pay" --arg receive "$receive" --arg amount "$amount" '{
  pay: {asset: $pay},
  receive: {asset: $receive},
  amount: $amount,
  side: "payExact",
  filters: {locations: ["offChain"]}
}')
off_chain=$(quote_request "$request")
jq -c '[.quotes[] | {venue: .legs[0].venue.id, commitment: .commitment, receive: .receive.amount}]' <<<"$off_chain" >&2
jq -c '[.sources[] | select(.status == "filteredOut") | .venue.id]' <<<"$off_chain" >&2
# endregion
outcome offChain "$off_chain"

# region search-stream
# The same request as a stream: each quote and each venue's outcome arrives as its own event,
# then `complete` carries the whole set. One live quote request every 3 seconds, so wait first.
sleep 3
request=$(jq -nc --arg pay "$pay" --arg receive "$receive" --arg amount "$amount" '{
  pay: {asset: $pay},
  receive: {asset: $receive},
  amount: $amount,
  side: "payExact"
}')
event="" complete="" quote_events=0 source_events=0 other=""
while IFS= read -r line; do
  line=${line%$'\r'}
  case $line in
    "event: "*) event=${line#event: } ;;
    "data: "*)
      data=${line#data: }
      case $event in
        quote) quote_events=$((quote_events + 1)) ;;   # one PairQuote, best shown as it lands
        source) source_events=$((source_events + 1)) ;; # one venue's outcome
        complete) complete=$data ;;                     # the full quote set, as the JSON reply
        error) printf '%s\n' "$data" >&2; exit 1 ;;
      esac ;;
    ""|":"*|"id: "*) ;;                                 # event separators, keepalives, event ids
    *) other+=$line ;;                                  # not an event: an error body
  esac
done < <(stream_request "$request")
if [[ -z $complete ]]; then
  if [[ -z $other ]]; then other='{"error":"STREAM_ENDED_WITHOUT_COMPLETE"}'; fi
  printf '%s\n' "$other" >&2
  exit 1
fi
echo "stream: $quote_events quote events, $source_events source events, then complete" >&2
# endregion
outcome stream "$complete"
results=$(jq -c --argjson q "$quote_events" --argjson s "$source_events" \
  '.[-1] += {quoteEvents: $q, sourceEvents: $s}' <<<"$results")

# region search-prices
# Prices for the pair from memory: no venue is asked, so it costs no quote request.
# Each row is one venue, location and variant pair. Rows are indicative, never orderable.
path="/api/v1/prices?pay=$pay&receive=$receive&amount=$amount&side=payExact"
prices=$(tetrafi GET "$path")
jq -c '{referenceMid: .referenceMid.receivePerPay, rows: [.rows[] | {venue: .venue.id,
  location: .location.kind, status, receive: .sizes[0].receive}]}' <<<"$prices" >&2
# endregion
prices_summary=$(jq -c '{request: "prices", rows: (.rows | length),
  referenceMid: (.referenceMid != null), statuses: (reduce .rows[] as $r ({}; .[$r.status] += 1))}' <<<"$prices")

jq -nc --arg pay "$pay" --arg receive "$receive" --argjson assets "$(jq '.assets | length' <<<"$assets")" \
  --argjson results "$results" --argjson prices "$prices_summary" \
  '{pair: {pay: $pay, receive: $receive}, assetsListed: $assets, requests: ($results + [$prices])}'
