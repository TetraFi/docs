#!/usr/bin/env bash
# Test safely: before an order, see which venues take a small amount and what each needs.
# Asks every venue for quotes at a few small amounts and prints, per venue, the smallest amount
# it answered at, or why it did not answer.
#
# Needs bash, curl, jq and openssl. Reads:
#   TETRAFI_BASE_URL        https://api.tetrafi.io in production
#   TETRAFI_API_KEY         your API key, with Read quotes
#   TETRAFI_WORKSPACE_ID    optional: an API key implies its workspace (a session must send it)
#   TETRAFI_SIGNING_SECRET  the key's signing secret, when request signing is on
# Optional:
#   TETRAFI_PAY, TETRAFI_RECEIVE   the pair (default USDC for USDT)
#   TETRAFI_AMOUNTS                the amounts you try, smallest first (default "1 5 10 25")
#
# Nothing is ordered. The last line printed is one JSON summary.
set -euo pipefail

: "${TETRAFI_BASE_URL:?Set TETRAFI_BASE_URL}"
: "${TETRAFI_API_KEY:?Set TETRAFI_API_KEY}"

# tetrafi METHOD PATH [BODY] [HEADER] [HEADERS_FILE]
# Sends one request and prints the response body. On an error status it also prints the body to
# stderr and returns 1. With TETRAFI_SIGNING_SECRET set, it signs the request. With HEADERS_FILE,
# the response headers are written there.
tetrafi() {
  local method=$1 path=$2 body=${3:-} extra=${4:-} dump=${5:-}
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
    ${body:+--data "$body"} ${dump:+-D "$dump"} -w $'\n%{http_code}')
  status=${response##*$'\n'}
  response=${response%$'\n'*}
  printf '%s\n' "$response"
  if (( status >= 400 )); then
    printf '%s\n' "$response" >&2
    return 1
  fi
}

pay=${TETRAFI_PAY:-USDC}
receive=${TETRAFI_RECEIVE:-USDT}
amounts=${TETRAFI_AMOUNTS:-1 5 10 25}

# region test-safely-minimums
# Find the smallest size each venue takes before you order: ask at a few small amounts, one
# quote request every 3 seconds (the per-key limit), and keep the first amount each venue answers.
# A venue that needs more reads unsupported or unavailable with a reason such as sizeNotEligible
# or amountBelowMinimum. Venues change their limits, so read them again before you test.
results='{}'
for amount in $amounts; do
  answer=$(tetrafi POST /api/v1/quotes "$(jq -cn --arg pay "$pay" --arg receive "$receive" --arg amount "$amount" \
    '{pay: {asset: $pay}, receive: {asset: $receive}, amount: $amount, side: "payExact"}')")
  results=$(jq -cn --arg amount "$amount" --argjson answer "$answer" --argjson seen "$results" 'reduce ($answer.sources[]
    | select(.status != "filteredOut")) as $s ($seen;
      if .[$s.venue.id].smallest then . else
        .[$s.venue.id] = (if $s.status == "answered" then {smallest: $amount} else {smallest: null, triedUpTo: $amount, status: $s.status, reason: $s.reason} end)
      end)')
  sleep 3
done
jq -c 'to_entries[] | {venue: .key} + .value' <<<"$results" >&2
# endregion

jq -c --arg amounts "$amounts" '{amounts: $amounts, venues: length,
  answered: (to_entries | map(select(.value.smallest != null) | {key, value: .value.smallest}) | from_entries)}' <<<"$results"
