#!/usr/bin/env bash
# Wallets and accounts: quote with your defaults, read each quote's bindingOptions, then requote
# one quote with a different wallet or account, and with a different delivery, chosen from the
# quote's own options.
#
# Needs bash, curl, jq and openssl. Reads:
#   TETRAFI_BASE_URL        https://api.tetrafi.io in production
#   TETRAFI_API_KEY         your API key
#   TETRAFI_WORKSPACE_ID    the workspace the key belongs to
#   TETRAFI_SIGNING_SECRET  the key's signing secret, when request signing is on (venue trading needs it)
# Optional:
#   TETRAFI_PAY, TETRAFI_RECEIVE, TETRAFI_AMOUNT  the pair and the amount you pay (default 10 USDC for ETH)
#   TETRAFI_PAY_CHAIN, TETRAFI_RECEIVE_CHAIN      CAIP-2 chains to pin each side to (default: any chain)
#
# Every request asks for quotes only: nothing is ordered. The last line printed is one JSON
# summary. An API error on the first quote request prints its error body and exits 1; a refused
# requote is printed as its error code, because a refusal is an answer you act on.
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

# quote_request BODY
# POST /api/v1/quotes through tetrafi, for a new request or a requote. You may send one live
# quote request every 3 seconds; a faster one answers 429 QUOTE_RATE_LIMITED with a Retry-After
# header, and the same wait in details.retryAfter (for example PT1S). This waits that long and
# tries once more. Any other refusal prints its error body and returns 1.
quote_request() {
  local response wait
  if response=$(tetrafi POST /api/v1/quotes "$1" 2>/dev/null); then
    printf '%s\n' "$response"
    return 0
  fi
  wait=$(jq -r 'select(.error == "QUOTE_RATE_LIMITED") | .details.retryAfter
    | capture("^PT(?<s>[0-9]+)S$").s' <<<"$response" 2>/dev/null || true)
  if [[ -z $wait ]]; then
    printf '%s\n' "$response"
    return 1
  fi
  sleep "$wait"
  tetrafi POST /api/v1/quotes "$1" 2>/dev/null
}

pay=${TETRAFI_PAY:-USDC}
receive=${TETRAFI_RECEIVE:-ETH}
amount=${TETRAFI_AMOUNT:-10}
pay_chain=${TETRAFI_PAY_CHAIN:-}
receive_chain=${TETRAFI_RECEIVE_CHAIN:-}

# region wallets-default-quote
# No wallet or account in the request: every venue prices with your default binding.
request=$(jq -n --arg pay "$pay" --arg receive "$receive" --arg amount "$amount" \
  --arg payChain "$pay_chain" --arg receiveChain "$receive_chain" '{
    pay: ({asset: $pay} + (if $payChain == "" then {} else {chain: $payChain} end)),
    receive: ({asset: $receive} + (if $receiveChain == "" then {} else {chain: $receiveChain} end)),
    amount: $amount,
    side: "payExact"
  }')
if ! quotes=$(quote_request "$request"); then
  printf '%s\n' "$quotes" >&2
  exit 1
fi

# Each venue's outcome. needsWallet names the wallet family it needs; walletRefused names
# the wallet it refused and, when there is one, how to recover.
jq -c '.sources[] | {venue: .venue.id, status}
  + (if .status == "needsWallet" then {family} else {} end)
  + (if .status == "walletRefused" then {wallet, reason, recovery: (.recovery != null)} else {} end)
  + (if .reason and .status != "walletRefused" then {reason} else {} end)' <<<"$quotes" >&2

# What each quote is bound to: the wallet per chain, the venue account and the delivery.
jq -c '.quotes[] | {quoteId: .id, venue: .legs[0].venue.id, next: .next.kind,
  wallets: (.binding.wallets // {} | keys), account: (.binding.account != null),
  deliverTo: .binding.deliverTo.kind}' <<<"$quotes" >&2
# endregion

# region wallets-binding-options
# bindingOptions lists what each quote can be requoted with. A candidate's id is what bind names.
jq -c '.quotes[] | {quoteId: .id, venue: .legs[0].venue.id,
  options: [.bindingOptions[] | {kind, chain, family,
    candidates: [.candidates[] | {id, kind, label, chains,
      balance: (if .balance == null then null elif .balance.kind == "known"
        then "\(.balance.amount) \(.balance.asset)" else "unavailable" end)}]}]}' <<<"$quotes" >&2

# A quote whose next step is requote says which slots it needs filled before it can be ordered.
jq -c '.quotes[] | select(.next.kind == "requote") | {quoteId: .id, needs: .next.needs}' <<<"$quotes" >&2
# endregion

# region wallets-requote-bind
# Requote one quote with a wallet or venue account from its own bindingOptions: a candidate that
# differs from what the quote is bound to now when there is one, else the first candidate.
choice=$(jq -c '[.quotes[] as $q | $q.bindingOptions[]
  | select(.kind == "wallet" or .kind == "account") as $o | $o.candidates[]
  | {quoteId: $q.id,
     bind: (if $o.kind == "wallet" then {wallets: {($o.chain): .id}} else {account: .id} end),
     same: (if $o.kind == "wallet" then $q.binding.wallets[$o.chain] == .id else $q.binding.account == .id end)}]
  | (map(select(.same | not)) + .)[0] // empty | del(.same)' <<<"$quotes")
if [[ -z $choice ]]; then
  echo '{"requoteBind":"no quote offers a wallet or account"}' >&2
  bind_outcome=none
else
  body=$(jq -c '{requote: .quoteId, bind}' <<<"$choice")
  jq -c '{requote: .quoteId, bind}' <<<"$choice" >&2
  if requoted=$(quote_request "$body"); then
    jq -c '.quotes[0] | {quoteId: .id, requoteOf, next: .next.kind,
      wallets: (.binding.wallets // {} | keys), account: (.binding.account != null)}' <<<"$requoted" >&2
    bind_outcome=$(jq -r '.quotes[0].next.kind' <<<"$requoted")
  else
    # Binding refusals arrive by name, for example BINDING_NOT_OWNED or BINDING_NOT_ON_CHAIN.
    bind_outcome=$(jq -r '.error' <<<"$requoted")
    jq -c '{requoteRefused: .error, message}' <<<"$requoted" >&2
  fi
fi
# endregion

# region wallets-deliver-to
# Requote one quote with a delivery from its deliverTo options: an address keeps its chain and
# any destination tag it was approved with.
target=$(jq -c 'first(.quotes[] as $q | $q.bindingOptions[] | select(.kind == "deliverTo")
  | .candidates[] | select(.kind != "venueAccount" and .address != null and (.chains | length) > 0)
  | {quoteId: $q.id, deliverTo: ({kind: "address", chain: .chains[0], address}
      + (if .destinationTag then {destinationTag} else {} end))}) // empty' <<<"$quotes")
if [[ -z $target ]]; then
  # No quote lists one (an API key is usually not shown deliverTo candidates). Name one of
  # your workspace's delivery candidates from your Default binding on the first venue quote.
  defaults=$(tetrafi GET "/api/v1/workspaces/$TETRAFI_WORKSPACE_ID/binding-defaults/me")
  target=$(jq -c -n --argjson q "$quotes" --argjson d "$defaults" '
    first($q.quotes[] | select(.binding.account != null and .pay.chain == null)) as $venue
    | first($d.candidates.deliverTo[] | select(.address != null and (.chains | length) > 0)) as $c
    | {quoteId: $venue.id, deliverTo: {kind: "address", chain: $c.chains[0], address: $c.address}}' || true)
fi
if [[ -z $target ]]; then
  echo '{"deliverTo":"no venue quote and delivery candidate to try"}' >&2
  deliver_outcome=none
else
  body=$(jq -c '{requote: .quoteId, bind: {deliverTo}}' <<<"$target")
  if delivered=$(quote_request "$body"); then
    jq -c '.quotes[0] | {quoteId: .id, requoteOf, next: .next.kind, deliverTo: .binding.deliverTo.kind,
      receive: .receive.amount}' <<<"$delivered" >&2
    deliver_outcome=$(jq -r '.quotes[0].next.kind' <<<"$delivered")
  else
    # A venue that cannot deliver there names why in details.reason,
    # for example WITHDRAWAL_CHAIN_UNSUPPORTED or DESTINATION_NOT_APPROVED.
    deliver_outcome=$(jq -r '[.error, .details.reason // empty] | join(":")' <<<"$delivered")
    jq -c '{requoteRefused: .error, reason: .details.reason, message}' <<<"$delivered" >&2
  fi
fi
# endregion

jq -c -n --argjson quotes "$quotes" --arg bind "$bind_outcome" --arg deliver "$deliver_outcome" '{
  quotes: ($quotes.quotes | length),
  sources: ($quotes.sources | group_by(.status) | map({(.[0].status): length}) | add),
  requoteBind: $bind, requoteDeliverTo: $deliver}'
