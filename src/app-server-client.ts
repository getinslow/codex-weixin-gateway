import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { logger } from "./weixin/util/logger.js";
import { redactBody } from "./weixin/util/redact.js";

type RequestId = number;

export type AppServerMessage = {
  id?: RequestId | string;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: { code?: number; message?: string; data?: unknown };
};

type PendingRequest = {
  method: string;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

export class AppServerRpcError extends Error {
  readonly code?: number;
  readonly data?: unknown;

  constructor(method: string, error: { code?: number; message?: string; data?: unknown }) {
    super(`app-server ${method} failed: ${error.message ?? "unknown RPC error"}`);
    this.name = "AppServerRpcError";
    this.code = error.code;
    this.data = error.data;
  }
}

export type AppServerClientStatus = {
  ready: boolean;
  pid?: number;
  generation: number;
  restarts: number;
  lastStartedAt?: number;
  lastExitAt?: number;
};

type LaunchSpec = {
  command: string;
  args: string[];
  pathDirs: string[];
};

export class AppServerClient {
  readonly #codexPath?: string;
  readonly #startupTimeoutMs: number;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #listeners = new Set<(message: AppServerMessage) => void>();
  #child?: ChildProcessWithoutNullStreams;
  #nextId = 1;
  #ready = false;
  #starting?: Promise<void>;
  #stopping = false;
  #generation = 0;
  #restarts = 0;
  #lastStartedAt?: number;
  #lastExitAt?: number;
  #lastStderr = "";

  constructor(options: { codexPath?: string; startupTimeoutMs: number }) {
    this.#codexPath = options.codexPath;
    this.#startupTimeoutMs = options.startupTimeoutMs;
  }

  status(): AppServerClientStatus {
    return {
      ready: this.#ready,
      pid: this.#child?.pid,
      generation: this.#generation,
      restarts: this.#restarts,
      lastStartedAt: this.#lastStartedAt,
      lastExitAt: this.#lastExitAt,
    };
  }

  async start(): Promise<void> {
    if (this.#ready && this.#child) return;
    if (this.#starting) return this.#starting;
    this.#starting = this.#startOnce();
    try {
      await this.#starting;
    } finally {
      this.#starting = undefined;
    }
  }

  async #startOnce(): Promise<void> {
    this.#stopping = false;
    const launch = resolveCodexLaunch(this.#codexPath);
    const env = { ...process.env };
    prependPath(env, launch.pathDirs);
    const child = spawn(launch.command, [...launch.args, "app-server"], {
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child = child;
    this.#lastStderr = "";
    this.#lastStartedAt = Date.now();
    if (this.#generation > 0) this.#restarts += 1;

    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this.#handleLine(line));
    child.stderr.on("data", (chunk: Buffer) => {
      this.#lastStderr = `${this.#lastStderr}${chunk.toString("utf-8")}`.slice(-4_000);
    });
    child.once("error", (error) => this.#handleExit(error));
    child.once("exit", (code, signal) => {
      this.#handleExit(
        new Error(`app-server exited code=${code ?? "null"} signal=${signal ?? "none"}`),
      );
    });

    try {
      await this.request(
        "initialize",
        {
          clientInfo: {
            name: "codex_weixin_gateway",
            title: "Codex Weixin Gateway",
            version: "0.4.0",
          },
          capabilities: {
            experimentalApi: false,
            requestAttestation: false,
          },
        },
        this.#startupTimeoutMs,
      );
      this.notify("initialized", {});
      this.#ready = true;
      this.#generation += 1;
      logger.info(`Codex app-server ready pid=${child.pid} generation=${this.#generation}`);
    } catch (error) {
      child.kill();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#ready = false;
    const child = this.#child;
    if (!child) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.stdin.end();
    await Promise.race([
      exited,
      new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    this.#child = undefined;
  }

  request(method: string, params: unknown, timeoutMs = 30_000): Promise<any> {
    const child = this.#child;
    if (!child?.stdin.writable) {
      return Promise.reject(new Error("Codex app-server is not running"));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(String(id));
        reject(new Error(`app-server request timed out method=${method} timeoutMs=${timeoutMs}`));
      }, timeoutMs);
      timeout.unref();
      this.#pending.set(String(id), { method, resolve, reject, timeout });
      try {
        this.#write({ method, id, params });
      } catch (error) {
        clearTimeout(timeout);
        this.#pending.delete(String(id));
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.#write({ method, params });
  }

  onNotification(listener: (message: AppServerMessage) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #write(message: unknown): void {
    const child = this.#child;
    if (!child?.stdin.writable) throw new Error("Codex app-server stdin is not writable");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line: string): void {
    let message: AppServerMessage;
    try {
      message = JSON.parse(line) as AppServerMessage;
    } catch (error) {
      logger.warn(`ignored invalid app-server JSONL: ${String(error)}`);
      return;
    }

    if (message.method && message.id !== undefined) {
      this.#handleServerRequest(message);
      return;
    }
    if (message.id !== undefined) {
      const pending = this.#pending.get(String(message.id));
      if (!pending) return;
      this.#pending.delete(String(message.id));
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(new AppServerRpcError(pending.method, message.error));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method) this.#emit(message);
  }

  #handleServerRequest(message: AppServerMessage): void {
    const id = message.id!;
    const method = message.method!;
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval"
    ) {
      this.#write({ id, result: { decision: "decline" } });
      return;
    }
    if (method === "item/permissions/requestApproval") {
      this.#write({ id, result: { permissions: {}, scope: "turn" } });
      return;
    }
    if (method === "mcpServer/elicitation/request") {
      this.#write({ id, result: { action: "decline", content: null, _meta: null } });
      return;
    }
    if (method === "currentTime/read") {
      this.#write({ id, result: { currentTimeAt: Math.floor(Date.now() / 1_000) } });
      return;
    }
    this.#write({
      id,
      error: { code: -32601, message: `Unsupported server request: ${method}` },
    });
  }

  #emit(message: AppServerMessage): void {
    for (const listener of this.#listeners) {
      try {
        listener(message);
      } catch (error) {
        logger.warn(`app-server event listener failed: ${String(error)}`);
      }
    }
  }

  #handleExit(error: Error): void {
    const child = this.#child;
    if (!child) return;
    this.#child = undefined;
    this.#ready = false;
    this.#lastExitAt = Date.now();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#emit({ method: "client/disconnected", params: { error: error.message } });
    if (!this.#stopping) {
      logger.error(
        `Codex app-server disconnected error=${error.message} stderr=${redactBody(this.#lastStderr)}`,
      );
    }
  }
}

function resolveCodexLaunch(override?: string): LaunchSpec {
  if (override) {
    if (process.platform === "win32" && override.toLowerCase().endsWith(".cmd")) {
      throw new Error("codexPath must point to codex.exe, not a .cmd wrapper");
    }
    if (/\.(?:mjs|cjs|js)$/i.test(override)) {
      return { command: process.execPath, args: [override], pathDirs: [] };
    }
    return { command: override, args: [], pathDirs: [] };
  }

  const target = platformTarget();
  let directory = path.dirname(fileURLToPath(import.meta.url));
  const root = path.parse(directory).root;
  while (directory !== root) {
    const vendor = path.join(directory, "node_modules", target.packageName, "vendor");
    const packageRoot = path.join(vendor, target.triple);
    const modern = path.join(packageRoot, "bin", target.binaryName);
    if (fs.existsSync(modern)) {
      return {
        command: modern,
        args: [],
        pathDirs: [path.join(packageRoot, "codex-path")].filter(fs.existsSync),
      };
    }
    const legacy = path.join(packageRoot, "codex", target.binaryName);
    if (fs.existsSync(legacy)) {
      return {
        command: legacy,
        args: [],
        pathDirs: [path.join(packageRoot, "path")].filter(fs.existsSync),
      };
    }
    directory = path.dirname(directory);
  }
  throw new Error(
    `Unable to locate bundled Codex CLI for ${process.platform}/${process.arch}; set codex.codexPath`,
  );
}

function platformTarget(): { packageName: string; triple: string; binaryName: string } {
  const key = `${process.platform}/${process.arch}`;
  const targets: Record<string, { packageName: string; triple: string; binaryName: string }> = {
    "win32/x64": {
      packageName: "@openai/codex-win32-x64",
      triple: "x86_64-pc-windows-msvc",
      binaryName: "codex.exe",
    },
    "win32/arm64": {
      packageName: "@openai/codex-win32-arm64",
      triple: "aarch64-pc-windows-msvc",
      binaryName: "codex.exe",
    },
    "linux/x64": {
      packageName: "@openai/codex-linux-x64",
      triple: "x86_64-unknown-linux-musl",
      binaryName: "codex",
    },
    "linux/arm64": {
      packageName: "@openai/codex-linux-arm64",
      triple: "aarch64-unknown-linux-musl",
      binaryName: "codex",
    },
    "darwin/x64": {
      packageName: "@openai/codex-darwin-x64",
      triple: "x86_64-apple-darwin",
      binaryName: "codex",
    },
    "darwin/arm64": {
      packageName: "@openai/codex-darwin-arm64",
      triple: "aarch64-apple-darwin",
      binaryName: "codex",
    },
  };
  const target = targets[key];
  if (!target) throw new Error(`Unsupported Codex platform: ${key}`);
  return target;
}

function prependPath(env: NodeJS.ProcessEnv, directories: string[]): void {
  if (directories.length === 0) return;
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  env[pathKey] = `${directories.join(path.delimiter)}${path.delimiter}${env[pathKey] ?? ""}`;
}
