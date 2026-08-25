import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

const WeixinSchema = z.object({
  accountId: z.string().default(""),
  baseUrl: z.url().default("https://ilinkai.weixin.qq.com"),
  cdnBaseUrl: z.url().default("https://novac2c.cdn.weixin.qq.com/c2c"),
  routeTag: z.union([z.string(), z.number()]).optional(),
  botAgent: z.string().default("CodexWeixinGateway/0.4.0"),
  allowAllUsers: z.boolean().default(false),
  allowedUserIds: z.array(z.string().min(1)).default([]),
  replyOnError: z.boolean().default(true),
  longPollTimeoutMs: z.number().int().positive().default(35_000),
  typingKeepaliveMs: z.number().int().min(1_000).max(60_000).default(5_000),
  maxMessageRetries: z.number().int().min(1).max(20).default(3),
});

const CodexSchema = z.object({
  backend: z.enum(["app-server", "sdk"]).default("app-server"),
  workingDirectory: z.string().default("."),
  codexPath: z.string().optional(),
  model: z.string().min(1).default("gpt-5.6-sol"),
  serviceTier: z.enum(["default", "priority"]).default("default"),
  switchableModels: z
    .array(z.string().min(1))
    .default(["gpt-5.6-sol", "gpt-5.6-terra"]),
  sandboxMode: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("read-only"),
  approvalPolicy: z.enum(["never", "on-request", "on-failure", "untrusted"]).default("never"),
  modelReasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).default("low"),
  networkAccessEnabled: z.boolean().default(false),
  turnTimeoutMs: z.number().int().positive().default(600_000),
  appServerStartupTimeoutMs: z.number().int().positive().default(30_000),
  additionalDirectories: z.array(z.string()).default([]),
  projectRoots: z.array(z.string()).default([]),
  promptPrefix: z.string().default(
    "你正在微信中回复用户。回答应直接、简洁，不要声称已经发送尚未发送的文件。",
  ),
});

const HealthSchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(0).max(65_535).default(8787),
});

const LoggingSchema = z.object({
  level: z.enum(["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"]).default("INFO"),
  console: z.boolean().default(true),
});

const GatewaySchema = z.object({
  stateDir: z.string().default(path.join(os.homedir(), ".codex-weixin-gateway")),
  weixin: WeixinSchema.default({
    accountId: "",
    baseUrl: "https://ilinkai.weixin.qq.com",
    cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
    botAgent: "CodexWeixinGateway/0.4.0",
    allowAllUsers: false,
    allowedUserIds: [],
    replyOnError: true,
    longPollTimeoutMs: 35_000,
    typingKeepaliveMs: 5_000,
    maxMessageRetries: 3,
  }),
  codex: CodexSchema.default({
    backend: "app-server",
    workingDirectory: ".",
    model: "gpt-5.6-sol",
    serviceTier: "default",
    switchableModels: ["gpt-5.6-sol", "gpt-5.6-terra"],
    sandboxMode: "read-only",
    approvalPolicy: "never",
    modelReasoningEffort: "low",
    networkAccessEnabled: false,
    turnTimeoutMs: 600_000,
    appServerStartupTimeoutMs: 30_000,
    additionalDirectories: [],
    projectRoots: [],
    promptPrefix: "你正在微信中回复用户。回答应直接、简洁，不要声称已经发送尚未发送的文件。",
  }),
  health: HealthSchema.default({ host: "127.0.0.1", port: 8787 }),
  logging: LoggingSchema.default({ level: "INFO", console: true }),
});

export type GatewayConfig = z.infer<typeof GatewaySchema>;

function absoluteFrom(baseDir: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

function existingDirectory(baseDir: string, value: string, label: string): string {
  const resolved = absoluteFrom(baseDir, value);
  try {
    const canonical = fs.realpathSync.native(resolved);
    if (!fs.statSync(canonical).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch {
    throw new Error(`${label} is unavailable or is not a directory: ${resolved}`);
  }
}

export function loadGatewayConfig(configArg?: string): GatewayConfig {
  const configPath = path.resolve(
    configArg || process.env.CODEX_WEIXIN_CONFIG || path.join(process.cwd(), "gateway.json"),
  );
  const configDir = path.dirname(configPath);
  let raw: unknown = {};
  if (fs.existsSync(configPath)) {
    raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  }

  const parsed = GatewaySchema.parse(raw);
  const workingDirectory = existingDirectory(
    configDir,
    parsed.codex.workingDirectory,
    "codex.workingDirectory",
  );
  const projectRoots = (
    parsed.codex.projectRoots.length > 0 ? parsed.codex.projectRoots : [workingDirectory]
  ).map((entry, index) =>
    existingDirectory(configDir, entry, `codex.projectRoots[${index}]`),
  );
  const config: GatewayConfig = {
    ...parsed,
    stateDir: absoluteFrom(configDir, parsed.stateDir),
    codex: {
      ...parsed.codex,
      workingDirectory,
      codexPath: parsed.codex.codexPath
        ? absoluteFrom(configDir, parsed.codex.codexPath)
        : undefined,
      additionalDirectories: parsed.codex.additionalDirectories.map((entry) =>
        absoluteFrom(configDir, entry),
      ),
      projectRoots,
    },
  };

  process.env.CODEX_WEIXIN_STATE_DIR = config.stateDir;
  process.env.CODEX_WEIXIN_LOG_LEVEL = config.logging.level;
  process.env.CODEX_WEIXIN_LOG_CONSOLE = String(config.logging.console);
  process.env.WEIXIN_BOT_AGENT = config.weixin.botAgent;
  if (config.weixin.routeTag !== undefined) {
    process.env.WEIXIN_ROUTE_TAG = String(config.weixin.routeTag);
  }
  return config;
}
