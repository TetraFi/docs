#!/usr/bin/env bash
# Fee schedule: the fees your workspace pays now, per venue, and any change already scheduled.
# Reads only.
#
# Needs bash, curl, jq and openssl. Reads:
#   TETRAFI_BASE_URL          https://api.tetrafi.io in production
#   TETRAFI_API_KEY           your API key, with Read fee schedule switched on
#   TETRAFI_WORKSPACE_ID      your workspace id: the path names it
#   TETRAFI_SIGNING_SECRET    the key's signing secret, when the key signs its requests
#
# The last line printed is one JSON summary. The script exits 1 when an answer breaks the contract
# it checks.
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

fail() { echo "{\"error\":\"$1\"}" >&2; exit 1; }

# region fee-schedule-read
# GET …/fee-schedule answers the schedule in force (current) and the changes already scheduled
# (upcoming), oldest first. Every rate is a decimal string in parts per million: 100 ppm is one
# basis point. A venue listed in venues uses its own rates; every other venue uses defaultRates.
schedule=$(tetrafi GET "/api/v1/workspaces/$TETRAFI_WORKSPACE_ID/fee-schedule")
jq -c '.current.defaultRates | {platform: .platform.ratePpm, grossPlatform: .grossPlatform.ratePpm,
  takerIncentive: (.takerIncentive.ratePpm // null)}' <<<"$schedule" >&2
jq -c '.current.venues[:3][] | {venueId, platform: .rates.platform.ratePpm}' <<<"$schedule" >&2
jq -c '.upcoming[] | {effectiveFrom, platform: .schedule.defaultRates.platform.ratePpm}' <<<"$schedule" >&2
# endregion

# The contract this script checks.
ppm='type == "string" and test("^[0-9]+(\\.[0-9]+)?$")'
jq -e ".current.defaultRates.platform.ratePpm | $ppm" <<<"$schedule" >/dev/null || fail FEE_RATE_NOT_PPM_STRING
jq -e ".current.defaultRates.grossPlatform.ratePpm | $ppm" <<<"$schedule" >/dev/null || fail FEE_RATE_NOT_PPM_STRING
jq -e ".current.venues | type == \"array\"" <<<"$schedule" >/dev/null || fail FEE_SCHEDULE_SHAPE_UNEXPECTED

jq -c '{workspaceId, platformPpm: .current.defaultRates.platform.ratePpm,
  platformBps: ((.current.defaultRates.platform.ratePpm | tonumber) / 100),
  venues: (.current.venues | length), upcoming: (.upcoming | length)}' <<<"$schedule"
