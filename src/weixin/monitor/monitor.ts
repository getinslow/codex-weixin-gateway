import { classifyFetchError, getUpdates } from "../api/api.js";
import { STALE_TOKEN_ERRCODE, getRemainingPauseMs, pauseSession } from "../api/session-guard.js";
import type { WeixinMessage } from "../api/types.js";
import { getSyncBufFilePath, loadGetUpdatesBuf, saveGetUpdatesBuf } from "../storage/sync-buf.js";
import { logger } from "../util/logger.js";
import { redactBody } from "../util/redact.js";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;

export type MonitorStatus = {
  accountId: string;
  lastEventAt?: number;
  lastInboundAt?: number;
  lastError?: string;
};

export type MonitorWeixinOpts = {
  baseUrl: string;
  token?: string;
  accountId: string;
  abortSignal?: AbortSignal;
  longPollTimeoutMs?: number;
  setStatus?: (next: MonitorStatus) => void;
  loadCursor?: () => string | undefined;
  commitBatch: (messages: WeixinMessage[], nextCursor: string) => Promise<void>;
  fetchUpdates?: typeof getUpdates;
};

/**
 * Long-poll loop with a durable hand-off. The caller atomically persists each
 * batch together with its successor cursor before this loop polls again.
 */
export async function monitorWeixinProvider(opts: MonitorWeixinOpts): Promise<void> {
  const { baseUrl, token, accountId, abortSignal, longPollTimeoutMs, setStatus } = opts;
  const accountLog = logger.withAccount(accountId);
  const fetchUpdates = opts.fetchUpdates ?? getUpdates;
  const syncFilePath = getSyncBufFilePath(accountId);
  let getUpdatesBuf = opts.loadCursor?.() ?? loadGetUpdatesBuf(syncFilePath) ?? "";
  let nextTimeoutMs = longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  let consecutiveFailures = 0;
  accountLog.info(
    `monitor started baseUrl=${baseUrl} timeoutMs=${nextTimeoutMs} resumeCursor=${Boolean(getUpdatesBuf)}`,
  );

  while (!abortSignal?.aborted) {
    try {
      const response = await fetchUpdates({
        baseUrl,
        token,
        get_updates_buf: getUpdatesBuf,
        timeoutMs: nextTimeoutMs,
        abortSignal,
      });
      if (abortSignal?.aborted) break;

      if (response.longpolling_timeout_ms && response.longpolling_timeout_ms > 0) {
        nextTimeoutMs = response.longpolling_timeout_ms;
      }

      const apiError =
        (response.ret !== undefined && response.ret !== 0) ||
        (response.errcode !== undefined && response.errcode !== 0);
      if (apiError) {
        const stale =
          response.errcode === STALE_TOKEN_ERRCODE || response.ret === STALE_TOKEN_ERRCODE;
        if (stale) {
          pauseSession(accountId);
          const pauseMs = getRemainingPauseMs(accountId);
          accountLog.error(`token stale; pausing requests for ${Math.ceil(pauseMs / 60_000)} minutes`);
          await sleep(pauseMs, abortSignal);
          continue;
        }
        throw new Error(
          `getUpdates ret=${response.ret} errcode=${response.errcode} errmsg=${response.errmsg ?? ""} response=${redactBody(JSON.stringify(response))}`,
        );
      }

      consecutiveFailures = 0;
      setStatus?.({ accountId, lastEventAt: Date.now() });
      const messages = response.msgs ?? [];
      if (messages.length > 0) {
        const now = Date.now();
        setStatus?.({ accountId, lastEventAt: now, lastInboundAt: now });
      }
      const nextCursor = response.get_updates_buf ?? getUpdatesBuf;
      await opts.commitBatch(messages, nextCursor);
      getUpdatesBuf = nextCursor;
      if (nextCursor) {
        saveGetUpdatesBuf(syncFilePath, getUpdatesBuf);
      }
    } catch (error) {
      if (abortSignal?.aborted) break;
      consecutiveFailures += 1;
      const classified = classifyFetchError(error);
      const message = `monitor error attempt=${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES} type=${classified.type} error=${String(error)}`;
      accountLog.error(message);
      setStatus?.({ accountId, lastError: message });
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveFailures = 0;
        await sleep(BACKOFF_DELAY_MS, abortSignal);
      } else {
        await sleep(RETRY_DELAY_MS, abortSignal);
      }
    }
  }
  accountLog.info("monitor stopped");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}
