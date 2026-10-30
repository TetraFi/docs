# Webhooks: verify a delivery's Standard Webhooks signature before you trust its body.
# Checks the verifier against the published Standard Webhooks example delivery, then two
# deliveries it must refuse: a changed body and a stale timestamp.
#
# Needs Python 3.8 or later. Calls no API. The last line printed is one JSON summary.
#   python3 samples/python/webhook-verify.py
import base64
import hashlib
import hmac
import json
import sys
import time


# region webhook-verify
# Pass the raw request body as bytes, before any JSON parsing, and the three webhook-* headers.
# Returns True when one signature matches and the timestamp is within 5 minutes of now.
def verify_webhook(secret, headers, raw_body, now=None):
    now = int(time.time()) if now is None else now
    msg_id = headers.get("webhook-id")
    try:
        timestamp = int(headers.get("webhook-timestamp", ""))
    except ValueError:
        return False
    if not msg_id or abs(now - timestamp) >= 300:
        return False
    key = base64.b64decode(secret[len("whsec_"):] if secret.startswith("whsec_") else secret)
    signed = f"{msg_id}.{timestamp}.".encode() + raw_body
    expected = base64.b64encode(hmac.new(key, signed, hashlib.sha256).digest()).decode()
    # During a secret rotation the header holds two space-separated signatures: either may match.
    for value in headers.get("webhook-signature", "").split(" "):
        version, _, signature = value.partition(",")
        if version == "v1" and hmac.compare_digest(signature, expected):
            return True
    return False
# endregion


secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"
timestamp = 1614265330
headers = {
    "webhook-id": "msg_p5jXN8AQM9LWM0D4loKWxJek",
    "webhook-timestamp": str(timestamp),
    "webhook-signature": "v1,bm90LXRoaXMtb25l v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
}
body = b'{"test": 2432232314}'


def fail(error):
    print(json.dumps({"error": error}), file=sys.stderr)
    sys.exit(1)


if not verify_webhook(secret, headers, body, timestamp):
    fail("VALID_DELIVERY_REFUSED")
if verify_webhook(secret, headers, b'{"test": 1}', timestamp):
    fail("CHANGED_BODY_ACCEPTED")
if verify_webhook(secret, headers, body, timestamp + 301):
    fail("STALE_TIMESTAMP_ACCEPTED")
print(json.dumps({"valid": "accepted", "changedBody": "refused", "staleTimestamp": "refused"}))
