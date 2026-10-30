#!/usr/bin/env bash
# Errors: three refusals, each read from the one error body every refusal uses.
#   - a quote request for an asset TetraFi does not list (400 UNKNOWN_ASSET);
#   - two quote requests at once, so one is rate limited (429 QUOTE_RATE_LIMITED), then retried;
#   - a request naming a workspace other than the key's own (403 WORKSPACE_SCOPE_MISMATCH).
#
# Needs bash, curl, jq and openssl. Reads:
#   TETRAFI_BASE_URL        https://api.tetrafi.io in production
#   TETRAFI_API_KEY         your API key, with Read quotes and Submit orders
#   TETRAFI_WORKSPACE_ID    optional: an API key implies its workspace (a session must send it)
#   TETRAFI_SIGNING_SECRET  the key's signing secret, when request signing is on
# Optional:
#   TETRAFI_PAY, TETRAFI_RECEIVE   the pair for the rate-limit step (default USDC for USDT)
#
# Nothing is ordered. The last line printed is one JSON summary. The script exits 1 when a
# refusal does not arrive as documented.
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

# expect CODE BODY: the refusal must carry this code and a requestId, or the script stops.
expect() {
  if ! jq -e --arg code "$1" '.error == $code and (.requestId | type == "string" and length > 0)
    and (.message | type == "string")' <<<"$2" >/dev/null 2>&1; then
    jq -c -n --arg code "$1" --arg got "$2" '{error: "UNEXPECTED_ANSWER", expected: $code, got: ($got | fromjson? // $got)}' >&2
    exit 1
  fi
}

pay=${TETRAFI_PAY:-USDC}
receive=${TETRAFI_RECEIVE:-USDT}

# region errors-parse
# Every refusal is one JSON body: {error, message, requestId, timestamp, docUrl, next?, details?}.
# Match on `error`, never on `message`. Keep `requestId` for support; docUrl links the code's entry.
if refusal=$(tetrafi POST /api/v1/quotes \
  '{"pay":{"asset":"NOT_AN_ASSET"},"receive":{"asset":"USDT"},"amount":"10","side":"payExact"}' 2>/dev/null); then
  echo '{"error":"EXPECTED_A_REFUSAL"}' >&2
  exit 1
fi
jq -c '{error, requestId, docUrl, next, details}' <<<"$refusal" >&2
case $(jq -r '.error' <<<"$refusal") in
  UNKNOWN_ASSET | UNKNOWN_CHAIN | UNKNOWN_VENUE)
    echo "use values from GET /api/v1/assets: $(jq -c '.details' <<<"$refusal")" >&2 ;;
  *)
    echo "refused: $(jq -r '.message' <<<"$refusal") (requestId $(jq -r '.requestId' <<<"$refusal"))" >&2 ;;
esac
# endregion
expect UNKNOWN_ASSET "$refusal"
parse=$(jq -c '{error, requestId, next}' <<<"$refusal")

# region errors-rate-limit
# One live quote request every 3 seconds. Send two at once: one is answered, the other
# answers 429 QUOTE_RATE_LIMITED with details.retryAfter (ISO 8601, such as PT3S) and the
# same wait in whole seconds in the Retry-After header. Wait that long, then retry once.
# Each signature is accepted once, so the two requests differ in amount.
quote_body() {
  jq -c -n --arg pay "$pay" --arg receive "$receive" --arg amount "$1" \
    '{pay: {asset: $pay}, receive: {asset: $receive}, amount: $amount, side: "payExact"}'
}
tetrafi POST /api/v1/quotes "$(quote_body 10)" >"$tmp/first" 2>/dev/null & first=$!
tetrafi POST /api/v1/quotes "$(quote_body 11)" >"$tmp/second" 2>/dev/null & second=$!
wait "$first" && first_ok=true || first_ok=false
wait "$second" && second_ok=true || second_ok=false

if [[ $first_ok == true ]]; then limited=$(<"$tmp/second") amount=11; else limited=$(<"$tmp/first") amount=10; fi
jq -c '{error, requestId, retryAfter: .details.retryAfter}' <<<"$limited" >&2
if [[ $(jq -r '.error' <<<"$limited") == QUOTE_RATE_LIMITED ]]; then
  # PT3S is 3 seconds; a fraction such as PT1.5S rounds up.
  wait_seconds=$(jq -r '.details.retryAfter | capture("^PT(?<s>[0-9.]+)S$").s | tonumber | ceil' <<<"$limited")
  sleep "$wait_seconds"
  retried=$(tetrafi POST /api/v1/quotes "$(quote_body "$amount")")
  echo "retried after ${wait_seconds}s: $(jq '.quotes | length' <<<"$retried") quotes" >&2
fi
# endregion
if [[ $first_ok == "$second_ok" ]]; then
  jq -c -n --argjson a "$first_ok" --argjson b "$second_ok" \
    '{error: "UNEXPECTED_ANSWER", expected: "one answered, one QUOTE_RATE_LIMITED", firstAnswered: $a, secondAnswered: $b}' >&2
  exit 1
fi
expect QUOTE_RATE_LIMITED "$limited"
retry_after=$(jq -r '.details.retryAfter' <<<"$limited")
rate_limit=$(jq -c -n --arg r "$retry_after" --argjson s "$wait_seconds" --argjson q "$(jq '.quotes | length' <<<"$retried")" \
  --arg id "$(jq -r '.requestId' <<<"$limited")" \
  '{error: "QUOTE_RATE_LIMITED", requestId: $id, retryAfter: $r, waitedSeconds: $s, retryQuotes: $q}')

# region errors-wrong-workspace
# An API key implies its workspace, so it may leave X-Workspace-Id out. When it sends one,
# it must be the key's own: any other workspace answers 403 WORKSPACE_SCOPE_MISMATCH.
other_workspace=$(openssl rand -hex 16 | sed -E 's/(.{8})(.{4})(.{4})(.{4})(.{12})/\1-\2-\3-\4-\5/')
if refusal=$(TETRAFI_WORKSPACE_ID=$other_workspace tetrafi GET /api/v1/assets 2>/dev/null); then
  echo '{"error":"EXPECTED_A_REFUSAL"}' >&2
  exit 1
fi
jq -c '{error, message, requestId}' <<<"$refusal" >&2
# endregion
expect WORKSPACE_SCOPE_MISMATCH "$refusal"
wrong=$(jq -c '{error, requestId}' <<<"$refusal")

jq -c -n --argjson parse "$parse" --argjson rateLimit "$rate_limit" --argjson wrongWorkspace "$wrong" \
  '{parse: $parse, rateLimit: $rateLimit, wrongWorkspace: $wrongWorkspace}'
