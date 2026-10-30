// Webhooks: verify a delivery's Standard Webhooks signature before you trust its body.
// Checks the verifier against the published Standard Webhooks example delivery, then two
// deliveries it must refuse: a changed body and a stale timestamp.
//
// Needs Node 18 or later. Calls no API. The last line printed is one JSON summary.
//   node samples/node/webhook-verify.mjs
import { createHmac, timingSafeEqual } from 'node:crypto';

// #region webhook-verify
// Pass the raw request body, before any JSON parsing, and the three webhook-* headers.
// Returns true when one signature matches and the timestamp is within 5 minutes of now.
function verifyWebhook(secret, headers, rawBody, now = Math.floor(Date.now() / 1000)) {
  const id = headers['webhook-id'];
  const timestamp = Number(headers['webhook-timestamp']);
  if (!id || !Number.isInteger(timestamp) || Math.abs(now - timestamp) >= 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest();
  // During a secret rotation the header holds two space-separated signatures: either may match.
  return String(headers['webhook-signature'] ?? '').split(' ').some((value) => {
    const [version, signature] = value.split(',');
    const given = Buffer.from(signature ?? '', 'base64');
    return version === 'v1' && given.length === expected.length && timingSafeEqual(given, expected);
  });
}
// #endregion

const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const timestamp = 1614265330;
const headers = {
  'webhook-id': 'msg_p5jXN8AQM9LWM0D4loKWxJek',
  'webhook-timestamp': String(timestamp),
  'webhook-signature': 'v1,bm90LXRoaXMtb25l v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
};
const body = '{"test": 2432232314}';

const fail = (error) => { console.error(JSON.stringify({ error })); process.exit(1); };
if (!verifyWebhook(secret, headers, body, timestamp)) fail('VALID_DELIVERY_REFUSED');
if (verifyWebhook(secret, headers, '{"test": 1}', timestamp)) fail('CHANGED_BODY_ACCEPTED');
if (verifyWebhook(secret, headers, body, timestamp + 301)) fail('STALE_TIMESTAMP_ACCEPTED');
console.log(JSON.stringify({ valid: 'accepted', changedBody: 'refused', staleTimestamp: 'refused' }));
