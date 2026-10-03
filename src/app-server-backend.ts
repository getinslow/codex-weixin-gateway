import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ConversationAgentSupport,
  type AgentBackend,
  type AgentArtifact,
  type AgentRequest,
} from "./agent.js";
import { AppServerClient, type AppServerMessage } from "./app-server-client.js";
import type { GatewayConfig } from "./config.js";
import { ThreadStore } from "./json-store.js";
import { logger } from "./weixin/util/logger.js";

type TurnCollector = {
  threadId: string;
  workingDirectory: string;
  turnId?: string;
  finalText?: string;
  fallbackText?: string;
  deltaText: string;
  sawDelta: boolean;
  artifactPaths: Set<string>;
  terminalError?: string;
};

export class CodexAppServerBackend implements AgentBackend {
  readonly name = "app-server";
  readonly #config: GatewayConfig;
  readonly #client: AppServerClient;
  readonly #threads: ThreadStore;
  readonly #support: ConversationAgentSupport;
  readonly #loadedThreads = new Map<string, string>();
  #observedGeneration = 0;
  #warnedOnFailureApproval = false;

  constructor(config: GatewayConfig) {
    this.#config = config;
    this.#client = new AppServerClient({
      codexPath: config.codex.codexPath,
      startupTimeoutMs: config.codex.appServerStartupTimeoutMs,
    });
    this.#threads = new ThreadStore(config.stateDir);
    this.#support = new ConversationAgentSupport(config, this.name);
  }

  async start(): Promise<void> {
    await this.#client.start();
    this.#syncGeneration();
  }

  async stop(): Promise<void> {
    this.#loadedThreads.clear();
    await this.#client.stop();
  }

  status(): Record<string, unknown> {
    const status = this.#client.status();
    return {
      backend: this.name,
      appServerReady: status.ready,
      appServerPid: status.pid,
      appServerGeneration: status.generation,
      appServerRestarts: status.restarts,
      lastAppServerStartedAt: status.lastStartedAt,
      lastAppServerExitAt: status.lastExitAt,
      loadedThreads: this.#loadedThreads.size,
    };
  }

  handleControlCommand(request: AgentRequest): string | undefined {
    if (request.mediaPath) return undefined;
    return this.#support.handleControlCommand(request.conversationKey, request.text);
  }

  snapshotSettings(conversationKey: string) {
    return this.#support.settings(conversationKey);
  }

  async respond(request: AgentRequest): Promise<string> {
    // Frozen settings mean the gateway has already handled the control part at intake.
    const commandResponse = request.settings ? undefined : this.handleControlCommand(request);
    if (commandResponse !== undefined) return commandResponse;

    await this.#client.start();
    this.#syncGeneration();
    const settings = this.#support.resolveSettings(request.conversationKey, request.settings);
    const threadKey = this.#support.threadKey(
      request.conversationKey,
      settings.workingDirectory,
    );
    const threadId = await this.#ensureThread(
      threadKey,
      settings.model,
      settings.serviceTier,
      settings.workingDirectory,
    );
    request.onProgress?.("thread-ready");

    const input: Array<Record<string, unknown>> = [
      { type: "text", text: this.#support.prompt(request, settings), text_elements: [] },
    ];
    if (request.mediaPath && request.mediaType?.startsWith("image/")) {
      input.push({ type: "localImage", path: request.mediaPath });
    }

    return this.#runTurn(request, threadId, settings.workingDirectory, {
      threadId,
      clientUserMessageId: request.requestId,
      input,
      cwd: settings.workingDirectory,
      approvalPolicy: this.#approvalPolicy(),
      sandboxPolicy: this.#sandboxPolicy(settings.workingDirectory),
      model: settings.model,
      serviceTier: settings.serviceTier,
      effort: settings.modelReasoningEffort,
    });
  }

  #syncGeneration(): void {
    const generation = this.#client.status().generation;
    if (generation !== this.#observedGeneration) {
      this.#loadedThreads.clear();
      this.#observedGeneration = generation;
    }
  }

  async #ensureThread(
    threadKey: string,
    model: string,
    serviceTier: "default" | "priority",
    workingDirectory: string,
  ): Promise<string> {
    const loaded = this.#loadedThreads.get(threadKey);
    if (loaded) return loaded;

    const common = {
      model,
      serviceTier,
      cwd: workingDirectory,
      approvalPolicy: this.#approvalPolicy(),
      sandbox: this.#config.codex.sandboxMode,
    };
    const existing = this.#threads.get(threadKey);
    if (existing) {
      try {
        const resumed = await this.#client.request(
          "thread/resume",
          { threadId: existing, ...common },
          Math.max(60_000, this.#config.codex.appServerStartupTimeoutMs),
        );
        const threadId = String(resumed.thread.id);
        this.#loadedThreads.set(threadKey, threadId);
        return threadId;
      } catch (error) {
        if (!isMissingThreadError(error)) throw error;
        logger.warn(
          `stored Codex thread is unavailable; starting a new one scope=${threadKey}`,
        );
        this.#threads.delete(threadKey);
      }
    }

    const started = await this.#client.request(
      "thread/start",
      { ...common, serviceName: "codex_weixin_gateway" },
      Math.max(60_000, this.#config.codex.appServerStartupTimeoutMs),
    );
    const threadId = String(started.thread.id);
    this.#threads.set(threadKey, threadId);
    this.#loadedThreads.set(threadKey, threadId);
    return threadId;
  }

  async #runTurn(
    request: AgentRequest,
    threadId: string,
    workingDirectory: string,
    params: Record<string, unknown>,
  ): Promise<string> {
    const collector: TurnCollector = {
      threadId,
      workingDirectory,
      deltaText: "",
      sawDelta: false,
      artifactPaths: new Set(),
    };
    let resolveCompletion!: () => void;
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const unsubscribe = this.#client.onNotification((event) => {
      this.#handleTurnEvent(
        event,
        collector,
        request,
        resolveCompletion,
        rejectCompletion,
      );
    });

    let timeout: NodeJS.Timeout | undefined;
    try {
      const started = await this.#client.request("turn/start", params, 60_000);
      collector.turnId = String(started.turn.id);
      request.onProgress?.("turn-started");
      timeout = setTimeout(() => {
        const turnId = collector.turnId;
        if (turnId) {
          void this.#client
            .request("turn/interrupt", { threadId, turnId }, 10_000)
            .catch(() => {});
        }
        rejectCompletion(
          new Error(`Codex turn timed out after ${this.#config.codex.turnTimeoutMs}ms`),
        );
      }, this.#config.codex.turnTimeoutMs);
      timeout.unref();
      await completion;

      const response = (collector.finalText ?? collector.fallbackText ?? collector.deltaText).trim();
      if (!response && collector.artifactPaths.size === 0) {
        throw new Error("Codex app-server returned an empty response");
      }
      request.onProgress?.("completed");
      return response || "图片已生成。";
    } catch (error) {
      logger.error(
        `Codex app-server turn failed conversation=${request.conversationKey} error=${String(error)}`,
      );
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      unsubscribe();
    }
  }

  #handleTurnEvent(
    event: AppServerMessage,
    collector: TurnCollector,
    request: AgentRequest,
    resolve: () => void,
    reject: (error: Error) => void,
  ): void {
    if (event.method === "client/disconnected") {
      reject(new Error(String(event.params?.error ?? "Codex app-server disconnected")));
      return;
    }
    const params = event.params ?? {};
    if (params.threadId !== collector.threadId) return;
    const eventTurnId = params.turnId ?? params.turn?.id;
    if (collector.turnId && eventTurnId && eventTurnId !== collector.turnId) return;
    if (!collector.turnId && eventTurnId) collector.turnId = String(eventTurnId);

    if (event.method === "item/agentMessage/delta") {
      collector.deltaText += String(params.delta ?? "");
      if (!collector.sawDelta) {
        collector.sawDelta = true;
        request.onProgress?.("first-delta");
      }
      return;
    }

    if (event.method === "item/completed") {
      const item = params.item;
      if (item?.type === "agentMessage" && typeof item.text === "string") {
        if (item.phase === "final_answer") collector.finalText = item.text;
        else if (item.phase == null) collector.fallbackText = item.text;
      }
      this.#captureArtifact(item, collector, request);
      return;
    }

    if (event.method === "error") {
      if (!params.willRetry) {
        collector.terminalError = String(params.error?.message ?? "Codex turn failed");
      }
      return;
    }

    if (event.method !== "turn/completed") return;
    for (const item of params.turn?.items ?? []) {
      if (item?.type === "agentMessage" && typeof item.text === "string") {
        if (item.phase === "final_answer") collector.finalText = item.text;
        else if (item.phase == null) collector.fallbackText = item.text;
      }
      this.#captureArtifact(item, collector, request);
    }
    const status = params.turn?.status;
    if (status === "completed") {
      resolve();
      return;
    }
    const message =
      params.turn?.error?.message ??
      collector.terminalError ??
      `Codex turn ended with status ${String(status)}`;
    reject(new Error(String(message)));
  }

  #captureArtifact(
    item: Record<string, unknown> | undefined,
    collector: TurnCollector,
    request: AgentRequest,
  ): void {
    if (item?.type !== "imageGeneration" || item.failure) return;
    const artifact = imageGenerationArtifact(
      item,
      this.#config.stateDir,
      collector.workingDirectory,
    );
    if (!artifact || collector.artifactPaths.has(artifact.path)) return;
    collector.artifactPaths.add(artifact.path);
    request.onArtifact?.(artifact);
  }

  #workspaceRoots(workingDirectory: string): string[] {
    return Array.from(
      new Set([
        workingDirectory,
        path.join(this.#config.stateDir, "media"),
        ...this.#config.codex.additionalDirectories,
      ]),
    );
  }

  #approvalPolicy(): "untrusted" | "on-request" | "never" {
    const policy = this.#config.codex.approvalPolicy;
    if (policy === "on-failure") {
      if (!this.#warnedOnFailureApproval) {
        this.#warnedOnFailureApproval = true;
        logger.warn("approvalPolicy=on-failure is not supported by App Server; using on-request");
      }
      return "on-request";
    }
    return policy;
  }

  #sandboxPolicy(workingDirectory: string): Record<string, unknown> {
    const mode = this.#config.codex.sandboxMode;
    if (mode === "danger-full-access") return { type: "dangerFullAccess" };
    if (mode === "read-only") {
      return { type: "readOnly", networkAccess: this.#config.codex.networkAccessEnabled };
    }
    return {
      type: "workspaceWrite",
      writableRoots: this.#workspaceRoots(workingDirectory),
      networkAccess: this.#config.codex.networkAccessEnabled,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }
}

function isMissingThreadError(error: unknown): boolean {
  return /thread|rollout/i.test(String(error)) && /not found|missing|does not exist/i.test(String(error));
}

const MAX_GENERATED_IMAGE_BYTES = 100 * 1024 * 1024;
const MAX_GENERATED_IMAGE_BASE64_CHARS = Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4;

export function imageGenerationArtifact(
  item: Record<string, unknown>,
  stateDir: string,
  workingDirectory: string,
): AgentArtifact | undefined {
  const savedPath =
    typeof item.savedPath === "string"
      ? path.resolve(workingDirectory, item.savedPath)
      : undefined;
  if (savedPath) {
    const validated = validateGeneratedImagePath(savedPath, stateDir, workingDirectory);
    if (validated) return { kind: "image", ...validated };
  }

  if (typeof item.result !== "string") return undefined;
  const decoded = decodeImageResult(item.result);
  if (!decoded) return undefined;
  try {
    const directory = path.join(stateDir, "media", "generated");
    fs.mkdirSync(directory, { recursive: true });
    const itemId =
      String(item.id ?? "generated-image").replace(/[^a-zA-Z0-9._-]/g, "_") ||
      "generated-image";
    const contentHash = crypto.createHash("sha256").update(decoded.buffer).digest("hex");
    const target = path.join(
      directory,
      `${itemId}-${contentHash}${extensionForImageMime(decoded.mimeType)}`,
    );
    if (isRegularFile(target)) {
      if (!fileMatchesSha256(target, decoded.buffer.length, contentHash)) return undefined;
    } else {
      const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, decoded.buffer, { flag: "wx" });
        try {
          fs.renameSync(temporary, target);
        } catch (error) {
          if (!fileMatchesSha256(target, decoded.buffer.length, contentHash)) throw error;
        }
      } finally {
        try {
          fs.unlinkSync(temporary);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    const validated = validateGeneratedImagePath(target, stateDir, workingDirectory);
    if (!validated || validated.mimeType !== decoded.mimeType) return undefined;
    return { kind: "image", ...validated };
  } catch {
    return undefined;
  }
}

function decodeImageResult(value: string): { buffer: Buffer; mimeType: string } | undefined {
  const dataUrl = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(value);
  const encoded = dataUrl?.[2] ?? value;
  if (!/^[a-zA-Z0-9+/=\r\n\t ]+$/.test(encoded)) return undefined;
  const compact = encoded.replace(/[\r\n\t ]/g, "");
  if (
    compact.length < 4 ||
    compact.length > MAX_GENERATED_IMAGE_BASE64_CHARS ||
    compact.length % 4 !== 0 ||
    !/^(?:[a-zA-Z0-9+/]{4})*(?:[a-zA-Z0-9+/]{2}==|[a-zA-Z0-9+/]{3}=)?$/.test(
      compact,
    )
  ) {
    return undefined;
  }
  try {
    const buffer = Buffer.from(compact, "base64");
    if (buffer.length <= 0 || buffer.length > MAX_GENERATED_IMAGE_BYTES) return undefined;
    const mimeType = sniffImageMime(buffer);
    if (!mimeType) return undefined;
    if (dataUrl && normalizeImageMime(dataUrl[1]) !== mimeType) return undefined;
    return { buffer, mimeType };
  } catch {
    return undefined;
  }
}

function normalizeImageMime(mimeType: string): string | undefined {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/png") return normalized;
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "image/jpeg";
  if (normalized === "image/webp") return normalized;
  return undefined;
}

function sniffImageMime(buffer: Buffer): string | undefined {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return undefined;
}

function imageMimeFromPath(filePath: string): string | undefined {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  return undefined;
}

export function validateGeneratedImagePath(
  filePath: string,
  stateDir: string,
  workingDirectory: string,
): { path: string; mimeType: string } | undefined {
  try {
    const realPath = fs.realpathSync.native(filePath);
    const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
    const allowedRoots = [
      workingDirectory,
      path.join(stateDir, "media", "generated"),
      path.join(codexHome, "generated_images"),
    ].map((root) => canonicalPath(root));
    if (!allowedRoots.some((root) => pathIsWithin(realPath, root))) return undefined;

    const stat = fs.statSync(realPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_GENERATED_IMAGE_BYTES) return undefined;
    const file = fs.openSync(realPath, "r");
    try {
      const header = Buffer.alloc(12);
      fs.readSync(file, header, 0, header.length, 0);
      const mimeType = sniffImageMime(header);
      if (!mimeType || imageMimeFromPath(realPath) !== mimeType) return undefined;
      return { path: realPath, mimeType };
    } finally {
      fs.closeSync(file);
    }
  } catch {
    return undefined;
  }
}

function pathIsWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function extensionForImageMime(mimeType: string): string {
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  return ".png";
}

function isRegularFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function fileMatchesSha256(filePath: string, expectedSize: number, expectedHash: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size !== expectedSize || stat.size > MAX_GENERATED_IMAGE_BYTES) {
      return false;
    }
    return (
      crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex") === expectedHash
    );
  } catch {
    return false;
  }
}
