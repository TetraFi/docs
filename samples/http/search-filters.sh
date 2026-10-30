#!/usr/bin/env bash
# Search filters: one quote request for each way you can narrow or order a search.
#
# Needs bash, curl, jq and openssl. Reads:
#   TETRAFI_BASE_URL        https://api.tetrafi.io in production
#   TETRAFI_API_KEY         your API key
#   TETRAFI_WORKSPACE_ID    optional: an API key implies its workspace (a session must send it)
#   TETRAFI_SIGNING_SECRET  the key's signing secret, when request signing is on (venue trading needs it)
# Optional:
#   TETRAFI_PAY, TETRAFI_RECEIVE   the pair (default USDC for ETH); both must be listed by GET /assets
#   TETRAFI_AMOUNT                 the amount you pay (default 10)
#   TETRAFI_MODALITIES             comma-separated venue types to keep (default orderBook)
#   TETRAFI_VENUE                  the venue id to keep or drop (default: the first venue that
#                                  answers a plain search)
#   TETRAFI_PROTECTION_BPS         price protection in basis points, 0 to 1000 (default 100)
#   TETRAFI_PROTECTION_AMOUNT      the amount you pay in the price protection search (default 1000)
#   TETRAFI_RECEIVE_AMOUNT         the amount you receive in its receive-exact search (default 0.001)
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
modalities=${TETRAFI_MODALITIES:-orderBook}
protection_bps=${TETRAFI_PROTECTION_BPS:-100}
protection_amount=${TETRAFI_PROTECTION_AMOUNT:-1000}
receive_amount=${TETRAFI_RECEIVE_AMOUNT:-0.001}

# Discover the pair from GET /assets: every Asset your workspace can reach, each variant with
# the chains it is deployed on (CAIP-2) and the off-chain venues that hold it.
assets=$(tetrafi GET /api/v1/assets)
for asset in "$pay" "$receive"; do
  if ! jq -e --arg a "$asset" 'any(.assets[]; .assetId == $a)' <<<"$assets" >/dev/null; then
    jq -nc --arg a "$asset" '{error: "ASSET_NOT_LISTED", asset: $a}' >&2
    exit 1
  fi
done

# A plain search first. The venues that answer it give the venue id the venue filters use:
# venue ids come from sources[].venue.id (or GET /api/v1/prices rows), never from a fixed list.
request=$(jq -nc --arg pay "$pay" --arg receive "$receive" --arg amount "$amount" '{
  pay: {asset: $pay},
  receive: {asset: $receive},
  amount: $amount,
  side: "payExact"
}')
plain=$(quote_request "$request")
outcome plain "$plain"
venue=${TETRAFI_VENUE:-$(jq -r '[.sources[] | select(.status == "answered") | .venue.id][0] // empty' <<<"$plain")}
if [[ -z $venue ]]; then
  jq -nc '{error: "NO_VENUE_ANSWERED"}' >&2
  exit 1
fi

# region search-modalities
# Keep only venues of the types you list: amm, solver, bridge, rfq, orderBook or fiat.
# Every venue of another type is listed in sources as filteredOut and is not asked.
request=$(jq -nc --arg pay "$pay" --arg receive "$receive" --arg amount "$amount" --arg types "$modalities" '{
  pay: {asset: $pay},
  receive: {asset: $receive},
  amount: $amount,
  side: "payExact",
  filters: {modalities: ($types | split(","))}
}')
by_type=$(quote_request "$request")
jq -c '[.quotes[] | {venue: .legs[0].venue.id, modality: .legs[0].venue.modality, receive: .receive.amount}]' <<<"$by_type" >&2
jq -c '[.sources[] | select(.status == "filteredOut") | {venue: .venue.id, modality: .venue.modality}]' <<<"$by_type" >&2
# endregion
outcome modalities "$by_type"

# region search-venue-include
# Ask only the venues you name. Every other venue is listed in sources as filteredOut.
request=$(jq -nc --arg pay "$pay" --arg receive "$receive" --arg amount "$amount" --arg venue "$venue" '{
  pay: {asset: $pay},
  receive: {asset: $receive},
  amount: $amount,
  side: "payExact",
  filters: {venues: {include: [$venue]}}
}')
only=$(quote_request "$request")
jq -c '[.quotes[] | {venue: .legs[0].venue.id, commitment: .commitment, receive: .receive.amount}]' <<<"$only" >&2
jq -c '[.sources[] | select(.status != "filteredOut") | {venue: .venue.id, status}]' <<<"$only" >&2
# endregion
outcome venueInclude "$only"

# region search-venue-exclude
# Ask every venue except the ones you name. The excluded venue is listed as filteredOut.
request=$(jq -nc --arg pay "$pay" --arg receive "$receive" --arg amount "$amount" --arg venue "$venue" '{
  pay: {asset: $pay},
  receive: {asset: $receive},
  amount: $amount,
  side: "payExact",
  filters: {venues: {exclude: [$venue]}}
}')
without=$(quote_request "$request")
jq -c '[.quotes[] | {venue: .legs[0].venue.id, receive: .receive.amount}]' <<<"$without" >&2
jq -c --arg v "$venue" '.sources[] | select(.venue.id == $v)' <<<"$without" >&2
# endregion
outcome venueExclude "$without"

# region search-native-only
# Keep only the native variant of each side: no bridged, wrapped, omnichain or test
# representation. GET /assets lists each Asset's variants and their kind.
jq -c --arg p "$pay" --arg r "$receive" '[.assets[] | select(.assetId == $p or .assetId == $r)
  | {asset: .assetId, variants: [.variants[] | {name, kind}]}]' <<<"$assets" >&2
request=$(jq -nc --arg pay "$pay" --arg receive "$receive" --arg amount "$amount" '{
  pay: {asset: $pay},
  receive: {asset: $receive},
  amount: $amount,
  side: "payExact",
  filters: {variants: {pay: "nativeOnly", receive: "nativeOnly"}}
}')
native=$(quote_request "$request")
jq -c '[.quotes[] | {venue: .legs[0].venue.id, pay: .pay.variant, receive: .receive.variant}]' <<<"$native" >&2
jq -c '[.sources[] | select(.status != "answered") | {venue: .venue.id, status, reason}]' <<<"$native" >&2
# endregion
outcome nativeOnly "$native"

# region search-executable-only
# Keep only executable quotes. Indicative quotes are dropped once venues answer, so a venue
# whose only quote was indicative still reads answered in sources, with no quote in quotes.
request=$(jq -nc --arg pay "$pay" --arg receive "$receive" --arg amount "$amount" '{
  pay: {asset: $pay},
  receive: {asset: $receive},
  amount: $amount,
  side: "payExact",
  filters: {commitment: "executableOnly"}
}')
executable=$(quote_request "$request")
jq -c '[.quotes[] | {venue: .legs[0].venue.id, commitment: .commitment, minOut, expiresAt}]' <<<"$executable" >&2
jq -c '[.quotes[].legs[0].venue.id] as $quoted
  | [.sources[] | select(.status == "answered" and (.venue.id | IN($quoted[]) | not)) | .venue.id]' <<<"$executable" >&2
# endregion
outcome executableOnly "$executable"

# region search-sort-eta
# Order quotes by expected time to delivery, fastest first, instead of by net received.
request=$(jq -nc --arg pay "$pay" --arg receive "$receive" --arg amount "$amount" '{
  pay: {asset: $pay},
  receive: {asset: $receive},
  amount: $amount,
  side: "payExact",
  sort: "eta"
}')
by_eta=$(quote_request "$request")
jq -c '[.quotes[] | {venue: .legs[0].venue.id, eta, netReceived}]' <<<"$by_eta" >&2
# endregion
outcome sortEta "$by_eta"

# region search-price-protection
# Set how far a non-firm executable quote's delivery may fall below what it quotes. It sets
# minOut on pay-exact quotes, and maxPay on receive-exact quotes from your venue accounts.
request=$(jq -nc --arg pay "$pay" --arg receive "$receive" --arg amount "$protection_amount" \
  --argjson bps "$protection_bps" '{
  pay: {asset: $pay},
  receive: {asset: $receive},
  amount: $amount,
  side: "payExact",
  priceProtectionBps: $bps
}')
protected=$(quote_request "$request")
jq -c '[.quotes[] | select(.minOut != null) | {venue: .legs[0].venue.id, receive: .receive.amount, minOut}]' <<<"$protected" >&2
request=$(jq -nc --arg pay "$pay" --arg receive "$receive" --arg amount "$receive_amount" \
  --argjson bps "$protection_bps" '{
  pay: {asset: $pay},
  receive: {asset: $receive},
  amount: $amount,
  side: "receiveExact",
  priceProtectionBps: $bps
}')
protected_exact=$(quote_request "$request")
jq -c '[.quotes[] | {venue: .legs[0].venue.id, commitment: .commitment, pay: .pay.amount, maxPay}]' <<<"$protected_exact" >&2
# endregion
outcome priceProtection "$protected"
outcome priceProtectionReceiveExact "$protected_exact"

# Extra detail for the summary: which venue the venue filters named, how it read, and what
# each filter left behind.
jq -nc --arg pay "$pay" --arg receive "$receive" --arg venue "$venue" \
  --argjson assets "$(jq '.assets | length' <<<"$assets")" --argjson results "$results" \
  --argjson include "$(jq -c '[.quotes[].legs[0].venue.id] | unique' <<<"$only")" \
  --argjson excluded "$(jq -c --arg v "$venue" '[.sources[] | select(.venue.id == $v) | .status]' <<<"$without")" \
  --argjson variants "$(jq -c '[.quotes[] | [.pay.variant.kind, .receive.variant.kind]] | unique' <<<"$native")" \
  --argjson variantReasons "$(jq -c '[.sources[] | select(.status != "answered") | .reason] | unique' <<<"$native")" \
  --argjson etaOrder "$(jq -c '[.quotes[] | .eta]' <<<"$by_eta")" \
  --argjson minOut "$(jq -c '[.quotes[] | select(.minOut != null) | {receive: .receive.amount, minOut}]' <<<"$protected")" \
  --argjson maxPay "$(jq -c '[.quotes[] | {commitment: .commitment.kind, pay: .pay.amount, maxPay}]' <<<"$protected_exact")" \
  --argjson bps "$protection_bps" \
  '{pair: {pay: $pay, receive: $receive}, assetsListed: $assets, venue: $venue,
    detail: {includeQuotedBy: $include, excludedVenueStatus: $excluded, nativeOnlyVariants: $variants,
      nativeOnlyReasons: $variantReasons, etaOrder: $etaOrder, protectionBps: $bps,
      minOut: $minOut, maxPay: $maxPay},
    requests: $results}'
