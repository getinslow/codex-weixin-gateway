import crypto from "node:crypto";
import fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import path from "node:path";

import type { AgentArtifact, AgentBackend, AgentProgressStage } from "./agent.js";
import { validateGeneratedImagePath } from "./app-server-backend.js";
import type { GatewayConfig } from "./config.js";
import {
  InboxStore,
  MessageLedger,
  PendingReplyStore,
  type InboxEntry,
  type InboxLane,
  type InboxMedia,
} from "./json-store.js";
import { legacyMessageKeys, messageKey } from "./message-key.js";
import type { GatewayStatus } from "./health.js";
import { notifyStart, notifyStop, sendTyping } from "./weixin/api/api.js";
import { WeixinConfigManager } from "./weixin/api/config-cache.js";
import type { MessageItem, WeixinMessage } from "./weixin/api/types.js";
import { MessageItemType, MessageType, TypingStatus } from "./weixin/api/types.js";
import { loadWeixinAccount, resolveWeixinAccount } from "./weixin/auth/accounts.js";
import { downloadMediaFromItem } from "./weixin/media/media-download.js";
import {
  isMediaItem,
  restoreContextTokens,
  setContextToken,
  weixinMessageToMsgContext,
} from "./weixin/messaging/inbound.js";
import { sendWeixinMediaFile } from "./weixin/messaging/send-media.js";
import { sendMessageWeixin, StreamingMarkdownFilter } from "./weixin/messaging/send.js";
import { monitorWeixinProvider } from "./weixin/monitor/monitor.js";
import { logger } from "./weixin/util/logger.js";

export class WeixinCodexGateway {
  readonly #config: GatewayConfig;
  readonly #agent: AgentBackend;
  readonly #abort = new AbortController();
  readonly #ledger: MessageLedger;
  readonly #pendingReplies: PendingReplyStore;
  readonly #inbox: InboxStore;
  readonly #workers = new Map<string, Promise<void>>();
  readonly #status: GatewayStatus = { ready: false, queueDepth: 0, activeWorkers: 0 };
  #monitor?: Promise<void>;
  #account?: ReturnType<typeof resolveWeixinAccount>;
  #typingConfig?: WeixinConfigManager;
  #agentStarted = false;
  #notifiedStart = false;
  #lockFd?: number;
  #lockPath?: string;

  constructor(config: GatewayConfig, agent: AgentBackend) {
    this.#config = config;
    this.#agent = agent;
    this.#ledger = new MessageLedger(config.stateDir);
    this.#pendingReplies = new PendingReplyStore(config.stateDir);
    this.#inbox = new InboxStore(config.stateDir);
  }

  status(): GatewayStatus {
    return {
      ...this.#status,
      backend: this.#agent.name,
      queueDepth: this.#inbox.count(),
      activeWorkers: this.#workers.size,
      ...(this.#agent.status?.() ?? {}),
    };
  }

  async start(): Promise<void> {
    const account = resolveWeixinAccount({
      accountId: this.#config.weixin.accountId || undefined,
      baseUrl: this.#config.weixin.baseUrl,
      cdnBaseUrl: this.#config.weixin.cdnBaseUrl,
    });
    if (!account.configured || !account.token) {
      throw new Error(`Weixin account ${account.accountId} has no token. Run the login command.`);
    }
    this.#acquireProcessLock();
    this.#account = account;
    restoreContextTokens(account.accountId);
    this.#typingConfig = new WeixinConfigManager(
      { baseUrl: account.baseUrl, token: account.token },
      (message) => logger.withAccount(account.accountId).debug(message),
    );

    await this.#agent.start?.();
    this.#agentStarted = true;

    try {
      await notifyStart({ baseUrl: account.baseUrl, token: account.token });
    } catch (error) {
      logger.withAccount(account.accountId).warn(`notifyStart failed and was ignored: ${String(error)}`);
    }
    this.#notifiedStart = true;

    Object.assign(this.#status, {
      ready: true,
      backend: this.#agent.name,
      accountId: account.accountId,
      startedAt: Date.now(),
      queueDepth: this.#inbox.count(),
      lastError: undefined,
    });

    for (const pending of this.#inbox.conversationLanes()) {
      this.#wakeWorker(pending.conversationKey, pending.lane);
    }

    this.#monitor = monitorWeixinProvider({
      baseUrl: account.baseUrl,
      token: account.token,
      accountId: account.accountId,
      abortSignal: this.#abort.signal,
      longPollTimeoutMs: this.#config.weixin.longPollTimeoutMs,
      setStatus: (next) => Object.assign(this.#status, next),
      loadCursor: () => this.#inbox.cursor(account.accountId),
      commitBatch: (messages, nextCursor) => this.#commitBatch(messages, nextCursor),
    }).catch((error) => {
      this.#status.ready = false;
      this.#status.lastError = String(error);
      throw error;
    });
    logger
      .withAccount(account.accountId)
      .info(`gateway ready backend=${this.#agent.name} recovered=${this.#inbox.count()}`);
  }

  async wait(): Promise<void> {
    await this.#monitor;
  }

  async stop(): Promise<void> {
    this.#status.ready = false;
    this.#abort.abort();
    try {
      await this.#monitor;
    } catch (error) {
      if (!this.#abort.signal.aborted) throw error;
    }

    if (this.#agentStarted) {
      try {
        await this.#agent.stop?.();
      } catch (error) {
        logger.warn(`agent backend stop failed: ${String(error)}`);
      } finally {
        this.#agentStarted = false;
      }
    }

    await Promise.race([
      Promise.allSettled([...this.#workers.values()]),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);

    if (this.#account && this.#notifiedStart) {
      try {
        await notifyStop({
          baseUrl: this.#account.baseUrl,
          token: this.#account.token,
          timeoutMs: 10_000,
        });
      } catch (error) {
        logger.withAccount(this.#account.accountId).warn(`notifyStop failed: ${String(error)}`);
      }
      logger.withAccount(this.#account.accountId).info("gateway stopped");
    }
    this.#releaseProcessLock();
  }

  #acquireProcessLock(): void {
    const lockPath = path.join(this.#config.stateDir, "gateway.lock");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = fs.openSync(lockPath, "wx", 0o600);
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), "utf-8");
        this.#lockFd = fd;
        this.#lockPath = lockPath;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const owner = readLockOwner(lockPath);
        if (owner && processIsAlive(owner.pid)) {
          throw new Error(`another gateway process is using this stateDir (pid=${owner.pid})`);
        }
        try {
          fs.unlinkSync(lockPath);
        } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
        }
      }
    }
    throw new Error(`unable to acquire gateway process lock: ${lockPath}`);
  }

  #releaseProcessLock(): void {
    if (this.#lockFd !== undefined) {
      try {
        fs.closeSync(this.#lockFd);
      } catch {}
      this.#lockFd = undefined;
    }
    if (this.#lockPath) {
      try {
        fs.unlinkSync(this.#lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          logger.warn(`failed to remove gateway lock: ${String(error)}`);
        }
      }
      this.#lockPath = undefined;
    }
  }

  async #commitBatch(messages: WeixinMessage[], nextCursor: string): Promise<void> {
    const account = this.#account!;
    const now = Date.now();
    const entries: InboxEntry[] = [];

    for (const message of messages) {
      if (message.message_type === MessageType.BOT) continue;
      const sender = message.from_user_id?.trim();
      if (!sender) continue;

      const key = messageKey(account.accountId, message);
      if (
        this.#ledger.has(key) ||
        legacyMessageKeys(account.accountId, message).some((legacy) => this.#ledger.has(legacy))
      ) {
        this.#ledger.markProcessed(key);
        continue;
      }

      if (!this.#isAllowed(sender)) {
        logger.withAccount(account.accountId).warn(`unauthorized sender dropped sender=${sender}`);
        this.#ledger.markProcessed(key);
        continue;
      }

      const conversationKey = `${account.accountId}:${sender}`;
      const preview = weixinMessageToMsgContext(message, account.accountId);
      const mediaItem = findMessageMediaItem(message);
      const commandReply = mediaItem
        ? undefined
        : this.#agent.handleControlCommand({
            requestId: key,
            conversationKey,
            text: preview.Body,
          });
      const lane: InboxLane = commandReply === undefined ? "agent" : "command";
      if (commandReply !== undefined) this.#pendingReplies.set(key, commandReply);

      entries.push({
        messageKey: key,
        conversationKey,
        lane,
        message,
        enqueuedAt: now,
        availableAt: now,
        agentSettings:
          lane === "agent" ? this.#agent.snapshotSettings(conversationKey) : undefined,
      });
    }

    const added = this.#inbox.commitBatch(account.accountId, nextCursor, entries);
    for (const entry of entries) {
      const sender = entry.message.from_user_id!;
      if (entry.message.context_token) {
        setContextToken(account.accountId, sender, entry.message.context_token);
      }
      if (this.#inbox.has(entry.messageKey)) {
        this.#wakeWorker(entry.conversationKey, entry.lane);
      }
    }
    if (messages.length > 0) {
      Object.assign(this.#status, {
        lastInboundAt: now,
        lastEnqueuedAt: now,
        queueDepth: this.#inbox.count(),
        lastStage: "enqueued",
      });
      logger
        .withAccount(account.accountId)
        .info(`batch committed received=${messages.length} added=${added} queued=${this.#inbox.count()}`);
    }
  }

  #wakeWorker(conversationKey: string, lane: InboxLane): void {
    const workerKey = `${lane}\0${conversationKey}`;
    if (this.#workers.has(workerKey) || this.#abort.signal.aborted) return;
    let worker!: Promise<void>;
    worker = this.#runWorker(conversationKey, lane)
      .catch((error) => {
        if (!this.#abort.signal.aborted) {
          this.#status.lastError = String(error);
          logger.error(`queue worker failed lane=${lane} error=${String(error)}`);
        }
      })
      .finally(() => {
        if (this.#workers.get(workerKey) === worker) this.#workers.delete(workerKey);
        this.#status.activeWorkers = this.#workers.size;
        if (!this.#abort.signal.aborted && this.#inbox.first(conversationKey, lane)) {
          this.#wakeWorker(conversationKey, lane);
        }
      });
    this.#workers.set(workerKey, worker);
    this.#status.activeWorkers = this.#workers.size;
  }

  async #runWorker(conversationKey: string, lane: InboxLane): Promise<void> {
    while (!this.#abort.signal.aborted) {
      const entry = this.#inbox.first(conversationKey, lane);
      if (!entry) return;
      const waitMs = Math.max(0, entry.availableAt - Date.now());
      if (waitMs > 0 && !(await delay(waitMs, this.#abort.signal))) return;
      await this.#processEntry(entry);
    }
  }

  async #processEntry(entry: InboxEntry): Promise<void> {
    const account = this.#account!;
    const message = entry.message;
    const sender = message.from_user_id!;
    if (this.#ledger.has(entry.messageKey)) {
      this.#pendingReplies.delete(entry.messageKey);
      this.#inbox.remove(entry.messageKey);
      this.#status.queueDepth = this.#inbox.count();
      return;
    }

    const dequeuedAt = Date.now();
    Object.assign(this.#status, {
      lastDequeuedAt: dequeuedAt,
      lastQueueLatencyMs: dequeuedAt - entry.enqueuedAt,
      lastStage: entry.lane === "command" ? "command-dequeued" : "agent-dequeued",
    });
    this.#logStage(entry, "dequeued", dequeuedAt);

    const typingAbort = new AbortController();
    const typing =
      entry.lane === "agent"
        ? this.#startTypingHeartbeat(sender, message.context_token, typingAbort.signal)
        : Promise.resolve(async () => {});

    try {
      let media = entry.media;
      if (entry.lane === "agent" && (!media || !savedMediaExists(media))) {
        media = await this.#downloadMedia(message);
        this.#inbox.setMedia(entry.messageKey, media);
      }
      const context = weixinMessageToMsgContext(message, account.accountId, media);
      if (!context.Body.trim() && !context.MediaPath) {
        this.#completeEntry(entry.messageKey);
        return;
      }

      let delivery = this.#pendingReplies.getDelivery(entry.messageKey);
      if (!delivery) {
        let agentStartedAt: number | undefined;
        const artifacts: AgentArtifact[] = [];
        const response = await this.#agent.respond({
          requestId: entry.messageKey,
          conversationKey: entry.conversationKey,
          text: context.Body,
          mediaPath: context.MediaPath,
          mediaType: context.MediaType,
          settings: entry.agentSettings,
          onProgress: (stage) => {
            const at = Date.now();
            if (stage === "turn-started") agentStartedAt = at;
            this.#recordAgentStage(entry, stage, at, agentStartedAt);
          },
          onArtifact: (artifact) => {
            if (!artifacts.some((candidate) => candidate.path === artifact.path)) {
              artifacts.push(artifact);
              this.#status.lastArtifactDetectedAt = Date.now();
              this.#status.lastArtifactCount = artifacts.length;
              this.#logStage(entry, "artifact-detected", Date.now());
            }
          },
        });
        this.#pendingReplies.set(entry.messageKey, response, artifacts);
        delivery = this.#pendingReplies.getDelivery(entry.messageKey)!;
      }

      const filter = new StreamingMarkdownFilter();
      const text = filter.feed(delivery.text) + filter.flush();
      const chunks = splitText(text, 4_000);
      for (let index = 0; index < chunks.length; index += 1) {
        if (delivery.sentChunks.includes(index)) continue;
        await sendMessageWeixin({
          to: sender,
          text: chunks[index],
          clientId: outboundClientId(entry.messageKey, index, "reply"),
          opts: {
            baseUrl: account.baseUrl,
            token: account.token,
            contextToken: message.context_token,
            runId: outboundRunId(entry.messageKey),
          },
        });
        this.#pendingReplies.markChunkSent(entry.messageKey, index);
        delivery.sentChunks.push(index);
      }

      for (let index = 0; index < delivery.artifacts.length; index += 1) {
        const artifact = delivery.artifacts[index];
        if (artifact.sent) continue;
        const validatedImage =
          artifact.kind === "image"
            ? validateGeneratedImagePath(
                artifact.path,
                this.#config.stateDir,
                entry.agentSettings?.workingDirectory ?? this.#config.codex.workingDirectory,
              )
            : undefined;
        const artifactPath = validatedImage?.path ?? artifact.path;
        if (
          (artifact.kind === "image" &&
            (!validatedImage ||
              (artifact.mimeType !== undefined && artifact.mimeType !== validatedImage.mimeType))) ||
          !fs.existsSync(artifactPath) ||
          !fs.statSync(artifactPath).isFile()
        ) {
          throw new Error(`generated artifact is unavailable: ${artifact.path}`);
        }
        await sendWeixinMediaFile({
          filePath: artifactPath,
          to: sender,
          text: "",
          clientIds: {
            media: outboundClientId(entry.messageKey, index, "artifact"),
          },
          opts: {
            baseUrl: account.baseUrl,
            token: account.token,
            contextToken: message.context_token,
            runId: outboundRunId(entry.messageKey),
          },
          cdnBaseUrl: account.cdnBaseUrl,
        });
        this.#pendingReplies.markArtifactSent(entry.messageKey, index);
        artifact.sent = true;
        this.#status.lastArtifactSentAt = Date.now();
        this.#logStage(entry, "artifact-sent", Date.now());
      }

      this.#completeEntry(entry.messageKey);
      this.#pendingReplies.delete(entry.messageKey);
      const outboundAt = Date.now();
      Object.assign(this.#status, {
        lastOutboundAt: outboundAt,
        lastEndToEndMs: outboundAt - entry.enqueuedAt,
        lastStage: "sent",
        lastError: undefined,
      });
      this.#logStage(entry, "sent", outboundAt);
    } catch (error) {
      if (this.#abort.signal.aborted) return;
      this.#status.lastError = String(error);
      const terminal = this.#ledger.recordFailure(
        entry.messageKey,
        error,
        this.#config.weixin.maxMessageRetries,
        sanitizeMessageForDeadLetter(message),
      );
      const failures = this.#ledger.failureCount(entry.messageKey);
      this.#status.retryCount = Number(this.#status.retryCount ?? 0) + 1;
      if (terminal) {
        this.#pendingReplies.delete(entry.messageKey);
        this.#inbox.remove(entry.messageKey);
        this.#status.queueDepth = this.#inbox.count();
        logger.withAccount(account.accountId).error(`message dead-lettered key=${entry.messageKey}`);
        if (this.#config.weixin.replyOnError) {
          try {
            await sendMessageWeixin({
              to: sender,
              text: "这条消息暂时处理失败，已记录供排查，请稍后再试。",
              clientId: outboundClientId(entry.messageKey, 0, "error"),
              opts: {
                baseUrl: account.baseUrl,
                token: account.token,
                contextToken: message.context_token,
                runId: outboundRunId(entry.messageKey),
              },
            });
          } catch (sendError) {
            logger.error(`failed to send terminal error notice: ${String(sendError)}`);
          }
        }
        return;
      }
      const delayMs = Math.min(30_000, 2_000 * 2 ** Math.max(0, failures - 1));
      this.#inbox.defer(entry.messageKey, Date.now() + delayMs);
      logger.warn(
        `message retry scheduled key=${entry.messageKey} attempt=${failures} delayMs=${delayMs}`,
      );
    } finally {
      typingAbort.abort();
      try {
        const stopTyping = await typing;
        await stopTyping();
      } catch (error) {
        logger.withAccount(account.accountId).debug(`typing cleanup ignored: ${String(error)}`);
      }
    }
  }

  #completeEntry(messageKeyValue: string): void {
    this.#ledger.markProcessed(messageKeyValue);
    this.#inbox.remove(messageKeyValue);
    this.#status.queueDepth = this.#inbox.count();
  }

  #recordAgentStage(
    entry: InboxEntry,
    stage: AgentProgressStage,
    at: number,
    agentStartedAt?: number,
  ): void {
    if (stage === "thread-ready") this.#status.lastThreadReadyAt = at;
    if (stage === "turn-started") this.#status.lastAgentStartedAt = at;
    if (stage === "first-delta") this.#status.lastFirstDeltaAt = at;
    if (stage === "completed") {
      this.#status.lastAgentCompletedAt = at;
      const started = agentStartedAt ?? this.#status.lastAgentStartedAt;
      if (typeof started === "number") this.#status.lastAgentDurationMs = at - started;
    }
    this.#status.lastStage = stage;
    this.#logStage(entry, stage, at);
  }

  #logStage(entry: InboxEntry, stage: string, at: number): void {
    logger.info(
      `message stage key=${shortKey(entry.messageKey)} stage=${stage} elapsedMs=${at - entry.enqueuedAt} queued=${this.#inbox.count()}`,
    );
  }

  #isAllowed(sender: string): boolean {
    if (this.#config.weixin.allowAllUsers) return true;
    const configured = this.#config.weixin.allowedUserIds;
    const scanner = this.#account ? loadWeixinAccount(this.#account.accountId)?.userId : undefined;
    return configured.includes(sender) || scanner === sender;
  }

  async #startTypingHeartbeat(
    sender: string,
    contextToken: string | undefined,
    abortSignal: AbortSignal,
  ): Promise<() => Promise<void>> {
    const account = this.#account!;
    try {
      const cached = await this.#typingConfig!.getForUser(sender, contextToken);
      const ticket = cached.typingTicket;
      if (!ticket || abortSignal.aborted) return async () => {};

      const update = async (status: number): Promise<void> => {
        try {
          await sendTyping({
            baseUrl: account.baseUrl,
            token: account.token,
            body: { ilink_user_id: sender, typing_ticket: ticket, status },
          });
        } catch (error) {
          logger.withAccount(account.accountId).debug(`typing update ignored: ${String(error)}`);
        }
      };

      await update(TypingStatus.TYPING);
      let stopped = false;
      let refresh: Promise<void> | undefined;
      const timer = setInterval(() => {
        if (stopped || refresh || abortSignal.aborted) return;
        refresh = update(TypingStatus.TYPING).finally(() => {
          refresh = undefined;
        });
      }, this.#config.weixin.typingKeepaliveMs);
      timer.unref();

      return async () => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        await refresh;
        await update(TypingStatus.CANCEL);
      };
    } catch (error) {
      logger.withAccount(account.accountId).debug(`typing ticket lookup ignored: ${String(error)}`);
      return async () => {};
    }
  }

  async #downloadMedia(message: WeixinMessage): Promise<InboxMedia> {
    const item = findMessageMediaItem(message);
    if (!item) return {};
    const referenced = !findDownloadableMedia(message.item_list);
    return downloadMediaFromItem(item, {
      cdnBaseUrl: this.#account!.cdnBaseUrl,
      saveMedia: (buffer, contentType, subdir, maxBytes, originalFilename) =>
        this.#saveMedia(buffer, contentType, subdir, maxBytes, originalFilename),
      log: (messageText) => logger.withAccount(this.#account!.accountId).debug(messageText),
      errLog: (messageText) => logger.withAccount(this.#account!.accountId).error(messageText),
      label: referenced ? "referenced" : "inbound",
    });
  }

  async #saveMedia(
    buffer: Buffer,
    contentType = "application/octet-stream",
    subdir = "inbound",
    maxBytes = 100 * 1024 * 1024,
    originalFilename?: string,
  ): Promise<{ path: string }> {
    if (buffer.length > maxBytes) throw new Error(`media exceeds ${maxBytes} byte limit`);
    const directory = path.join(this.#config.stateDir, "media", subdir);
    await fsPromises.mkdir(directory, { recursive: true });
    const original = originalFilename ? path.basename(originalFilename) : "";
    const suffix = original || `attachment${extensionForContentType(contentType)}`;
    const filePath = path.join(directory, `${crypto.randomUUID()}-${suffix}`);
    await fsPromises.writeFile(filePath, buffer);
    return { path: filePath };
  }
}

function findMessageMediaItem(message: WeixinMessage): MessageItem | undefined {
  const main = findDownloadableMedia(message.item_list);
  if (main) return main;
  return message.item_list?.find(
    (item) =>
      item.type === MessageItemType.TEXT &&
      item.ref_msg?.message_item &&
      isMediaItem(item.ref_msg.message_item),
  )?.ref_msg?.message_item;
}

function findDownloadableMedia(items?: MessageItem[]): MessageItem | undefined {
  const hasMedia = (media?: { encrypt_query_param?: string; full_url?: string }) =>
    Boolean(media?.encrypt_query_param || media?.full_url);
  return (
    items?.find((item) => item.type === MessageItemType.IMAGE && hasMedia(item.image_item?.media)) ??
    items?.find((item) => item.type === MessageItemType.VIDEO && hasMedia(item.video_item?.media)) ??
    items?.find((item) => item.type === MessageItemType.FILE && hasMedia(item.file_item?.media)) ??
    items?.find(
      (item) =>
        item.type === MessageItemType.VOICE &&
        hasMedia(item.voice_item?.media) &&
        !item.voice_item?.text,
    )
  );
}

function savedMediaExists(media: InboxMedia): boolean {
  const paths = [
    media.decryptedPicPath,
    media.decryptedVoicePath,
    media.decryptedFilePath,
    media.decryptedVideoPath,
  ].filter((value): value is string => Boolean(value));
  return paths.length === 0 || paths.every((filePath) => fs.existsSync(filePath));
}

function extensionForContentType(contentType: string): string {
  if (contentType.startsWith("image/")) return `.${contentType.slice(6).replace("jpeg", "jpg")}`;
  if (contentType === "audio/wav") return ".wav";
  if (contentType === "audio/silk") return ".silk";
  if (contentType === "video/mp4") return ".mp4";
  return ".bin";
}

function splitText(text: string, limit: number): string[] {
  const characters = Array.from(text);
  if (characters.length === 0) return [""];
  const chunks: string[] = [];
  for (let index = 0; index < characters.length; index += limit) {
    chunks.push(characters.slice(index, index + limit).join(""));
  }
  return chunks;
}

function outboundClientId(messageKeyValue: string, index: number, kind: string): string {
  const digest = crypto
    .createHash("sha256")
    .update(`${messageKeyValue}\0${kind}\0${index}`)
    .digest("hex")
    .slice(0, 24);
  return `codex-weixin:${digest}`;
}

function outboundRunId(messageKeyValue: string): string {
  const digest = crypto.createHash("sha256").update(messageKeyValue).digest("hex").slice(0, 24);
  return `codex-weixin:${digest}`;
}

function shortKey(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function sanitizeMessageForDeadLetter(message: WeixinMessage): unknown {
  return {
    ...message,
    context_token: message.context_token ? "<redacted>" : undefined,
    item_list: message.item_list?.map((item) => ({
      ...item,
      image_item: item.image_item ? { ...item.image_item, media: "<redacted>" } : undefined,
      voice_item: item.voice_item ? { ...item.voice_item, media: "<redacted>" } : undefined,
      file_item: item.file_item ? { ...item.file_item, media: "<redacted>" } : undefined,
      video_item: item.video_item ? { ...item.video_item, media: "<redacted>" } : undefined,
    })),
  };
}

function delay(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function readLockOwner(lockPath: string): { pid: number } | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as { pid?: unknown };
    return typeof value.pid === "number" && Number.isInteger(value.pid)
      ? { pid: value.pid }
      : undefined;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
