// Request signing: sign a TetraFi API request with a venue-trading key's signing secret.
// Checks the signer against the published test vectors (a signed write and a signed read), then
// that a changed body changes the signature.
//
// Needs Node 18 or later. Calls no API. The last line printed is one JSON summary.
//   node samples/node/request-signing.mjs
// #region sign-request
import { createHash, createHmac, randomBytes } from 'node:crypto';

// Returns the headers to add to one request. `path` includes the query string exactly as sent;
// `body` is the exact bytes you send ('' for none). A write (POST, PUT, PATCH, DELETE) gets a fresh
// X-Nonce; a read signs without one.
function signRequest(signingSecret, method, path, body = '', timestamp = Math.floor(Date.now() / 1000),
  nonce = randomBytes(18).toString('base64url')) {
  const write = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  const digest = createHash('sha256').update(body).digest('hex');
  const lines = write ? [timestamp, nonce, method, path, digest] : [timestamp, method, path, digest];
  // The secret is 64 hexadecimal characters: the key is its 32 decoded bytes.
  const signature = createHmac('sha256', Buffer.from(signingSecret, 'hex')).update(lines.join('\n')).digest('hex');
  return { 'X-Timestamp': String(timestamp), ...(write ? { 'X-Nonce': nonce } : {}), 'X-Signature': signature };
}
// #endregion

// The test vectors on the Authentication page. The secret is an example, never a real one.
const secret = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const body = '{"quoteId":"q_example","minReceive":"9.95"}';
const write = signRequest(secret, 'POST', '/api/v1/orders', body, 1795000000, 'Ex4mpleNonce_0123456789');
const read = signRequest(secret, 'GET', '/api/v1/orders?limit=5', '', 1795000000);
const changed = signRequest(secret, 'POST', '/api/v1/orders', body.replace('9.95', '9.96'), 1795000000, 'Ex4mpleNonce_0123456789');

const fail = (error) => { console.error(JSON.stringify({ error })); process.exit(1); };
if (write['X-Signature'] !== '1d39eb3481420b8969e52a21aafb0bd446678ae0db576e92d3662f99ca4792f8') fail('WRITE_VECTOR_MISMATCH');
if (read['X-Signature'] !== '29c51b5c2e63a4c97526add948df624234cc531952995ebb761bd1c50be47e54' || 'X-Nonce' in read) fail('READ_VECTOR_MISMATCH');
if (changed['X-Signature'] === write['X-Signature']) fail('CHANGED_BODY_SAME_SIGNATURE');
console.log(JSON.stringify({ write: 'matches', read: 'matches', changedBody: 'differs' }));
