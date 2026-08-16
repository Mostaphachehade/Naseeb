// How many proxies to believe.
//
// `app.set('trust proxy', 1)` was already here, and 1 is the right number for
// Render. What was missing is that the number is a deployment fact, not a
// constant — and that being wrong about it in either direction breaks something
// that matters:
//
//   Too high (or `true`): Express walks further left down X-Forwarded-For than
//   there are real proxies, and starts believing addresses the *client* wrote.
//   Every rate limit becomes per-header rather than per-client, which is the
//   same as having no rate limit: a script sends a different forged address each
//   request and never shares a bucket with itself.
//
//   Too low: every request appears to come from the proxy, so one bucket is
//   shared by every visitor and the first busy user locks out everyone else.
//
// With N hops, Express takes the (N+1)-th address counting from the right of
// [socket, ...X-Forwarded-For reversed]. A client can prepend anything it likes
// to X-Forwarded-For; it cannot control the entry the last trusted proxy
// appends. So the guarantee is exactly: *the rightmost N entries are ours, and
// only those are read.*
//
// Default is 0 — believe nothing — because a wrong default should fail towards
// "shared bucket", never towards "spoofable". Render sets 1; the test suite sets
// 1 explicitly, because the suite is the proxy.

const MAX_HOPS = 10;

function readHops(env = process.env) {
  const raw = env.TRUSTED_PROXY_HOPS;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { hops: env.NODE_ENV === 'production' ? 1 : 0, source: 'default' };
  }

  const value = String(raw).trim();
  if (!/^\d+$/.test(value)) {
    throw new Error(
      `TRUSTED_PROXY_HOPS must be a whole number of proxies between 0 and ${MAX_HOPS} (got a non-numeric value).`
    );
  }
  const hops = Number(value);
  if (hops > MAX_HOPS) {
    throw new Error(`TRUSTED_PROXY_HOPS must be between 0 and ${MAX_HOPS}.`);
  }
  return { hops, source: 'configured' };
}

// Called at startup. Throws on an unusable configuration rather than starting
// with a limiter that cannot do its job.
function resolveTrustProxy(env = process.env) {
  const { hops, source } = readHops(env);
  const production = env.NODE_ENV === 'production';

  // `true` and `'*'` are the settings that make forwarding headers freely
  // spoofable. They are not reachable through TRUSTED_PROXY_HOPS, and this
  // states why for anyone tempted to reintroduce them.
  return {
    value: hops,
    hops,
    source,
    production,
    description:
      hops === 0
        ? 'no proxy trusted; the socket address is the client'
        : `${hops} proxy hop${hops === 1 ? '' : 's'} trusted; only the rightmost ${hops} X-Forwarded-For ${hops === 1 ? 'entry is' : 'entries are'} read`,
  };
}

module.exports = { resolveTrustProxy, readHops, MAX_HOPS };
