#!/usr/bin/env bash
# Webhooks: create an endpoint for order.updated, keep its signing secret without printing it, send
# it a test delivery and read back whether your receiver acknowledged it.
#
# Needs bash, curl, jq and openssl. Reads:
#   TETRAFI_BASE_URL        https://api.tetrafi.io in production
#   TETRAFI_API_KEY         your API key, with Manage webhooks
#   TETRAFI_WORKSPACE_ID    your workspace id: GET /api/v1/me answers it for your key
#   TETRAFI_WEBHOOK_URL     your receiver's https URL
#   TETRAFI_SIGNING_SECRET  the key's signing secret, when request signing is on
# Optional:
#   TETRAFI_WEBHOOK_SECRET_FILE  where the whsec_ secret is written, mode 0600
#                                (default ./tetrafi-webhook-secret)
#
# The last line printed is one JSON summary; the secret never appears in it.
set -euo pipefail

: "${TETRAFI_BASE_URL:?Set TETRAFI_BASE_URL}"
: "${TETRAFI_API_KEY:?Set TETRAFI_API_KEY}"
: "${TETRAFI_WORKSPACE_ID:?Set TETRAFI_WORKSPACE_ID}"
: "${TETRAFI_WEBHOOK_URL:?Set TETRAFI_WEBHOOK_URL}"

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
    ${body:+--data "$body"} ${dump:+-D "$dump"} -w $'\n%{http_code}')
  status=${response##*$'\n'}
  response=${response%$'\n'*}
  printf '%s\n' "$response"
  if (( status >= 400 )); then
    printf '%s\n' "$response" >&2
    return 1
  fi
}

secret_file=${TETRAFI_WEBHOOK_SECRET_FILE:-./tetrafi-webhook-secret}
base=/api/v1/workspaces/$TETRAFI_WORKSPACE_ID/webhooks

# region webhook-create
# Create the endpoint with an Idempotency-Key saved with its body before you send (0600): a lost
# answer is replayed with both, and a replay within 24 hours returns the same endpoint with secret
# null. The secret is shown once: it is checked, then written to a new file only you can read.
request_file=$secret_file.request
if [[ -f $request_file ]]; then
  saved=$(jq -cn '[inputs] | if length == 1 then .[0] else error("REQUEST_RECORD_INVALID") end' "$request_file")
  create_key=$(jq -er '.idempotencyKey' <<<"$saved"); create_body=$(jq -er '.exactBody' <<<"$saved")
else
  create_key=$(openssl rand -hex 16)
  create_body=$(jq -nc --arg url "$TETRAFI_WEBHOOK_URL" '{url: $url, events: ["order.updated"]}')
  jq -n --arg k "$create_key" --arg b "$create_body" '{idempotencyKey: $k, exactBody: $b}' \
    | (umask 077; set -o noclobber; cat > "$request_file") || { echo "Could not save $request_file" >&2; exit 1; }
fi
created=$(tetrafi POST "$base" "$create_body" "Idempotency-Key: $create_key")
webhook_id=$(jq -r '.webhook.id' <<<"$created")
secret=$(jq -r '.secret // empty' <<<"$created")
[[ -n $secret ]] || { echo '{"error":"no secret returned (a replay): rotate it to get a new one"}' >&2; exit 1; }
# noclobber refuses an existing file, so the secret never lands in a file someone else can read.
(umask 077; set -o noclobber; printf '%s\n' "$secret" > "$secret_file") \
  || { echo "{\"error\":\"$secret_file exists: choose a new TETRAFI_WEBHOOK_SECRET_FILE\"}" >&2; exit 1; }
unset secret
# endregion

# region webhook-test
# Send a test delivery with a different Idempotency-Key. Your receiver verifies its signature with
# the secret, stores it, then answers 2xx within 10 seconds.
delivery=$(tetrafi POST "$base/$webhook_id/deliveries" '{"kind":"test"}' \
  "Idempotency-Key: $(openssl rand -hex 16)")
jq -c '{id, test, success, httpStatus, errorMessage}' <<<"$delivery" >&2
# endregion

# region webhook-deliveries
# Read the endpoint's deliveries: success true with your status code means it acknowledged.
sleep 2
deliveries=$(tetrafi GET "$base/$webhook_id/deliveries")
# endregion

jq -c --arg w "$webhook_id" --arg f "$secret_file" '{webhookId: $w, secretFile: $f,
  latest: (.items[0] | {id, test, success, httpStatus, errorMessage, redeliverAvailable})}' <<<"$deliveries"
