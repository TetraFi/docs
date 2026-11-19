# Python 3.8+, standard library only. Run: python3 samples/python/quickstart.py
import hashlib
import hmac
import json
import os
import re
import secrets
import sys
import time
from decimal import Decimal, ROUND_DOWN, localcontext
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote as url_quote
from urllib.request import HTTPRedirectHandler, Request, build_opener

WRITES = ("POST", "PUT", "PATCH", "DELETE")


def sign_request(signing_secret, method, path, body=b"",
                 timestamp=None, nonce=None):
    timestamp = int(time.time()) if timestamp is None else timestamp
    write = method in WRITES
    digest = hashlib.sha256(body).hexdigest()
    lines = [str(timestamp)]
    if write:
        nonce = nonce or secrets.token_urlsafe(18)
        lines.append(nonce)
    lines += [method, path, digest]
    key = bytes.fromhex(signing_secret)
    message = "\n".join(lines).encode()
    signature = hmac.new(key, message, hashlib.sha256).hexdigest()
    headers = {"X-Timestamp": str(timestamp), "X-Signature": signature}
    if write:
        headers["X-Nonce"] = nonce
    return headers


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class ResponseError(Exception):
    pass


def compact(value):
    return json.dumps(value, separators=(",", ":"))


def required(name):
    value = os.environ.get(name)
    if not value:
        raise ValueError(f"Set {name}")
    return value


def minimum_receive(amount, bps, decimals):
    if (not isinstance(amount, str) or not re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", amount)
            or not re.fullmatch(r"0|[1-9][0-9]{0,3}", bps)
            or type(decimals) is not int or not 0 <= decimals <= 255):
        raise ValueError("Invalid decimal amount, slippage (0-9999 bps), or asset decimals (0-255).")
    with localcontext() as ctx:
        ctx.prec = len(amount) + decimals + 5
        minimum = (Decimal(amount) * (10000 - int(bps)) / 10000).quantize(
            Decimal(1).scaleb(-decimals), rounding=ROUND_DOWN)
    if not minimum:
        raise ValueError("Minimum receive must be positive; this amount is below the asset precision.")
    return format(minimum, "f")


def order_body(quote, assets):
    body = {"kind": "quote", "quoteId": quote["id"]}
    if quote.get("minReceiveRequired") is True:
        buy = quote["buy"]
        decimals = [deployment["decimals"]
                    for item in assets["items"] if item["asset"] == buy["asset"]
                    for variant in item["variants"] if variant["kind"] == "native"
                    for deployment in variant["deployments"]
                    if not buy.get("network") or deployment["network"] == buy["network"]]
        if not decimals:
            raise ValueError("RECEIVE_ASSET_DECIMALS_MISSING")
        bps = os.environ.get("TETRAFI_SLIPPAGE_BPS") or "50"
        body["minReceive"] = minimum_receive(buy["amount"], bps, min(decimals))
    return compact(body)


def record_path(quote_id):
    if not isinstance(quote_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", quote_id):
        raise ValueError("Invalid quote id.")
    return Path(f"tetrafi-order-{quote_id}.json")


def save_and_load(path, quote, assets):
    if not path.exists() and not path.is_symlink():
        record = {"quoteId": quote["id"], "idempotencyKey": secrets.token_hex(16),
                  "exactBody": order_body(quote, assets)}
        # Exclusive creation: a competing run cannot overwrite the first key.
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            output.write(compact(record) + "\n")
    if path.is_symlink() or not path.is_file():
        raise ValueError("Order record is not a regular file.")
    record = json.loads(path.read_text(encoding="utf-8"))
    if (record["quoteId"] != quote["id"]
            or not re.fullmatch(r"[a-f0-9]{32}", record["idempotencyKey"])
            or not isinstance(record["exactBody"], str)
            or json.loads(record["exactBody"])["quoteId"] != quote["id"]):
        raise ValueError("Order record is unreadable or mismatched. Do not replace it with a new key.")
    return record


def check_order_answer(order, quote_id):
    if (not isinstance(order, dict)
            or not all(isinstance(order.get(key), str) and order[key]
                       for key in ("kind", "orderId", "statusUrl", "status"))
            or not order["statusUrl"].startswith("/api/v1/orders/")
            or type(order.get("terminal")) is not bool
            or order.get("quoteId") not in (None, quote_id)):
        raise ValueError("Order answer is unreadable; it is not proof that nothing was placed.")


def recovery(record, quote_id):
    print(f"""Order outcome may be unknown. Keep {record}. Do not rerun the whole script,
request a fresh quote, generate a new key, or place a fresh order to retry this trade.
Resend the saved exactBody to POST /api/v1/orders with the SAME saved idempotencyKey
and fresh signing headers. Even if replay fails, read GET /api/v1/orders/by-quote/{quote_id}.
ordered: follow statusUrl. unknown or a failed read: wait and read again, never order again.
notOrdered: retry only the saved body and key, and only while expired is false.""", file=sys.stderr)


def main():
    # region quickstart-client
    base_url = required("TETRAFI_BASE_URL")
    api_key = required("TETRAFI_API_KEY")
    signing_secret = os.environ.get("TETRAFI_SIGNING_SECRET")
    opener = build_opener(NoRedirect())

    def tetrafi(method, path, body="", extra=None):
        data = body.encode()
        headers = {"X-API-Key": api_key, "Accept": "application/json",
                   "TetraFi-Version": "2026-11-17"}
        headers.update(extra or {})
        if data:
            headers["Content-Type"] = "application/json"
        if signing_secret:
            headers.update(sign_request(signing_secret, method, path, data))
        request = Request(base_url + path, data or None, headers, method=method)
        try:
            with opener.open(request, timeout=60) as response:
                return json.load(response)
        except HTTPError as error:
            with error:
                raise ResponseError(error.read().decode(errors="replace"))

    sell = os.environ.get("TETRAFI_SELL") or "USDC"
    buy = os.environ.get("TETRAFI_BUY") or "USDT"
    amount = os.environ.get("TETRAFI_AMOUNT") or "10"
    # endregion

    # region quickstart-assets
    assets = {"items": []}
    cursor = ""
    while True:  # follow nextCursor to the last page
        query = f"&cursor={url_quote(cursor, safe='')}" if cursor else ""
        page = tetrafi("GET", f"/api/v1/assets?limit=200{query}")
        assets["items"] += page["items"]
        cursor = page.get("nextCursor") or ""
        if not cursor:
            break
    for asset in (sell, buy):
        if not any(item["asset"] == asset for item in assets["items"]):
            error = {"error": "ASSET_NOT_LISTED", "asset": asset}
            raise ValueError(compact(error))
    print(f"assets: {len(assets['items'])} listed, quoting {sell} for {buy}",
          file=sys.stderr)
    # endregion

    # region quickstart-quote
    request = {"kind": "pair", "sell": {"asset": sell}, "buy": {"asset": buy},
               "sellAmount": amount}
    venues = os.environ.get("TETRAFI_VENUES")
    if venues:
        request["filters"] = {"venues": {"include": venues.split(",")}}
    quotes = tetrafi("POST", "/api/v1/quotes", compact(request))

    # Quotes arrive best first. Take the first quote you can order now.
    quote = next((item for item in quotes["quotes"]
                  if (item.get("next") or {}).get("kind") == "order"), None)
    if quote is None:
        sources = [{"venue": item["venue"]["id"], "status": item["status"],
                    "reason": item.get("reason")} for item in quotes["sources"]]
        error = {"error": "NO_ACTIONABLE_QUOTE", "sources": sources}
        raise ValueError(compact(error))
    venue = quote["legs"][0]["venue"]
    print(compact({"quoteId": quote["id"], "venue": venue["id"],
                   "mode": venue["integrationMode"],
                   "sell": quote["sell"]["amount"],
                   "buy": quote["buy"]["amount"], "next": quote["next"]["kind"],
                   "expiresAt": quote["expiresAt"]}), file=sys.stderr)
    # endregion

    if os.environ.get("TETRAFI_PLACE_ORDER") != "1":
        print(compact({"quoteId": quote["id"], "ordered": False}))
        return

    # region quickstart-order
    # Save quote id, Idempotency-Key and exact body before sending.
    # order_body applies slippage and rounds minReceive down when required.
    record = record_path(quote["id"])
    try:
        saved = save_and_load(record, quote, assets)
        idempotency_key = saved["idempotencyKey"]
        placed = tetrafi("POST", "/api/v1/orders", saved["exactBody"],
                         {"Idempotency-Key": idempotency_key})
        check_order_answer(placed, quote["id"])
    except Exception:
        recovery(record, quote["id"])
        raise
    print(f"Order request saved in {record}; reuse it for every retry.",
          file=sys.stderr)
    print(compact({"kind": placed["kind"], "quoteId": placed.get("quoteId")}),
          file=sys.stderr)
    # endregion

    # region quickstart-status
    # terminal says whether status can still change; next says what to do.
    order = tetrafi("GET", placed["statusUrl"])
    print(compact({"kind": order["kind"], "status": order["status"],
                   "terminal": order["terminal"], "next": order.get("next"),
                   "idempotencyKey": idempotency_key}))
    # endregion


def self_test():
    secret = bytes(range(32)).hex()
    body = b'{"quoteId":"q_example","minReceive":"9.95"}'
    path = "/api/v1/orders"
    nonce = "Ex4mpleNonce_0123456789"
    write = sign_request(secret, "POST", path, body, 1795000000, nonce)
    read = sign_request(secret, "GET", path + "?limit=5", b"", 1795000000)
    changed = sign_request(secret, "POST", path, body.replace(b"9.95", b"9.96"),
                           1795000000, nonce)
    assert write["X-Signature"] == "1d39eb3481420b8969e52a21aafb0bd446678ae0db576e92d3662f99ca4792f8"
    assert write["X-Nonce"] == nonce
    assert read["X-Signature"] == "29c51b5c2e63a4c97526add948df624234cc531952995ebb761bd1c50be47e54"
    assert "X-Nonce" not in read
    assert changed["X-Signature"] != write["X-Signature"]
    assert minimum_receive("10.003", "50", 2) == "9.95"
    assert minimum_receive("9007199254740993.23", "0", 2) == "9007199254740993.23"
    try:
        minimum_receive("0.01", "50", 2)
    except ValueError as error:
        assert "positive" in str(error)
    else:
        raise AssertionError("zero minimum must be refused")
    print("Python quickstart: signing vectors and exact minimum receive pass")


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        self_test()
    else:
        try:
            main()
        except Exception as error:
            print(error, file=sys.stderr)
            sys.exit(1)
