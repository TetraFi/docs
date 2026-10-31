#!/usr/bin/env bash
# Conventions: the rules every response follows, read from live answers.
#   - page through the asset list with limit and nextCursor;
#   - send your own X-Request-Id and read it back, with the per-key rate-limit headers;
#   - amounts are decimal strings and times are RFC 3339.
#
# Needs bash, curl, jq and openssl. Reads:
#   TETRAFI_BASE_URL        https://api.tetrafi.io in production
#   TETRAFI_API_KEY         your API key, with Read quotes
#   TETRAFI_WORKSPACE_ID    optional: an API key implies its workspace (a session must send it)
#   TETRAFI_SIGNING_SECRET  the key's signing secret, when request signing is on
#
# Nothing is ordered. The last line printed is one JSON summary. The script exits 1 when a
# response breaks one of the conventions it checks.
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

fail() { echo "{\"error\":\"$1\"}" >&2; exit 1; }

# region conventions-paging
# Lists that page take limit and return nextCursor; pass it back as cursor until it is absent.
# A cursor is valid while the list it came from is unchanged. After a change it answers
# 409 CURSOR_STALE: start again from the first page.
listed=() pages=0 cursor="" restarted=false
while :; do
  path="/api/v1/assets?limit=5${cursor:+&cursor=$cursor}"
  if ! page=$(tetrafi GET "$path" 2>/dev/null); then
    if [[ $(jq -r '.error' <<<"$page") == CURSOR_STALE && $restarted == false ]]; then
      listed=() pages=0 cursor="" restarted=true
      continue
    fi
    printf '%s\n' "$page" >&2
    exit 1
  fi
  pages=$((pages + 1))
  while IFS= read -r id; do listed+=("$id"); done < <(jq -r '.assets[].assetId' <<<"$page")
  cursor=$(jq -r '.nextCursor // empty' <<<"$page")
  [[ -z $cursor ]] && break
done
echo "assets: ${#listed[@]} across $pages pages" >&2
# endregion
(( ${#listed[@]} > 0 )) || fail ASSETS_EMPTY

# region conventions-request-id
# Send your own X-Request-Id (letters, digits, - and _, up to 64 characters) to find a request
# in your logs and ours; the response echoes it. Without one, TetraFi generates a UUID.
# The rate-limit headers say how many requests this key has left before a 429.
request_id="conventions-$(date +%s)"
headers_file=$(mktemp)
quotes=$(tetrafi POST /api/v1/quotes "$(jq -cn '{sell: {asset: "USDC"}, buy: {asset: "USDT"},
  sellAmount: "10"}')" "X-Request-Id: $request_id" "$headers_file")
header() { awk -v name="$1" 'tolower($1) == tolower(name ":") { sub(/\r$/, "", $2); print $2 }' "$headers_file" | tail -1; }
echo "{\"requestId\":\"$(header x-request-id)\",\"limit\":\"$(header x-ratelimit-limit)\",\"remaining\":\"$(header x-ratelimit-remaining)\",\"reset\":\"$(header x-ratelimit-reset)\"}" >&2
# endregion
[[ $(header x-request-id) == "$request_id" ]] || fail REQUEST_ID_NOT_ECHOED

# region conventions-values
# Amounts are decimal strings, never JSON numbers: parse them with a decimal type, not a float.
# Times are RFC 3339 in UTC. Field names are camelCase.
jq -c '.quotes[0] // empty | {buy: .buy.amount, buyIsString: (.buy.amount | type == "string"),
  expiresAt, observedAt}' <<<"$quotes" >&2
# endregion
if [[ $(jq '.quotes | length' <<<"$quotes") -gt 0 ]]; then
  jq -e '.quotes[0].buy.amount | type == "string"' <<<"$quotes" >/dev/null || fail AMOUNT_NOT_STRING
  jq -e '.quotes[0].expiresAt | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(Z|[+-][0-9:]+)$")' <<<"$quotes" >/dev/null \
    || fail TIME_NOT_RFC3339
fi

jq -cn --argjson n "${#listed[@]}" --argjson p "$pages" --arg id "$(header x-request-id)" \
  --argjson q "$(jq '.quotes | length' <<<"$quotes")" \
  '{assets: $n, pages: $p, requestIdEchoed: ($id != ""), quotes: $q}'
