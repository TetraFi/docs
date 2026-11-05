#!/usr/bin/env bash
# Orders: list your orders with filters, page through them, and see what cancelling a final order
# answers. Reads only: the cancel it sends is for an order that has already ended, which is refused
# and changes nothing.
#
# Needs bash, curl, jq and openssl. Reads:
#   TETRAFI_BASE_URL        https://api.tetrafi.io in production
#   TETRAFI_API_KEY         your API key, with Read orders (and Submit orders for the cancel)
#   TETRAFI_WORKSPACE_ID    optional: an API key implies its workspace (a session must send it)
#   TETRAFI_SIGNING_SECRET  the key's signing secret, when request signing is on
#
# The last line printed is one JSON summary. The script exits 1 when an answer breaks the contract
# it checks.
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

# region orders-list
# GET /api/v1/orders lists your workspace's orders, newest first, in the same envelope as
# GET /api/v1/orders/{id}. Filter by status, kind, sellAsset, buyAsset and a from/to time range.
# A page can hold fewer than limit items, even none: follow nextCursor until it is null.
since=$(date -u -v-30d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '30 days ago' +%Y-%m-%dT%H:%M:%SZ)
orders=() pages=0 cursor=""
while (( pages < 5 )); do
  page=$(tetrafi GET "/api/v1/orders?limit=20&from=$since${cursor:+&cursor=$cursor}")
  pages=$((pages + 1))
  while IFS= read -r line; do orders+=("$line"); done < <(jq -c '.items[] | {orderId, kind, status, terminal}' <<<"$page")
  cursor=$(jq -r '.nextCursor // empty' <<<"$page")
  [[ -z $cursor ]] && break
done
echo "orders: ${#orders[@]} across $pages pages" >&2
# An empty list is a normal answer: a new workspace has no orders yet.
(( ${#orders[@]} == 0 )) || printf '%s\n' "${orders[@]:0:3}" >&2
# endregion

# region order-execution
# Every order also says what it actually did, on Basic and Advanced orders alike. settledBuyAmount
# is null until it is measured, never the quote carried forward. A fee whose amount was not
# reported is left out of fees and its kind listed in unrecordedFees: show it as not recorded,
# never as 0. settlesBy is null when no deadline is recorded, for example a same-chain DEX swap.
filled=""
for status in settled filled; do
  [[ -n $filled ]] || filled=$(tetrafi GET "/api/v1/orders?limit=1&from=$since&status=$status" | jq -r '.items[0].orderId // empty')
done
if [[ -n $filled ]]; then
  filled=$(tetrafi GET "/api/v1/orders/$filled")
  jq -c '{orderId, kind, quotedBuyAmount, settledBuyAmount, fills: [.fills[] | {amount, at, network}],
    fees: [.fees[] | {kind, amount, asset, includedInPrice}], unrecordedFees, settlesBy}' <<<"$filled" >&2
fi
# endregion
[[ -z $filled ]] || jq -e 'has("fills") and has("fees") and has("unrecordedFees") and has("settlesBy")
  and has("quotedBuyAmount") and has("settledBuyAmount")' <<<"$filled" >/dev/null || fail EXECUTION_REPORT_MISSING

# A cancelled order answers a repeated cancel with itself, unchanged; pick one that ended otherwise.
final=$( (( ${#orders[@]} == 0 )) || printf '%s\n' "${orders[@]}" | jq -sc 'map(select(.terminal == true and .status != "cancelled")) | .[0] // empty')
cancel='{"skipped":"no final order in the last 30 days"}'
if [[ -n $final ]]; then
  # region order-cancel
  # POST /api/v1/orders/{id}/cancel cancels an order that has not been sent to a venue yet, or a
  # pay-in still waiting for funds. Once it is sent, or final, it answers 409 ORDER_NOT_CANCELLABLE
  # with the order's status in details.status, and nothing changes. A cancel needs an
  # Idempotency-Key, like placing an order.
  order_id=$(jq -r '.orderId' <<<"$final")
  if refused=$(tetrafi POST "/api/v1/orders/$order_id/cancel" '' "Idempotency-Key: $(openssl rand -hex 16)" 2>/dev/null); then
    fail EXPECTED_ORDER_NOT_CANCELLABLE
  fi
  jq -c '{error, status: .details.status}' <<<"$refused" >&2
  # endregion
  [[ $(jq -r '.error' <<<"$refused") == ORDER_NOT_CANCELLABLE ]] || fail "UNEXPECTED_$(jq -r '.error' <<<"$refused")"
  cancel=$(jq -c '{error, status: .details.status}' <<<"$refused")
fi

jq -cn --argjson n "${#orders[@]}" --argjson p "$pages" --argjson c "$cancel" --arg f "$(jq -r '.orderId // empty' <<<"${filled:-null}")" \
  '{orders: $n, pages: $p, cancelFinal: $c, executionReportOf: (if $f == "" then null else $f end)}'
