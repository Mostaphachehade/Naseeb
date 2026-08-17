// Stopping cleanly.
//
// A container being replaced gets SIGTERM and a grace period. What happens in
// that window decides whether a deploy is invisible or whether somebody's
// request is cut off mid-write — and, in this codebase specifically, whether a
// leased outbox row is left stranded until its lease expires.
//
// This is a coordinator rather than a pile of `process.on` handlers, for two
// reasons. Handlers registered in several modules run in an order nobody chose
// and each one calls `process.exit` on its own schedule, so the first to finish
// kills the rest. And `process.exit` is untestable: a test that triggers it ends
// the test runner. Here the exit is a single injected callback, so the whole
// sequence can be driven and asserted in-process.
//
// The order matters and is the order below:
//
//   1. Refuse readiness. A load balancer stops sending new traffic before
//      anything is torn down, rather than after.
//   2. Stop scheduling new background work.
//   3. Stop the HTTP server accepting connections; let in-flight requests
//      finish.
//   4. Let leased jobs and outbox drains settle.
//   5. Close the pool.
//   6. Exit 0 when that all completed inside the budget, non-zero when it did
//      not — because a hung shutdown that reports success is a deploy that
//      looks healthy while a connection leaks.

const DEFAULT_TIMEOUT_MS = 20000;

function timeoutMs() {
  const configured = Number(process.env.SHUTDOWN_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 1000 ? configured : DEFAULT_TIMEOUT_MS;
}

// One coordinator per process. Exported as a factory so a test can build its
// own with fakes rather than driving the real one.
function createShutdownCoordinator({
  // Each is optional; a process that has no scheduler passes no scheduler.
  server = null,
  pool = null,
  scheduler = null,
  outbox = null,
  setReady = () => {},
  log = console,
  exit = (code) => process.exit(code),
  timeout = timeoutMs(),
} = {}) {
  let state = 'running';
  let finished = null;
  // The HTTP server exists only after listen(), which is after the coordinator
  // has to be installed — a SIGTERM during startup must be handled too. So it
  // is attached when it appears rather than required up front.
  let httpServer = server;

  const isShuttingDown = () => state !== 'running';

  // Anything that starts background work asks this first. It is the mechanism
  // that stops a scheduler tick firing after teardown began — the failure mode
  // where a worker claims a row a second before the pool closes underneath it.
  const mayStartWork = () => state === 'running';

  function attachServer(value) {
    httpServer = value;
    // A server attached after shutdown began must not be left listening: the
    // race is real on a container that is replaced during a slow boot.
    if (state !== 'running' && value && typeof value.close === 'function') value.close();
    return coordinator;
  }

  async function closeServer() {
    if (!httpServer || typeof httpServer.close !== 'function') return;
    await new Promise((resolve) => {
      // `close` stops accepting new connections and calls back when the last
      // in-flight response finishes. Keep-alive sockets are closed too on
      // modern Node, which is what stops a persistent connection holding the
      // process open for the whole grace period.
      httpServer.close(() => resolve());
      if (typeof httpServer.closeIdleConnections === 'function') httpServer.closeIdleConnections();
    });
  }

  async function shutdown(signal) {
    // Idempotent. A second SIGTERM — or SIGINT after SIGTERM — joins the
    // shutdown already running rather than starting a competing one.
    if (finished) {
      log.error(`Shutdown already in progress; ignoring ${signal}.`);
      return finished;
    }
    state = 'draining';

    finished = (async () => {
      const started = Date.now();
      let clean = true;

      // 1 + 2. Readiness goes false first, then nothing new is scheduled.
      try {
        setReady(false);
      } catch (err) {
        clean = false;
      }
      try {
        if (scheduler && typeof scheduler.stop === 'function') scheduler.stop();
      } catch (err) {
        clean = false;
      }

      log.log(`${signal} received. Draining (up to ${timeout}ms).`);

      // 3-5, all inside one budget.
      const work = (async () => {
        await closeServer();
        // Leased outbox drains. `settle` waits for what was already started and
        // deliberately not for anything started after it — by this point
        // `mayStartWork()` is false, so nothing new can begin.
        if (outbox && typeof outbox.settle === 'function') await outbox.settle();
        if (pool && typeof pool.end === 'function') await pool.end();
      })();

      const timedOut = Symbol('timeout');
      let timer;
      const budget = new Promise((resolve) => {
        timer = setTimeout(() => resolve(timedOut), timeout);
        // Never hold the process open on the timer itself.
        if (typeof timer.unref === 'function') timer.unref();
      });

      let outcome;
      try {
        outcome = await Promise.race([work.then(() => 'done'), budget]);
      } catch (err) {
        // A failure closing something is still a failure to shut down cleanly.
        // The message is not logged: a pool error can carry a connection string.
        log.error('Shutdown encountered an error while closing resources.');
        outcome = 'error';
      } finally {
        clearTimeout(timer);
      }

      if (outcome === timedOut) {
        clean = false;
        log.error(
          `Shutdown did not finish within ${timeout}ms. Exiting non-zero: something is still holding a connection or a request.`
        );
      } else if (outcome === 'error') {
        clean = false;
      }

      state = 'stopped';
      const ms = Date.now() - started;
      if (clean) log.log(`Shutdown complete in ${ms}ms.`);

      exit(clean ? 0 : 1);
      return { clean, ms, signal };
    })();

    return finished;
  }

  // Registered once. `once` rather than `on`, plus the idempotence above, so a
  // repeated signal cannot start a second teardown.
  function install(processRef = process) {
    ['SIGTERM', 'SIGINT'].forEach((signal) => {
      processRef.once(signal, () => {
        shutdown(signal);
      });
    });
    return coordinator;
  }

  const coordinator = {
    shutdown,
    install,
    attachServer,
    isShuttingDown,
    mayStartWork,
    get state() {
      return state;
    },
    timeout,
  };
  return coordinator;
}

module.exports = { createShutdownCoordinator, DEFAULT_TIMEOUT_MS, timeoutMs };
