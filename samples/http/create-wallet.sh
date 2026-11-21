#!/usr/bin/env bash
# Create a hosted wallet: start an organisation wallet with two owners who must both approve,
# print the approval page each owner opens, then read the creation once. Nothing exists at the
# provider until the owners have approved on that page.
#
# Needs bash, curl, jq, openssl and uuidgen. Reads:
#   TETRAFI_BASE_URL        https://api.tetrafi.io in production
#   TETRAFI_API_KEY         your API key (treasury_write; its member needs Manage wallets)
#   TETRAFI_SIGNING_SECRET  the key's signing secret, when request signing is on
#   TETRAFI_WORKSPACE_ID    the workspace, from GET /api/v1/me
#   TETRAFI_OWNER_A, TETRAFI_OWNER_B  the two people of the workspace who approve (user ids)
# Optional:
#   TETRAFI_CONNECTION      the connection (default platform-privy: Privy provided by TetraFi)
#   TETRAFI_NETWORK         the first network, a CAIP-2 id (default eip155:84532, Base Sepolia)
#
# The last line printed is one JSON summary. An API error prints its error body and exits 1.
set -euo pipefail

: "${TETRAFI_BASE_URL:?Set TETRAFI_BASE_URL}"
: "${TETRAFI_API_KEY:?Set TETRAFI_API_KEY}"
: "${TETRAFI_WORKSPACE_ID:?Set TETRAFI_WORKSPACE_ID}"
: "${TETRAFI_OWNER_A:?Set TETRAFI_OWNER_A}"
: "${TETRAFI_OWNER_B:?Set TETRAFI_OWNER_B}"

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

ws=$TETRAFI_WORKSPACE_ID
connection=${TETRAFI_CONNECTION:-platform-privy}
network=${TETRAFI_NETWORK:-eip155:84532}
owner_a=$TETRAFI_OWNER_A
owner_b=$TETRAFI_OWNER_B

# region create-hosted-wallet
# Two owners, both must approve. A key never names how a person approves:
# each owner chooses on the approval page, so factors stay empty.
body=$(jq -nc --arg c "$connection" --arg n "$network" \
  --arg a "$owner_a" --arg b "$owner_b" '{
  scope: "organisation", connectionId: $c, family: "evm",
  networks: [$n], displayName: "Treasury",
  ownerGroup: {threshold: 2, members: [
    {person: $a, factors: [], needed: 1},
    {person: $b, factors: [], needed: 1}]}}')
created=$(tetrafi POST "/api/v1/workspaces/$ws/wallets" "$body" \
  "Idempotency-Key: $(uuidgen)")
wallet_id=$(jq -r '.walletId' <<<"$created")
# Hand this page to each owner.
jq -r '.signingRequest.approvalUrl' <<<"$created" >&2
# endregion

# region follow-hosted-wallet
# Read it until status is active, or failed, expired, cancelled or declined.
creation=$(tetrafi GET "/api/v1/workspaces/$ws/wallets/$wallet_id")
jq -c '{status}' <<<"$creation" >&2
# endregion

jq -c --arg w "$wallet_id" '{walletId: $w, status}' <<<"$creation"
