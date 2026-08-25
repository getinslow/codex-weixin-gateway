import os from "node:os";
import path from "node:path";

/** Resolve the standalone gateway state directory. */
export function resolveStateDir(): string {
  return (
    process.env.CODEX_WEIXIN_STATE_DIR?.trim() ||
    path.join(os.homedir(), ".codex-weixin-gateway")
  );
}
