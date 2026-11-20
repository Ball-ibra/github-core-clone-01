// main.ts — the entry point for the forge.
//
// The trial harness (the "env") sits beside this process. The deal is simple:
//   1. start the HTTP server on a port the kernel picks (listen(0), never 8080),
//   2. tell the env that port with POST $MAKEFUN_ENV_URL/register {"port": N},
//   3. keep polling GET $MAKEFUN_ENV_URL/done until it says {"done": true},
//   4. shut the server down and exit 0.
// Everything the suite scores lives in app.ts; this file only runs the dance
// above, retrying transient failures with a growing wait between attempts.

import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envUrl === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is unset, so there is no env to register with\n');
  process.exit(1);
}

// One register/done request may hang for this long before we give up on it.
// Thirty seconds is generous on purpose: the env and the forge share one
// small pod, and a slow first poll must not look like a dead env.
const CALL_TIMEOUT_MS = 30_000;
// Backoff between retries: start short, double, never longer than this.
const BACKOFF_START_MS = 250;
const BACKOFF_LIMIT_MS = 2_000;
// Poll /done at most this often even when the env answers instantly, so a
// fast env does not turn the wait loop into a busy spin.
const DONE_POLL_MIN_MS = 100;

function wait(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function backoff(attempt: number): number {
  const doubled = BACKOFF_START_MS * 2 ** Math.min(attempt, 8);
  return Math.min(BACKOFF_LIMIT_MS, doubled);
}

// Announce our port to the env. A 200 means it heard us; a 409 means some
// other process registered first, which is also fine — we just keep waiting
// for done like everyone else. A 400/405 is a real contract mistake, so we
// stop; anything else is retried, because the env may still be waking up.
async function announce(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const answer = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (answer.status === 200 || answer.status === 409) return;
      if (answer.status === 400 || answer.status === 405) {
        throw new Error(`register was refused with HTTP ${answer.status}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register was refused')) throw err;
    }
    await wait(backoff(attempt));
  }
}

// Ask the env, over and over, whether the trial is finished. The env answers
// immediately each time ({done:false} while the suite runs), so this is a
// poll loop, not a held-open request. We never leave before it says true.
async function waitUntilDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const answer = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      if (answer.ok) {
        const body = (await answer.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // A failed poll just means "not done yet" — try again shortly.
    }
    await wait(Math.max(backoff(attempt), DONE_POLL_MIN_MS));
  }
}

async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind a TCP port');
  }
  process.stdout.write(`[forge] listening on port ${bound.port}\n`);
  await announce(bound.port);
  process.stdout.write('[forge] registered; waiting for done\n');
  await waitUntilDone();
  server.close();
  process.stdout.write('[forge] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
