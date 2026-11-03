#!/usr/bin/env bash
# Service-account tokens: exchange a service account's API key for a short-lived bearer token
# (OAuth 2.0 client credentials), read who it is with GET /api/v1/me, send one read with it, and
# see a key with request signing on refused. Reads only: nothing is quoted or ordered.
#
# Needs bash, curl and jq. Reads:
#   TETRAFI_BASE_URL               https://api.tetrafi.io in production
#   TETRAFI_CLIENT_ID              the service account's id
#   TETRAFI_CLIENT_SECRET          one of its API keys, with request signing off
# Optional:
#   TETRAFI_SIGNED_CLIENT_SECRET   another of its keys, with request signing on, to see it refused
#
# The last line printed is one JSON summary. The script exits 1 when an answer breaks the contract
# it checks.
set -euo pipefail

: "${TETRAFI_BASE_URL:?Set TETRAFI_BASE_URL}"
: "${TETRAFI_CLIENT_ID:?Set TETRAFI_CLIENT_ID}"
: "${TETRAFI_CLIENT_SECRET:?Set TETRAFI_CLIENT_SECRET}"

# post_token SECRET
# Sends the client-credentials form and prints the response body, then its status on a last line.
post_token() {
  curl -sS -X POST "$TETRAFI_BASE_URL/api/v1/oauth/token" \
    -H "Accept: application/json" \
    --data-urlencode "grant_type=client_credentials" \
    --data-urlencode "client_id=$TETRAFI_CLIENT_ID" \
    --data-urlencode "client_secret=$1" \
    -w $'\n%{http_code}'
}

# region oauth-token
# Exchange the key for a bearer token. expires_in is in seconds (at most 900): ask for a new
# token before it runs out, and never store one.
response=$(post_token "$TETRAFI_CLIENT_SECRET")
status=${response##*$'\n'}
token_body=${response%$'\n'*}
if [[ $status != 200 ]]; then
  jq -c '{error, error_description}' <<<"$token_body" >&2
  exit 1
fi
access_token=$(jq -r '.access_token' <<<"$token_body")
jq -c '{token_type, expires_in, scope}' <<<"$token_body" >&2
# endregion

# region oauth-me
# Send the token as a bearer. GET /api/v1/me answers for the key the token was exchanged from:
# its id, its workspace, the scopes the token may use now and, under organisationWallets,
# blockedBy: the code an organisation-wallet order would be refused with right now.
me=$(curl -sS "$TETRAFI_BASE_URL/api/v1/me" \
  -H "Authorization: Bearer $access_token" \
  -H "Accept: application/json" \
  -w $'\n%{http_code}')
me_status=${me##*$'\n'}
me=${me%$'\n'*}
if [[ $me_status != 200 ]]; then
  printf '%s\n' "$me" >&2
  exit 1
fi
jq -c '{authKind, auth, keyId, workspaceId, scopes, blockedBy: .organisationWallets.blockedBy}' <<<"$me" >&2
# endregion

# region oauth-call
# Every other request takes the same header. Here, the workspace's latest order (orders_read).
orders=$(curl -sS "$TETRAFI_BASE_URL/api/v1/orders?limit=1" \
  -H "Authorization: Bearer $access_token" \
  -H "Accept: application/json" \
  -w $'\n%{http_code}')
orders_status=${orders##*$'\n'}
orders=${orders%$'\n'*}
if [[ $orders_status != 200 ]]; then
  printf '%s\n' "$orders" >&2
  exit 1
fi
jq -c '{orders: [.items[] | {orderId, kind, status, terminal}]}' <<<"$orders" >&2
# endregion

# region oauth-signed-refused
# A key with request signing on is never exchanged: it signs each request itself instead.
# The refusal is 400 unauthorized_client, and error_uri ends with #SIGNED_KEY_NOT_EXCHANGEABLE.
signed=skipped
if [[ -n ${TETRAFI_SIGNED_CLIENT_SECRET:-} ]]; then
  refused=$(post_token "$TETRAFI_SIGNED_CLIENT_SECRET")
  refused_status=${refused##*$'\n'}
  refused=${refused%$'\n'*}
  jq -c --arg status "$refused_status" '{status: ($status | tonumber), error, error_uri}' <<<"$refused" >&2
  if [[ $refused_status != 400 ]] || ! jq -e '.error == "unauthorized_client"
      and (.error_uri // "" | endswith("#SIGNED_KEY_NOT_EXCHANGEABLE"))' <<<"$refused" >/dev/null; then
    exit 1
  fi
  signed=SIGNED_KEY_NOT_EXCHANGEABLE
fi
# endregion

jq -cn --argjson token "$token_body" --argjson me "$me" --arg signed "$signed" '{tokenType: $token.token_type,
  expiresIn: $token.expires_in, auth: $me.auth, scopes: ($me.scopes | length), signedKey: $signed}'
