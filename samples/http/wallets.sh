#!/usr/bin/env bash
# Trading source and funding: read the trading wallets the key may name (sourceOptions), quote with
# one named per chain (source.tradingWallets), and read where each quote trades from and how it is
# funded. Without a granted wallet, it prints what each on-chain venue says instead.
#
# Needs bash, curl, jq and openssl. Reads:
#   TETRAFI_BASE_URL        https://api.tetrafi.io in production
#   TETRAFI_API_KEY         your API key
#   TETRAFI_WORKSPACE_ID    optional: an API key implies its workspace (a session must send it)
#   TETRAFI_SIGNING_SECRET  the key's signing secret, when request signing is on (venue trading needs it)
# Optional:
#   TETRAFI_AMOUNT  the USDC amount you sell (default 10)
#
# Every request asks for quotes only: nothing is ordered. The last line printed is one JSON
# summary. An API error on the first quote request prints its error body and exits 1; a refused
# source or delivery is printed as its error code, because a refusal is an answer you act on.
set -euo pipefail

: "${TETRAFI_BASE_URL:?Set TETRAFI_BASE_URL}"
: "${TETRAFI_API_KEY:?Set TETRAFI_API_KEY}"

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

amount=${TETRAFI_AMOUNT:-10}

# region me-organisation-wallets
# What this key can trade from: its venue trading setup and the organisation wallets granted to it.
# blockedBy, when present, is the code an organisation-wallet order would be refused with right now.
me=$(tetrafi GET /api/v1/me)
jq -c '.organisationWallets | {venueTradeScope, venueTradeEnabled, requestSigningRequired,
  grants: [.grants[] | .financialAccountId], blockedBy}' <<<"$me" >&2
# endregion
me_summary=$(jq -c '.organisationWallets | {grants: (.grants | length), blocked: (.blockedBy != null)}' <<<"$me")

# USDC's EVM chains, from the asset list.
usdc_chains=$(tetrafi GET /api/v1/assets | jq -c '[.assets[] | select(.assetId == "USDC") | .variants[]
  | select(.kind == "native") | .deployments[].chain | select(startswith("eip155:"))] | unique')

# region trading-source-options
# Every answer's sourceOptions lists, per network, the trading wallets this key may name, each by its
# financialAccountId; isDefault marks the one used when you name none.
first=$(quote_request "$(jq -cn --arg amount "$amount" '{sell: {asset: "USDC"}, buy: {asset: "ETH"},
  sellAmount: $amount}')") || { printf '%s\n' "$first" >&2; exit 1; }
trading_wallets=$(jq -c --argjson chains "$usdc_chains" '[.sourceOptions[]? | select(.kind == "wallet")
  | select(.chain as $c | $chains | index($c))
  | {key: .chain, value: (first((.candidates[] | select(.isDefault)), .candidates[]) | .financialAccountId)}
  | select(.value != null)] | from_entries' <<<"$first")
jq -c '{sourceOptions: [.sourceOptions[]? | {kind, chain, candidates: [.candidates[] | {financialAccountId, kind, displayName, isDefault}]}]}' <<<"$first" >&2
# endregion

if [[ $(jq 'length' <<<"$trading_wallets") == 0 ]]; then
  # Nothing granted yet: each on-chain venue says why it did not quote.
  jq -c '[.sources[] | select(.status != "answered" and .status != "filteredOut")
    | {venue: .venue.id, status, reason, detail}]' <<<"$first" >&2
  jq -cn '{tradingWallets: {}, quoted: false}'
  exit 0
fi

# region trading-source-request
# Name one trading wallet per chain in source.tradingWallets, by the financialAccountId sourceOptions
# gave: two chains move USDC between them, one chain swaps USDC for ETH on it.
request=$(jq -cn --argjson w "$trading_wallets" --arg amount "$amount" '($w | keys) as $chains
  | (if ($chains | length) > 1
      then {sell: {asset: "USDC", chain: $chains[0]}, buy: {asset: "USDC", chain: $chains[1]}}
      else {sell: {asset: "USDC", chain: $chains[0]}, buy: {asset: "ETH", chain: $chains[0]}} end)
  + {sellAmount: $amount, source: {tradingWallets: ($w | with_entries(select(.key as $k | $chains[0:2] | index($k))))}}')
# endregion

# region trading-source-refusal
# A wallet or account you may not use at all is refused before any venue is asked (for example
# 403 SOURCE_NOT_OWNED): nothing is quoted or reserved. A trading wallet a venue account has not
# linked is not refused: that venue reads unavailable with reason tradingSourceNotLinked.
if ! quotes=$(quote_request "$request"); then
  jq -c '{refused: .error, message, next}' <<<"$quotes" >&2
  jq -cn --argjson q "$quotes" '{tradingWallets: true, refused: $q.error}'
  exit 0
fi
jq -c '[.sources[] | select(.reason == "tradingSourceNotLinked") | {venue: .venue.id, reason, detail}]' <<<"$quotes" >&2
# endregion

# region trading-source-funding
# Each quote names where it trades from (tradingSource), how the venue is funded (fundingModel,
# fundingAccount) and how it settles. Read them; never assume them from the venue's name.
jq -c '.quotes[] | {quoteId: .id, venue: ([.legs[].venue.id] | join(" + ")), location: .location.kind,
  tradingSource: (.tradingSource | {kind, financialAccountId, network}), fundingModel,
  fundingAccount: (.fundingAccount | {kind, financialAccountId}), buy: .buy.amount, next: .next.kind}' <<<"$quotes" >&2
# endregion

# region wallets-deliver-to
# Delivering elsewhere is a requote with deliverTo. With an API key a venue account's output stays on
# the account: a deliverTo naming another destination is refused (REQUOTE_REFUSED, deliverToNotPermitted).
target=$(jq -c 'first(.quotes[] | select(.location.kind == "offChain")) // empty' <<<"$quotes")
if [[ -z $target ]]; then
  echo '{"deliverTo":"no off-chain quote to try"}' >&2
  deliver_outcome=none
else
  body=$(jq -c --argjson w "$trading_wallets" '{requote: .id, deliverTo: {kind: "financialAccount",
    financialAccountId: ($w | to_entries[0].value)}}' <<<"$target")
  if delivered=$(quote_request "$body"); then
    deliver_outcome=$(jq -r '.quotes[0].next.kind' <<<"$delivered")
  else
    deliver_outcome=$(jq -r '[.error, .details.reason // empty] | join(":")' <<<"$delivered")
  fi
fi
# endregion

jq -cn --argjson q "$quotes" --arg deliver "$deliver_outcome" --argjson me "$me_summary" '{tradingWallets: true, me: $me,
  quotes: ($q.quotes | length), fromNamedWallet: ([$q.quotes[] | select(.tradingSource.kind == "wallet")] | length),
  requoteDeliverTo: $deliver}'
