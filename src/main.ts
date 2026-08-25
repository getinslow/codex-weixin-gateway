#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import QRCode from "qrcode";

import { CodexSdkBackend } from "./agent.js";
import { CodexAppServerBackend } from "./app-server-backend.js";
import { loadGatewayConfig } from "./config.js";
import { WeixinCodexGateway } from "./gateway.js";
import { HealthServer } from "./health.js";
import {
  clearStaleAccountsForUserId,
  listIndexedWeixinAccountIds,
  normalizeAccountId,
  registerWeixinAccountId,
  saveWeixinAccount,
} from "./weixin/auth/accounts.js";
import {
  DEFAULT_ILINK_BOT_TYPE,
  displayQRCode,
  startWeixinLoginWithQr,
  waitForWeixinLogin,
} from "./weixin/auth/login-qr.js";
import { clearContextTokensForAccount } from "./weixin/messaging/inbound.js";
import { logger, setLogLevel } from "./weixin/util/logger.js";

function configArgument(args: string[]): string | undefined {
  const index = args.indexOf("--config");
  return index >= 0 ? args[index + 1] : undefined;
}

async function login(args: string[]): Promise<void> {
  const config = loadGatewayConfig(configArgument(args));
  setLogLevel(config.logging.level);
  const started = await startWeixinLoginWithQr({
    apiBaseUrl: config.weixin.baseUrl,
    botType: DEFAULT_ILINK_BOT_TYPE,
    force: args.includes("--force"),
  });
  if (!started.qrcodeUrl) throw new Error(started.message);

  fs.mkdirSync(config.stateDir, { recursive: true });
  const qrImagePath = path.join(config.stateDir, "login-qr.png");
  await QRCode.toFile(qrImagePath, started.qrcodeUrl, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 480,
  });
  process.stdout.write("\n用手机微信扫描以下二维码并确认授权：\n\n");
  await displayQRCode(started.qrcodeUrl);
  process.stdout.write(`二维码图片：${qrImagePath}\n`);
  const result = await waitForWeixinLogin({
    sessionKey: started.sessionKey,
    apiBaseUrl: config.weixin.baseUrl,
    botType: DEFAULT_ILINK_BOT_TYPE,
    timeoutMs: 480_000,
  });

  if (result.alreadyConnected) {
    const existing = listIndexedWeixinAccountIds();
    if (existing.length === 0) {
      throw new Error("微信服务端显示已绑定，但本地没有凭证。请使用 --force 重新登录。");
    }
    process.stdout.write(`\n已有本地账号：${existing.join(", ")}\n`);
    return;
  }
  if (!result.connected || !result.accountId || !result.botToken) {
    throw new Error(result.message);
  }

  const accountId = normalizeAccountId(result.accountId);
  saveWeixinAccount(accountId, {
    token: result.botToken,
    baseUrl: result.baseUrl || config.weixin.baseUrl,
    userId: result.userId,
  });
  registerWeixinAccountId(accountId);
  if (result.userId) {
    clearStaleAccountsForUserId(accountId, result.userId, clearContextTokensForAccount);
  }
  process.stdout.write(`\n登录成功，账号 ID：${accountId}\n`);
  process.stdout.write("扫码者已自动加入允许名单。现在可以运行 npm run dev。\n");
}

async function serve(args: string[]): Promise<void> {
  const config = loadGatewayConfig(configArgument(args));
  setLogLevel(config.logging.level);
  const backend =
    config.codex.backend === "sdk"
      ? new CodexSdkBackend(config)
      : new CodexAppServerBackend(config);
  const gateway = new WeixinCodexGateway(config, backend);
  const health = new HealthServer(config.health.host, config.health.port, () => gateway.status());

  await health.start();
  logger.info(`health server listening http://${config.health.host}:${config.health.port}`);
  try {
    await gateway.start();
    const signal = new Promise<"signal">((resolve) => {
      process.once("SIGINT", () => resolve("signal"));
      process.once("SIGTERM", () => resolve("signal"));
    });
    const monitor = gateway.wait().then(() => "monitor" as const);
    const reason = await Promise.race([signal, monitor]);
    if (reason === "monitor") throw new Error("Weixin monitor stopped unexpectedly");
  } finally {
    await gateway.stop();
    await health.stop();
  }
}

function printHelp(): void {
  process.stdout.write(`
codex-weixin-gateway

Usage:
  codex-weixin-gateway login [--config gateway.json] [--force]
  codex-weixin-gateway serve [--config gateway.json]
  codex-weixin-gateway accounts [--config gateway.json]
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "help";
  if (command === "login") return login(args);
  if (command === "serve") return serve(args);
  if (command === "accounts") {
    loadGatewayConfig(configArgument(args));
    process.stdout.write(`${JSON.stringify(listIndexedWeixinAccountIds(), null, 2)}\n`);
    return;
  }
  printHelp();
  if (!new Set(["help", "--help", "-h"]).has(command)) process.exitCode = 1;
}

main().catch((error) => {
  logger.error(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
