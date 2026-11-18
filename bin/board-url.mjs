// One rule for every CLI that carries a bearer token: https anywhere, plain http only to the machine itself
// (a local board in a test). A misconfigured BOARD_URL must fail closed BEFORE the token is sent; a bearer over
// cleartext http to another host is the token handed to the network (review R2-5).
// A URL with `user:pass@` is refused too: the basic-auth password would otherwise be printed by every "board
// unreachable at <url>" line, and fetch itself echoes the full URL in its error (review R2 re-check B). No
// message built here repeats the raw value, so nothing a caller prints can carry the credential.
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const HAS_USERINFO = /^(?:[a-z][a-z0-9+.-]*:)?\/\/[^/?#]*@/i;

/** The validated base URL (trailing slash removed), or a thrown Error whose message names the rule. */
export function boardBaseUrl(raw) {
  const value = String(raw ?? '').trim().replace(/\/$/, '');
  const noCredentials = () => new Error('BOARD_URL must not carry credentials (user:pass@host): the board password goes in the Authorization header via a token file, never in the URL');
  if (HAS_USERINFO.test(value)) throw noCredentials();
  let url;
  try { url = new URL(value); } catch {
    throw new Error('BOARD_URL must be an absolute https URL (plain http only to loopback)');
  }
  if (url.username || url.password) throw noCredentials();
  if (url.protocol === 'https:' && url.host) return value;
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname.toLowerCase())) return value;
  throw new Error(`BOARD_URL must be https (plain http only to loopback), got ${url.protocol === 'http:' ? `http://${url.host}` : 'another scheme'}`);
}
