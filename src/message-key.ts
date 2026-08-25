import crypto from "node:crypto";

import type { WeixinMessage } from "./weixin/api/types.js";

export function messageKey(accountId: string, message: WeixinMessage): string {
  if (message.message_id !== undefined) {
    return `${accountId}:message:${String(message.message_id)}`;
  }
  if (message.client_id) {
    return `${accountId}:client:${message.from_user_id ?? ""}:${message.client_id}`;
  }
  if (message.seq !== undefined) {
    const scope = message.group_id || message.session_id || message.from_user_id || "unknown";
    return `${accountId}:seq:${scope}:${String(message.seq)}`;
  }
  const itemId = message.item_list?.find((item) => item.msg_id)?.msg_id;
  if (itemId) return `${accountId}:item:${itemId}`;

  const digest = crypto
    .createHash("sha256")
    .update(stableJson(withoutVolatileFields(message)))
    .digest("hex")
    .slice(0, 32);
  return `${accountId}:hash:${digest}`;
}

/** Keys emitted by pre-0.2 versions, used only to avoid boundary duplicates. */
export function legacyMessageKeys(accountId: string, message: WeixinMessage): string[] {
  const keys = new Set<string>();
  const stable = message.message_id ?? message.seq;
  if (stable !== undefined) {
    keys.add(`${accountId}:${String(stable)}`);
    if (typeof stable === "string" && /^\d+$/.test(stable)) {
      keys.add(`${accountId}:${String(Number(stable))}`);
    }
  }
  keys.add(
    `${accountId}:${crypto
      .createHash("sha256")
      .update(JSON.stringify(message))
      .digest("hex")
      .slice(0, 24)}`,
  );
  return [...keys];
}

function withoutVolatileFields(message: WeixinMessage): unknown {
  const { context_token: _contextToken, update_time_ms: _updated, ...stable } = message;
  return stable;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
