import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "../storage/state-dir.js";
import { logger } from "../util/logger.js";

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

export type WeixinAccountData = {
  token?: string;
  savedAt?: string;
  baseUrl?: string;
  userId?: string;
};

export type ResolvedWeixinAccount = {
  accountId: string;
  baseUrl: string;
  cdnBaseUrl: string;
  token?: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
};

export function normalizeAccountId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function deriveRawAccountId(value: string): string | undefined {
  if (value.endsWith("-im-bot")) return `${value.slice(0, -7)}@im.bot`;
  return undefined;
}

function resolveWeixinStateDir(): string {
  return path.join(resolveStateDir(), "weixin");
}

function resolveAccountsDir(): string {
  return path.join(resolveWeixinStateDir(), "accounts");
}

function resolveAccountIndexPath(): string {
  return path.join(resolveWeixinStateDir(), "accounts.json");
}

function resolveAccountPath(accountId: string): string {
  return path.join(resolveAccountsDir(), `${accountId}.json`);
}

export function listIndexedWeixinAccountIds(): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(resolveAccountIndexPath(), "utf-8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

export function registerWeixinAccountId(accountId: string): void {
  const normalized = normalizeAccountId(accountId);
  const existing = listIndexedWeixinAccountIds();
  if (existing.includes(normalized)) return;
  fs.mkdirSync(resolveWeixinStateDir(), { recursive: true });
  fs.writeFileSync(resolveAccountIndexPath(), JSON.stringify([...existing, normalized], null, 2), "utf-8");
}

export function unregisterWeixinAccountId(accountId: string): void {
  const normalized = normalizeAccountId(accountId);
  const next = listIndexedWeixinAccountIds().filter((value) => value !== normalized);
  fs.mkdirSync(resolveWeixinStateDir(), { recursive: true });
  fs.writeFileSync(resolveAccountIndexPath(), JSON.stringify(next, null, 2), "utf-8");
}

function readAccountFile(filePath: string): WeixinAccountData | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as WeixinAccountData;
  } catch {
    return null;
  }
}

export function loadWeixinAccount(accountId: string): WeixinAccountData | null {
  const normalized = normalizeAccountId(accountId);
  const primary = readAccountFile(resolveAccountPath(normalized));
  if (primary) return primary;
  const raw = deriveRawAccountId(normalized);
  return raw ? readAccountFile(resolveAccountPath(raw)) : null;
}

export function saveWeixinAccount(
  accountId: string,
  update: { token?: string; baseUrl?: string; userId?: string },
): void {
  const normalized = normalizeAccountId(accountId);
  const existing = loadWeixinAccount(normalized) ?? {};
  const data: WeixinAccountData = {
    token: update.token?.trim() || existing.token,
    baseUrl: update.baseUrl?.trim() || existing.baseUrl || DEFAULT_BASE_URL,
    userId: update.userId !== undefined ? update.userId.trim() || undefined : existing.userId,
    savedAt: new Date().toISOString(),
  };
  fs.mkdirSync(resolveAccountsDir(), { recursive: true });
  const filePath = resolveAccountPath(normalized);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows and some filesystems do not implement POSIX modes.
  }
}

export function clearWeixinAccount(accountId: string): void {
  const normalized = normalizeAccountId(accountId);
  for (const suffix of [".json", ".sync.json", ".context-tokens.json"]) {
    try {
      fs.unlinkSync(path.join(resolveAccountsDir(), `${normalized}${suffix}`));
    } catch {
      // Missing files are fine.
    }
  }
}

export function clearStaleAccountsForUserId(
  currentAccountId: string,
  userId: string,
  onClearContextTokens?: (accountId: string) => void,
): void {
  const current = normalizeAccountId(currentAccountId);
  for (const accountId of listIndexedWeixinAccountIds()) {
    if (accountId === current) continue;
    if (loadWeixinAccount(accountId)?.userId?.trim() === userId.trim()) {
      logger.info(`removing stale account=${accountId} for duplicate userId`);
      onClearContextTokens?.(accountId);
      clearWeixinAccount(accountId);
      unregisterWeixinAccountId(accountId);
    }
  }
}

export function loadConfigRouteTag(): string | undefined {
  return process.env.WEIXIN_ROUTE_TAG?.trim() || undefined;
}

export function loadConfigBotAgent(): string | undefined {
  return process.env.WEIXIN_BOT_AGENT?.trim() || "CodexWeixinGateway/0.5.0";
}

export function resolveWeixinAccount(params: {
  accountId?: string;
  baseUrl?: string;
  cdnBaseUrl?: string;
} = {}): ResolvedWeixinAccount {
  const ids = listIndexedWeixinAccountIds();
  const selected = params.accountId?.trim() || ids.at(-1);
  if (!selected) throw new Error("No Weixin account found. Run the login command first.");
  const accountId = normalizeAccountId(selected);
  const data = loadWeixinAccount(accountId);
  const token = data?.token?.trim() || undefined;
  return {
    accountId,
    baseUrl: params.baseUrl?.trim() || data?.baseUrl?.trim() || DEFAULT_BASE_URL,
    cdnBaseUrl: params.cdnBaseUrl?.trim() || CDN_BASE_URL,
    token,
    enabled: true,
    configured: Boolean(token),
  };
}
