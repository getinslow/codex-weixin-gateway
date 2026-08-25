import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CodexAppServerBackend } from "../dist/app-server-backend.js";
import { loadGatewayConfig } from "../dist/config.js";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-live-turn-"));
const configPath = path.join(temporary, "gateway.json");
fs.writeFileSync(
  configPath,
  JSON.stringify({
    stateDir: "state",
    codex: {
      backend: "app-server",
      workingDirectory: process.cwd(),
      model: "gpt-5.6-sol",
      modelReasoningEffort: "low",
      serviceTier: "default",
      sandboxMode: "read-only",
      approvalPolicy: "never",
      turnTimeoutMs: 300_000,
      promptPrefix: "这是网关后端连通性测试。请严格按用户要求简短回复。",
    },
    logging: { level: "INFO", console: true },
  }),
  "utf-8",
);

const backend = new CodexAppServerBackend(loadGatewayConfig(configPath));
const startedAt = Date.now();
const stages = {};
try {
  await backend.start();
  stages.backendReady = Date.now() - startedAt;
  const response = await backend.respond({
    conversationKey: "live-smoke:test",
    text: "只回复 APP_SERVER_OK，不要添加其他内容。",
    onProgress: (stage) => {
      stages[stage] = Date.now() - startedAt;
    },
  });
  process.stdout.write(
    `${JSON.stringify({ ok: response.trim() === "APP_SERVER_OK", response, stages, status: backend.status() })}\n`,
  );
} finally {
  await backend.stop();
  fs.rmSync(temporary, { recursive: true, force: true });
}
