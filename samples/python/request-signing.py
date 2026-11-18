# Request signing: sign a TetraFi API request with a venue-trading key's signing secret.
# Checks the signer against the published test vectors (a signed write and a signed read), then
# that a changed body changes the signature.
#
# Needs Python 3.8 or later. Calls no API. The last line printed is one JSON summary.
#   python3 samples/python/request-signing.py
import json
import sys

# region sign-request
import hashlib
import hmac
import secrets
import time


# Returns the headers to add to one request. path includes the query string exactly as sent;
# body is the exact bytes you send (b"" for none). A write (POST, PUT, PATCH, DELETE) gets a fresh
# X-Nonce; a read signs without one.
def sign_request(signing_secret, method, path, body=b"", timestamp=None, nonce=None):
    timestamp = int(time.time()) if timestamp is None else timestamp
    write = method in ("POST", "PUT", "PATCH", "DELETE")
    digest = hashlib.sha256(body).hexdigest()
    lines = [str(timestamp)]
    if write:
        nonce = nonce or secrets.token_urlsafe(18)
        lines.append(nonce)
    lines += [method, path, digest]
    # The secret is 64 hexadecimal characters: the key is its 32 decoded bytes.
    signature = hmac.new(bytes.fromhex(signing_secret), "\n".join(lines).encode(), hashlib.sha256).hexdigest()
    headers = {"X-Timestamp": str(timestamp), "X-Signature": signature}
    if write:
        headers["X-Nonce"] = nonce
    return headers
# endregion


# The test vectors on the Authentication page. The secret is an example, never a real one.
secret = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
body = b'{"quoteId":"q_example","minReceive":"9.95"}'
write = sign_request(secret, "POST", "/api/v1/orders", body, 1795000000, "Ex4mpleNonce_0123456789")
read = sign_request(secret, "GET", "/api/v1/orders?limit=5", b"", 1795000000)
changed = sign_request(secret, "POST", "/api/v1/orders", body.replace(b"9.95", b"9.96"), 1795000000, "Ex4mpleNonce_0123456789")


def fail(error):
    print(json.dumps({"error": error}), file=sys.stderr)
    sys.exit(1)


if write["X-Signature"] != "1d39eb3481420b8969e52a21aafb0bd446678ae0db576e92d3662f99ca4792f8":
    fail("WRITE_VECTOR_MISMATCH")
if read["X-Signature"] != "29c51b5c2e63a4c97526add948df624234cc531952995ebb761bd1c50be47e54" or "X-Nonce" in read:
    fail("READ_VECTOR_MISMATCH")
if changed["X-Signature"] == write["X-Signature"]:
    fail("CHANGED_BODY_SAME_SIGNATURE")
print(json.dumps({"write": "matches", "read": "matches", "changedBody": "differs"}))
