import assert from "node:assert/strict";

import { AppServerClient } from "../dist/app-server-client.js";

const client = new AppServerClient({ startupTimeoutMs: 30_000 });
try {
  await client.start();
  const first = client.status();
  assert.equal(first.ready, true);
  assert.ok(first.pid);
  await client.start();
  assert.equal(client.status().pid, first.pid);
  process.stdout.write(`live app-server handshake passed pid=${first.pid}\n`);
} finally {
  await client.stop();
}
