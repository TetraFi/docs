#!/usr/bin/env bash
# Recipe: move USDC between chains from a wallet whose key only you hold. Quote with the wallet's
# address, sign the first step locally, order with it, sign each later step the order asks for, and
# follow the order until it ends. TetraFi checks every signed step against the one it issued, then
# relays it; you pay your own gas.
#
# Needs bash, curl, jq, openssl and Foundry's cast. Reads:
#   TETRAFI_BASE_URL        https://api.tetrafi.io in production
#   TETRAFI_API_KEY         your API key (venue trading on; no organisation-wallet grant needed)
#   TETRAFI_SIGNING_SECRET  the key's signing secret: venue trading needs request signing
#   SIGNER_PRIVATE_KEY      the wallet's private key, used only by cast on this machine
#   SIGNER_RPC_URL          an RPC endpoint of the chain you sell on, for gas and fees
# Optional:
#   TETRAFI_ASSET           the asset to move (default USDC)
#   TETRAFI_FROM_CHAIN      CAIP-2 chain you sell on (default eip155:8453, Base)
#   TETRAFI_TO_CHAIN        CAIP-2 chain you receive on (default eip155:1, Ethereum)
#   TETRAFI_AMOUNT          the amount you sell (default 10)
#   TETRAFI_SLIPPAGE_BPS    how far below the quote you accept, in basis points (default 50)
#   TETRAFI_PLACE_ORDER=1   signs and places the order (yes also works); without it the script stops
#                           after printing the first step
#
# Progress goes to stderr; the last line printed is one JSON summary. Any API error prints its error
# body and exits 1.
set -euo pipefail

: "${TETRAFI_BASE_URL:?Set TETRAFI_BASE_URL}"
: "${TETRAFI_API_KEY:?Set TETRAFI_API_KEY}"
: "${TETRAFI_SIGNING_SECRET:?Set TETRAFI_SIGNING_SECRET: venue trading needs request signing}"
: "${SIGNER_PRIVATE_KEY:?Set SIGNER_PRIVATE_KEY}"
: "${SIGNER_RPC_URL:?Set SIGNER_RPC_URL}"

# tetrafi METHOD PATH [BODY] [HEADER]
# Sends one signed request and prints the response body. On an error status it also prints the body
# to stderr and returns 1.
tetrafi() {
  local method=$1 path=$2 body=${3:-} extra=${4:-}
  local headers=(
    -H "X-API-Key: $TETRAFI_API_KEY"
    -H "Accept: application/json"
  )
  if [[ -n $body ]]; then headers+=(-H "Content-Type: application/json"); fi
  if [[ -n $extra ]]; then headers+=(-H "$extra"); fi
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

asset=${TETRAFI_ASSET:-USDC}
amount=${TETRAFI_AMOUNT:-10}
from_chain=${TETRAFI_FROM_CHAIN:-eip155:8453}
to_chain=${TETRAFI_TO_CHAIN:-eip155:1}
address=$(cast wallet address --private-key "$SIGNER_PRIVATE_KEY")

# region recipe-own-wallet-quote
# Name the wallet's address for the chain you sell on. Each on-chain quote is then firm for that
# address, and signing.mode "you" means you sign: signing.firstStep is the first thing to sign.
request=$(jq -nc --arg asset "$asset" --arg amount "$amount" --arg from "$from_chain" \
  --arg to "$to_chain" --arg address "$address" '{
  kind: "pair",
  sell: {asset: $asset, network: $from},
  buy: {asset: $asset, network: $to},
  sellAmount: $amount,
  filters: {locations: ["crossChain"]},
  source: {tradingWallets: {($from): $address}}
}')
quotes=$(tetrafi POST /api/v1/quotes "$request")
jq -c '.sources[] | select(.status != "filteredOut") | {venue: .venue.id, status, reason}' <<<"$quotes" >&2
quote=$(jq -c 'first(.quotes[] | select(.next.kind == "order" and .signing.mode == "you"
  and .signing.firstStep != null)) // empty' <<<"$quotes")
# endregion

if [[ -z $quote ]]; then
  jq -c --arg a "$address" '{address: $a, orderable: false,
    reasons: [.sources[] | select(.status == "unavailable") | {venue: .venue.id, reason}]}' <<<"$quotes"
  exit 0
fi
quote_id=$(jq -r '.id' <<<"$quote")
first_step=$(jq -c '.signing.firstStep' <<<"$quote")
jq -c '{quoteId: .id, venue: .legs[0].venue.id, buy: .buy.amount,
  firstStep: (.signing.firstStep | {purpose, type, network, signBy})}' <<<"$quote" >&2

if [[ ${TETRAFI_PLACE_ORDER:-} != 1 && ${TETRAFI_PLACE_ORDER:-} != yes ]]; then
  jq -c '{quoteId: .id, orderable: true, ordered: false, firstStep: .signing.firstStep}' <<<"$quote"
  exit 0
fi

# region recipe-own-wallet-sign
# sign_step STEP: prints the raw signed transaction for a step of type "transaction". It refuses a
# type it does not know and a step for another wallet. The chain id is the number after "eip155:" in
# the step's network; the nonce is pinned; cast estimates gas and reads fees from SIGNER_RPC_URL.
sign_step() {
  local step=$1
  if [[ $(jq -r '.type' <<<"$step") != transaction ]]; then
    printf 'Unknown step type %s: not signed\n' "$(jq -r '.type' <<<"$step")" >&2
    return 1
  fi
  if [[ $(jq -r '.from | ascii_downcase' <<<"$step") != "${address,,}" ]]; then
    printf 'The step is for another wallet\n' >&2
    return 1
  fi
  if [[ $(jq -r '.network' <<<"$step") != "$from_chain" ]]; then
    printf 'The step is on %s; SIGNER_RPC_URL serves %s\n' "$(jq -r '.network' <<<"$step")" "$from_chain" >&2
    return 1
  fi
  cast mktx "$(jq -r '.transaction.to' <<<"$step")" "$(jq -r '.transaction.data' <<<"$step")" \
    --chain "$(jq -r '.network | split(":")[1]' <<<"$step")" \
    --nonce "$(jq -r '.transaction.nonce' <<<"$step")" \
    --value "$(jq -r '.transaction.value' <<<"$step")" \
    --rpc-url "$SIGNER_RPC_URL" \
    --private-key "$SIGNER_PRIVATE_KEY"
}
# endregion

# region recipe-own-wallet-order
# Order with step 1 signed. minReceive is the least you accept: the quote less TETRAFI_SLIPPAGE_BPS,
# at 6 decimals. If it is stricter than the signed step allows, or the chain moved since the quote,
# nothing is relayed and the order asks for a fresh step 1 in next.
raw=$(sign_step "$first_step")
order_body=$(jq -c --argjson bps "${TETRAFI_SLIPPAGE_BPS:-50}" --arg raw "$raw" '{quoteId: .id,
  firstStep: {stepId: .signing.firstStep.stepId, kind: "signedTransaction", raw: $raw}}
  + (if .minReceiveRequired == true then {minReceive: ((.buy.amount | tonumber) * (10000 - $bps) / 10000
      | . * 1000000 | floor | . / 1000000 | tostring)} else {} end)' <<<"$quote")
# One Idempotency-Key per order, stored before you send it: a retry returns the first answer and
# never relays twice.
idempotency_key=$(openssl rand -hex 16)
order=$(tetrafi POST /api/v1/orders "$order_body" "Idempotency-Key: $idempotency_key")
order_id=$(jq -r '.orderId' <<<"$order")
jq -c '{orderId, status, terminal, next: .next.kind}' <<<"$order" >&2
# endregion

# region recipe-own-wallet-steps
# Follow the order until terminal is true. When next.kind is "sign", sign next.step and send it to
# its step endpoint with a new Idempotency-Key; the answer is the order again. Otherwise wait
# next.retryAfter (10 seconds when none is given) and read the order.
state=$order
for _ in $(seq 1 90); do
  if jq -e '.terminal == true' <<<"$state" >/dev/null; then break; fi
  if [[ $(jq -r '.next.kind // empty' <<<"$state") == sign ]]; then
    step=$(jq -c '.next.step' <<<"$state")
    raw=$(sign_step "$step")
    step_id=$(jq -r '.stepId' <<<"$step")
    state=$(tetrafi POST "/api/v1/orders/$order_id/steps/$step_id" \
      "$(jq -nc --arg raw "$raw" '{kind: "signedTransaction", raw: $raw}')" \
      "Idempotency-Key: $(openssl rand -hex 16)")
  else
    wait=$(jq -r '.next | select(.kind == "wait") | .retryAfter | capture("^PT(?<s>[0-9]+)S$").s' <<<"$state" 2>/dev/null || true)
    sleep "${wait:-10}"
    state=$(tetrafi GET "/api/v1/orders/$order_id")
  fi
  jq -c '{status, terminal, next: .next.kind}' <<<"$state" >&2
done
# endregion

jq -c --arg q "$quote_id" --arg k "$idempotency_key" --arg a "$address" \
  '{quoteId: $q, orderId, address: $a, status, terminal, idempotencyKey: $k,
    steps: [.operation.steps[]? | {purpose, status, txHash}]}' <<<"$state"
