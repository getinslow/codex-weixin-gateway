import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sendWeixinMediaFile } from "../dist/weixin/messaging/send-media.js";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-media-send-test-"));
const originalFetch = globalThis.fetch;
try {
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
    "base64",
  );
  const imagePath = path.join(temporary, "generated.png");
  fs.writeFileSync(imagePath, image);

  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const body = init.body instanceof Uint8Array ? Buffer.from(init.body) : init.body;
    calls.push({ url, init, body });
    if (url.includes("/getuploadurl")) {
      return new Response(JSON.stringify({ upload_full_url: "https://cdn.test/upload" }), {
        status: 200,
      });
    }
    if (url === "https://cdn.test/upload") {
      return new Response("", {
        status: 200,
        headers: { "x-encrypted-param": "download-param" },
      });
    }
    if (url.includes("/sendmessage")) {
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const fixedClientId = "codex-weixin:fixed-image-client-id";
  await sendWeixinMediaFile({
    filePath: imagePath,
    to: "user-1",
    text: "",
    opts: {
      baseUrl: "https://api.test",
      token: "test-token",
      contextToken: "context-1",
      runId: "run-1",
    },
    cdnBaseUrl: "https://cdn.test/c2c",
    clientIds: { media: fixedClientId },
  });

  assert.equal(calls.length, 3);
  const uploadRequest = JSON.parse(String(calls[0].body));
  assert.equal(uploadRequest.media_type, 1);
  assert.equal(uploadRequest.to_user_id, "user-1");
  assert.equal(uploadRequest.rawsize, image.length);
  assert.equal(uploadRequest.no_need_thumb, true);

  const decipher = crypto.createDecipheriv(
    "aes-128-ecb",
    Buffer.from(uploadRequest.aeskey, "hex"),
    null,
  );
  const decrypted = Buffer.concat([decipher.update(calls[1].body), decipher.final()]);
  assert.deepEqual(decrypted, image);

  const sendRequest = JSON.parse(String(calls[2].body));
  assert.equal(sendRequest.msg.client_id, fixedClientId);
  assert.equal(sendRequest.msg.context_token, "context-1");
  assert.equal(sendRequest.msg.run_id, "run-1");
  assert.equal(sendRequest.msg.item_list[0].type, 2);
  assert.equal(
    sendRequest.msg.item_list[0].image_item.media.encrypt_query_param,
    "download-param",
  );
  assert.equal(sendRequest.msg.item_list[0].image_item.media.encrypt_type, 1);

  process.stdout.write("media send tests passed\n");
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(temporary, { recursive: true, force: true });
}
