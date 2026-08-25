import fs from "node:fs";
import path from "node:path";

import type { WeixinMessage } from "./weixin/api/types.js";

export function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonFileAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf-8");
  fs.renameSync(temporary, filePath);
}

type ThreadState = { threads: Record<string, string> };

export class ThreadStore {
  readonly #filePath: string;

  constructor(stateDir: string) {
    this.#filePath = path.join(stateDir, "threads.json");
  }

  get(conversationKey: string): string | undefined {
    return readJsonFile<ThreadState>(this.#filePath, { threads: {} }).threads[conversationKey];
  }

  set(conversationKey: string, threadId: string): void {
    const state = readJsonFile<ThreadState>(this.#filePath, { threads: {} });
    state.threads[conversationKey] = threadId;
    writeJsonFileAtomic(this.#filePath, state);
  }

  delete(conversationKey: string): void {
    const state = readJsonFile<ThreadState>(this.#filePath, { threads: {} });
    delete state.threads[conversationKey];
    writeJsonFileAtomic(this.#filePath, state);
  }
}

export type ModelReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export type ServiceTier = "default" | "priority";

export type ConversationSettings = {
  model?: string;
  modelReasoningEffort?: ModelReasoningEffort;
  serviceTier?: ServiceTier;
  projectPath?: string;
  updatedAt?: string;
};

type ConversationSettingsState = {
  settings: Record<string, ConversationSettings>;
};

export class ConversationSettingsStore {
  readonly #filePath: string;

  constructor(stateDir: string) {
    this.#filePath = path.join(stateDir, "conversation-settings.json");
  }

  get(conversationKey: string): ConversationSettings {
    const state = readJsonFile<ConversationSettingsState>(this.#filePath, { settings: {} });
    return { ...(state.settings[conversationKey] ?? {}) };
  }

  setModel(conversationKey: string, model?: string): void {
    this.#update(conversationKey, (settings) => {
      if (model) settings.model = model;
      else delete settings.model;
    });
  }

  setReasoningEffort(conversationKey: string, effort?: ModelReasoningEffort): void {
    this.#update(conversationKey, (settings) => {
      if (effort) settings.modelReasoningEffort = effort;
      else delete settings.modelReasoningEffort;
    });
  }

  setServiceTier(conversationKey: string, serviceTier?: ServiceTier): void {
    this.#update(conversationKey, (settings) => {
      if (serviceTier) settings.serviceTier = serviceTier;
      else delete settings.serviceTier;
    });
  }

  setProject(conversationKey: string, projectPath?: string): void {
    this.#update(conversationKey, (settings) => {
      if (projectPath) settings.projectPath = projectPath;
      else delete settings.projectPath;
    });
  }

  clear(conversationKey: string): void {
    const state = readJsonFile<ConversationSettingsState>(this.#filePath, { settings: {} });
    delete state.settings[conversationKey];
    writeJsonFileAtomic(this.#filePath, state);
  }

  #update(conversationKey: string, mutate: (settings: ConversationSettings) => void): void {
    const state = readJsonFile<ConversationSettingsState>(this.#filePath, { settings: {} });
    const settings = { ...(state.settings[conversationKey] ?? {}) };
    mutate(settings);
    if (
      !settings.model &&
      !settings.modelReasoningEffort &&
      !settings.serviceTier &&
      !settings.projectPath
    ) {
      delete state.settings[conversationKey];
    } else {
      settings.updatedAt = new Date().toISOString();
      state.settings[conversationKey] = settings;
    }
    writeJsonFileAtomic(this.#filePath, state);
  }
}

type Failure = { count: number; at: string; error: string };
type MessageState = {
  processed: Record<string, string>;
  failures: Record<string, Failure>;
};

export class MessageLedger {
  readonly #filePath: string;
  readonly #deadLetterPath: string;

  constructor(stateDir: string) {
    this.#filePath = path.join(stateDir, "message-ledger.json");
    this.#deadLetterPath = path.join(stateDir, "dead-letter.jsonl");
  }

  has(messageKey: string): boolean {
    return Boolean(
      readJsonFile<MessageState>(this.#filePath, { processed: {}, failures: {} }).processed[
        messageKey
      ],
    );
  }

  failureCount(messageKey: string): number {
    return (
      readJsonFile<MessageState>(this.#filePath, { processed: {}, failures: {} }).failures[
        messageKey
      ]?.count ?? 0
    );
  }

  markProcessed(messageKey: string): void {
    const state = readJsonFile<MessageState>(this.#filePath, { processed: {}, failures: {} });
    state.processed[messageKey] = new Date().toISOString();
    delete state.failures[messageKey];
    this.#prune(state);
    writeJsonFileAtomic(this.#filePath, state);
  }

  recordFailure(messageKey: string, error: unknown, maxRetries: number, raw: unknown): boolean {
    const state = readJsonFile<MessageState>(this.#filePath, { processed: {}, failures: {} });
    const previous = state.failures[messageKey];
    const next: Failure = {
      count: (previous?.count ?? 0) + 1,
      at: new Date().toISOString(),
      error: String(error).slice(0, 1_000),
    };
    state.failures[messageKey] = next;
    if (next.count >= maxRetries) {
      fs.mkdirSync(path.dirname(this.#deadLetterPath), { recursive: true });
      fs.appendFileSync(
        this.#deadLetterPath,
        `${JSON.stringify({ messageKey, failure: next, raw })}\n`,
        "utf-8",
      );
      state.processed[messageKey] = new Date().toISOString();
      delete state.failures[messageKey];
      this.#prune(state);
      writeJsonFileAtomic(this.#filePath, state);
      return true;
    }
    writeJsonFileAtomic(this.#filePath, state);
    return false;
  }

  #prune(state: MessageState): void {
    const entries = Object.entries(state.processed);
    if (entries.length <= 10_000) return;
    entries.sort((a, b) => a[1].localeCompare(b[1]));
    state.processed = Object.fromEntries(entries.slice(-8_000));
  }
}

export type PendingReply = {
  text: string;
  sentChunks: number[];
  artifacts: PendingArtifact[];
};

export type PendingArtifact = {
  kind: "image" | "file";
  path: string;
  mimeType?: string;
  sent: boolean;
};

type PendingReplyState = {
  replies: Record<string, string | PendingReply>;
};

export class PendingReplyStore {
  readonly #filePath: string;

  constructor(stateDir: string) {
    this.#filePath = path.join(stateDir, "pending-replies.json");
  }

  get(messageKey: string): string | undefined {
    return this.getDelivery(messageKey)?.text;
  }

  getDelivery(messageKey: string): PendingReply | undefined {
    const value = readJsonFile<PendingReplyState>(this.#filePath, { replies: {} }).replies[
      messageKey
    ];
    if (typeof value === "string") return { text: value, sentChunks: [], artifacts: [] };
    if (!value) return undefined;
    return {
      text: value.text,
      sentChunks: Array.isArray(value.sentChunks) ? [...value.sentChunks] : [],
      artifacts: Array.isArray(value.artifacts)
        ? value.artifacts.flatMap((artifact) =>
            artifact && typeof artifact.path === "string"
              ? [{ ...artifact, sent: Boolean(artifact.sent) }]
              : [],
          )
        : [],
    };
  }

  set(
    messageKey: string,
    reply: string,
    artifacts: Array<Omit<PendingArtifact, "sent">> = [],
  ): void {
    const state = readJsonFile<PendingReplyState>(this.#filePath, { replies: {} });
    const existing = state.replies[messageKey];
    const sentChunks =
      typeof existing === "object" && existing && Array.isArray(existing.sentChunks)
        ? existing.sentChunks
        : [];
    const existingArtifacts =
      typeof existing === "object" && existing && Array.isArray(existing.artifacts)
        ? existing.artifacts
        : [];
    state.replies[messageKey] = {
      text: reply,
      sentChunks,
      artifacts: artifacts.map((artifact) => ({
        ...artifact,
        sent: Boolean(
          existingArtifacts.find(
            (candidate) =>
              candidate.path === artifact.path && candidate.kind === artifact.kind,
          )?.sent,
        ),
      })),
    };
    writeJsonFileAtomic(this.#filePath, state);
  }

  markChunkSent(messageKey: string, chunkIndex: number): void {
    const state = readJsonFile<PendingReplyState>(this.#filePath, { replies: {} });
    const value = state.replies[messageKey];
    if (value === undefined) return;
    const delivery: PendingReply =
      typeof value === "string"
        ? { text: value, sentChunks: [], artifacts: [] }
        : {
            ...value,
            sentChunks: Array.isArray(value.sentChunks) ? value.sentChunks : [],
            artifacts: Array.isArray(value.artifacts) ? value.artifacts : [],
          };
    if (!delivery.sentChunks.includes(chunkIndex)) {
      delivery.sentChunks.push(chunkIndex);
      delivery.sentChunks.sort((a, b) => a - b);
    }
    state.replies[messageKey] = delivery;
    writeJsonFileAtomic(this.#filePath, state);
  }

  markArtifactSent(messageKey: string, artifactIndex: number): void {
    const state = readJsonFile<PendingReplyState>(this.#filePath, { replies: {} });
    const value = state.replies[messageKey];
    if (value === undefined || typeof value === "string") return;
    if (!Array.isArray(value.artifacts) || !value.artifacts[artifactIndex]) return;
    value.artifacts[artifactIndex].sent = true;
    writeJsonFileAtomic(this.#filePath, state);
  }

  delete(messageKey: string): void {
    const state = readJsonFile<PendingReplyState>(this.#filePath, { replies: {} });
    delete state.replies[messageKey];
    writeJsonFileAtomic(this.#filePath, state);
  }
}

export type InboxLane = "command" | "agent";

export type InboxMedia = {
  decryptedPicPath?: string;
  decryptedVoicePath?: string;
  voiceMediaType?: string;
  decryptedFilePath?: string;
  fileMediaType?: string;
  decryptedVideoPath?: string;
};

export type InboxEntry = {
  messageKey: string;
  conversationKey: string;
  lane: InboxLane;
  message: WeixinMessage;
  enqueuedAt: number;
  availableAt: number;
  agentSettings?: {
    model: string;
    modelReasoningEffort: ModelReasoningEffort;
    serviceTier: ServiceTier;
    workingDirectory: string;
    projectName: string;
    projectIsDefault: boolean;
    projectUnavailable?: string;
  };
  media?: InboxMedia;
};

type InboxState = {
  version: 1;
  cursors: Record<string, string>;
  order: string[];
  entries: Record<string, InboxEntry>;
};

/**
 * Durable hand-off between the Weixin cursor and background workers. A message
 * is written here before the getUpdates cursor advances, then removed only
 * after its outbound reply has been recorded as delivered.
 */
export class InboxStore {
  readonly #filePath: string;

  constructor(stateDir: string) {
    this.#filePath = path.join(stateDir, "delivery-state.json");
  }

  enqueue(entry: InboxEntry): boolean {
    const state = this.#read();
    if (state.entries[entry.messageKey]) return false;
    state.entries[entry.messageKey] = entry;
    state.order.push(entry.messageKey);
    this.#write(state);
    return true;
  }

  cursor(accountId: string): string | undefined {
    return this.#read().cursors[accountId];
  }

  /** Atomically persist a complete getUpdates batch and its successor cursor. */
  commitBatch(accountId: string, cursor: string, entries: InboxEntry[]): number {
    const state = this.#read();
    let added = 0;
    for (const entry of entries) {
      if (state.entries[entry.messageKey]) continue;
      state.entries[entry.messageKey] = entry;
      state.order.push(entry.messageKey);
      added += 1;
    }
    state.cursors[accountId] = cursor;
    this.#write(state);
    return added;
  }

  has(messageKey: string): boolean {
    return Boolean(this.#read().entries[messageKey]);
  }

  count(): number {
    return this.#read().order.length;
  }

  list(): InboxEntry[] {
    const state = this.#read();
    return state.order.flatMap((key) => {
      const entry = state.entries[key];
      return entry ? [entry] : [];
    });
  }

  first(conversationKey: string, lane: InboxLane): InboxEntry | undefined {
    return this.list().find(
      (entry) => entry.conversationKey === conversationKey && entry.lane === lane,
    );
  }

  conversationLanes(): Array<{ conversationKey: string; lane: InboxLane }> {
    const seen = new Set<string>();
    const result: Array<{ conversationKey: string; lane: InboxLane }> = [];
    for (const entry of this.list()) {
      const key = `${entry.lane}\0${entry.conversationKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ conversationKey: entry.conversationKey, lane: entry.lane });
    }
    return result;
  }

  setMedia(messageKey: string, media: InboxMedia): void {
    const state = this.#read();
    const entry = state.entries[messageKey];
    if (!entry) return;
    entry.media = { ...media };
    this.#write(state);
  }

  defer(messageKey: string, availableAt: number): void {
    const state = this.#read();
    const entry = state.entries[messageKey];
    if (!entry) return;
    entry.availableAt = availableAt;
    this.#write(state);
  }

  remove(messageKey: string): void {
    const state = this.#read();
    if (!state.entries[messageKey]) return;
    delete state.entries[messageKey];
    state.order = state.order.filter((key) => key !== messageKey);
    this.#write(state);
  }

  #read(): InboxState {
    const empty: InboxState = {
      version: 1,
      cursors: {},
      order: [],
      entries: {},
    };
    if (!fs.existsSync(this.#filePath)) return empty;

    let state: InboxState;
    try {
      state = JSON.parse(fs.readFileSync(this.#filePath, "utf-8")) as InboxState;
    } catch (error) {
      throw new Error(`durable delivery state is unreadable: ${this.#filePath}`, {
        cause: error,
      });
    }
    if (
      state.version !== 1 ||
      !state.cursors ||
      !Array.isArray(state.order) ||
      !state.entries
    ) {
      throw new Error(`durable delivery state has an unsupported shape: ${this.#filePath}`);
    }
    state.order = state.order.filter((key) => Boolean(state.entries[key]));
    return state;
  }

  #write(state: InboxState): void {
    writeJsonFileAtomic(this.#filePath, state);
  }
}
