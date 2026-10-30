#!/usr/bin/env bash
# Webhooks: verify a delivery's Standard Webhooks signature before you trust its body.
# Checks the verifier against the published Standard Webhooks example delivery, then two
# deliveries it must refuse: a changed body and a stale timestamp.
#
# Needs bash and openssl. Calls no API. The last line printed is one JSON summary.
set -euo pipefail

# region webhook-verify
# verify SECRET ID TIMESTAMP BODY SIGNATURES [NOW]
# SECRET is the whsec_… signing secret. ID, TIMESTAMP and SIGNATURES are the webhook-id,
# webhook-timestamp and webhook-signature headers; BODY is the raw request body, before any
# parsing. Succeeds when one signature matches and the timestamp is within 5 minutes of NOW.
verify() {
  local secret=$1 id=$2 timestamp=$3 body=$4 signatures=$5 now=${6:-$(date +%s)}
  (( timestamp > now - 300 && timestamp < now + 300 )) || return 1
  local key expected candidate
  key=$(printf '%s' "${secret#whsec_}" | openssl base64 -d -A | od -An -tx1 | tr -d ' \n')
  expected=$(printf '%s.%s.%s' "$id" "$timestamp" "$body" \
    | openssl dgst -sha256 -mac HMAC -macopt "hexkey:$key" -binary | openssl base64 -A)
  # During a secret rotation the header holds two space-separated signatures: either may match.
  for candidate in $signatures; do
    [[ $candidate == "v1,$expected" ]] && return 0
  done
  return 1
}
# endregion

secret='whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'
id='msg_p5jXN8AQM9LWM0D4loKWxJek'
timestamp=1614265330
body='{"test": 2432232314}'
signature='v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE='

verify "$secret" "$id" "$timestamp" "$body" "v1,bm90LXRoaXMtb25l $signature" "$timestamp" \
  || { echo '{"error":"VALID_DELIVERY_REFUSED"}' >&2; exit 1; }
if verify "$secret" "$id" "$timestamp" '{"test": 1}' "$signature" "$timestamp"; then
  echo '{"error":"CHANGED_BODY_ACCEPTED"}' >&2; exit 1
fi
if verify "$secret" "$id" "$timestamp" "$body" "$signature" "$((timestamp + 301))"; then
  echo '{"error":"STALE_TIMESTAMP_ACCEPTED"}' >&2; exit 1
fi
echo '{"valid":"accepted","changedBody":"refused","staleTimestamp":"refused"}'
