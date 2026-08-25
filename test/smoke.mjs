import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadGatewayConfig } from "../dist/config.js";
import { HealthServer } from "../dist/health.js";
import { CodexSdkBackend } from "../dist/agent.js";
import { CodexAppServerBackend } from "../dist/app-server-backend.js";
import { messageKey } from "../dist/message-key.js";
import { parseGetUpdatesResponse } from "../dist/weixin/api/api.js";
import { monitorWeixinProvider } from "../dist/weixin/monitor/monitor.js";
import {
  ConversationSettingsStore,
  InboxStore,
  MessageLedger,
  PendingReplyStore,
  ThreadStore,
} from "../dist/json-store.js";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-gateway-test-"));
try {
  fs.mkdirSync(path.join(temporary, "workspace"), { recursive: true });
  const configPath = path.join(temporary, "gateway.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({ stateDir: "state", codex: { workingDirectory: "workspace" } }),
    "utf-8",
  );
  const config = loadGatewayConfig(configPath);
  const canonicalWorkspace = fs.realpathSync.native(path.join(temporary, "workspace"));
  assert.equal(config.stateDir, path.join(temporary, "state"));
  assert.equal(config.codex.workingDirectory, canonicalWorkspace);
  assert.deepEqual(config.codex.projectRoots, [canonicalWorkspace]);
  assert.equal(config.codex.sandboxMode, "read-only");
  assert.equal(config.codex.backend, "app-server");
  assert.equal(config.codex.model, "gpt-5.6-sol");
  assert.equal(config.codex.serviceTier, "default");
  assert.equal(config.codex.modelReasoningEffort, "low");
  assert.equal(config.weixin.typingKeepaliveMs, 5_000);

  const threads = new ThreadStore(config.stateDir);
  threads.set("account:user", "thread-1");
  assert.equal(threads.get("account:user"), "thread-1");

  const settings = new ConversationSettingsStore(config.stateDir);
  settings.setModel("account:user", "gpt-5.6-terra");
  settings.setReasoningEffort("account:user", "low");
  settings.setServiceTier("account:user", "priority");
  assert.deepEqual(
    {
      model: settings.get("account:user").model,
      modelReasoningEffort: settings.get("account:user").modelReasoningEffort,
      serviceTier: settings.get("account:user").serviceTier,
    },
    { model: "gpt-5.6-terra", modelReasoningEffort: "low", serviceTier: "priority" },
  );
  settings.clear("account:user");
  assert.deepEqual(settings.get("account:user"), {});

  const backend = new CodexSdkBackend(config);
  assert.match(
    await backend.respond({ conversationKey: "account:command", text: "/settings" }),
    /gpt-5\.6-sol[\s\S]*low/,
  );
  assert.match(
    await backend.respond({ conversationKey: "account:command", text: "/effort low" }),
    /low/,
  );
  assert.match(
    await backend.respond({ conversationKey: "account:command", text: "/model gpt-5.6-terra" }),
    /gpt-5\.6-terra/,
  );
  assert.match(
    await backend.respond({ conversationKey: "account:command", text: "/speed fast" }),
    /priority/,
  );
  assert.match(
    await backend.respond({ conversationKey: "account:command", text: "/settings" }),
    /gpt-5\.6-terra[\s\S]*low[\s\S]*priority/,
  );
  assert.match(
    await backend.respond({ conversationKey: "account:command", text: "/settings reset" }),
    /gpt-5\.6-sol[\s\S]*low/,
  );

  const replies = new PendingReplyStore(config.stateDir);
  replies.set("message-1", "reply", [
    { kind: "image", path: path.join(temporary, "generated.png"), mimeType: "image/png" },
  ]);
  assert.equal(replies.get("message-1"), "reply");
  replies.markChunkSent("message-1", 0);
  replies.markArtifactSent("message-1", 0);
  assert.deepEqual(replies.getDelivery("message-1"), {
    text: "reply",
    sentChunks: [0],
    artifacts: [
      {
        kind: "image",
        path: path.join(temporary, "generated.png"),
        mimeType: "image/png",
        sent: true,
      },
    ],
  });
  replies.delete("message-1");
  assert.equal(replies.get("message-1"), undefined);

  const ledger = new MessageLedger(config.stateDir);
  assert.equal(ledger.recordFailure("message-1", new Error("first"), 2, {}), false);
  assert.equal(ledger.recordFailure("message-1", new Error("second"), 2, {}), true);
  assert.equal(ledger.has("message-1"), true);

  const parsed = parseGetUpdatesResponse(
    '{"ret":0,"msgs":[{"message_id":7495804885075167001,"seq":7495804885075167002}]}',
  );
  assert.equal(parsed.msgs[0].message_id, "7495804885075167001");
  assert.equal(parsed.msgs[0].seq, "7495804885075167002");
  assert.notEqual(
    messageKey("account", { message_id: "7495804885075167001" }),
    messageKey("account", { message_id: "7495804885075167002" }),
  );

  const inbox = new InboxStore(config.stateDir);
  const inboxEntry = {
    messageKey: "account:message:7495804885075167001",
    conversationKey: "account:user",
    lane: "agent",
    message: { message_id: "7495804885075167001", from_user_id: "user" },
    enqueuedAt: 1,
    availableAt: 1,
  };
  assert.equal(inbox.commitBatch("account", "cursor-1", [inboxEntry]), 1);
  assert.equal(inbox.cursor("account"), "cursor-1");
  assert.equal(inbox.count(), 1);
  assert.equal(inbox.first("account:user", "agent").messageKey, inboxEntry.messageKey);
  inbox.defer(inboxEntry.messageKey, 10);
  assert.equal(inbox.first("account:user", "agent").availableAt, 10);
  inbox.remove(inboxEntry.messageKey);
  assert.equal(inbox.count(), 0);
  fs.writeFileSync(path.join(config.stateDir, "delivery-state.json"), "{broken", "utf-8");
  assert.throws(() => inbox.count(), /durable delivery state is unreadable/);
  fs.unlinkSync(path.join(config.stateDir, "delivery-state.json"));

  const monitorAbort = new AbortController();
  const committedBatches = [];
  let pollCount = 0;
  await monitorWeixinProvider({
    baseUrl: "https://example.invalid",
    token: "test",
    accountId: "monitor-test",
    abortSignal: monitorAbort.signal,
    longPollTimeoutMs: 1,
    loadCursor: () => "cursor-0",
    fetchUpdates: async ({ get_updates_buf }) => {
      pollCount += 1;
      return {
        ret: 0,
        msgs: [{ message_id: String(pollCount), from_user_id: "user" }],
        get_updates_buf: `cursor-${pollCount}`,
      };
    },
    commitBatch: async (messages, cursor) => {
      committedBatches.push({ messages, cursor });
      if (committedBatches.length === 2) monitorAbort.abort();
    },
  });
  assert.deepEqual(
    committedBatches.map((batch) => batch.cursor),
    ["cursor-1", "cursor-2"],
  );

  const appServerBackend = new CodexAppServerBackend(config);
  assert.match(
    appServerBackend.handleControlCommand({
      conversationKey: "account:app-server-command",
      text: "/settings",
    }),
    /app-server/,
  );
  const frozenSettings = appServerBackend.snapshotSettings("account:settings-snapshot");
  assert.equal(frozenSettings.modelReasoningEffort, "low");
  assert.equal(frozenSettings.serviceTier, "default");
  assert.match(
    appServerBackend.handleControlCommand({
      conversationKey: "account:settings-snapshot",
      text: "/effort high",
    }),
    /high/,
  );
  assert.match(
    appServerBackend.handleControlCommand({
      conversationKey: "account:settings-snapshot",
      text: "/speed fast",
    }),
    /priority/,
  );
  const updatedSettings = appServerBackend.snapshotSettings("account:settings-snapshot");
  assert.equal(frozenSettings.modelReasoningEffort, "low");
  assert.equal(frozenSettings.serviceTier, "default");
  assert.equal(updatedSettings.modelReasoningEffort, "high");
  assert.equal(updatedSettings.serviceTier, "priority");

  const status = { ready: false };
  const health = new HealthServer("127.0.0.1", 0, () => status);
  await health.start();
  const port = health.port();
  assert.ok(port);
  assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/readyz`)).status, 503);
  status.ready = true;
  assert.equal((await fetch(`http://127.0.0.1:${port}/readyz`)).status, 200);
  await health.stop();

  process.stdout.write("smoke tests passed\n");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
