import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CodexAppServerBackend,
  imageGenerationArtifact,
  validateGeneratedImagePath,
} from "../dist/app-server-backend.js";
import { loadGatewayConfig } from "../dist/config.js";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-app-server-test-"));
try {
  const projectsRoot = path.join(temporary, "projects");
  const alphaProject = path.join(projectsRoot, "alpha-project");
  fs.mkdirSync(alphaProject, { recursive: true });
  fs.writeFileSync(path.join(alphaProject, "package.json"), "{}", "utf-8");
  const canonicalAlphaProject = fs.realpathSync.native(alphaProject);
  const fixture = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "fake-app-server.mjs",
  );
  const configPath = path.join(temporary, "gateway.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      stateDir: "state",
      codex: {
        backend: "app-server",
        codexPath: fixture,
        workingDirectory: temporary,
        projectRoots: [projectsRoot],
        sandboxMode: "workspace-write",
        turnTimeoutMs: 5_000,
      },
    }),
    "utf-8",
  );
  const backend = new CodexAppServerBackend(loadGatewayConfig(configPath));
  await backend.start();
  const firstStatus = backend.status();
  assert.equal(firstStatus.appServerReady, true);
  assert.ok(firstStatus.appServerPid);

  const progress = [];
  const [first, second] = await Promise.all([
    backend.respond({
      conversationKey: "account:user-a",
      text: "first",
      onProgress: (stage) => progress.push(stage),
    }),
    backend.respond({ conversationKey: "account:user-b", text: "second" }),
  ]);
  assert.match(first, /^fake reply turn-/);
  assert.match(second, /^fake reply turn-/);
  assert.notEqual(first, second);
  assert.ok(progress.includes("first-delta"));
  assert.ok(progress.includes("completed"));
  assert.equal(backend.status().appServerPid, firstStatus.appServerPid);

  const defaultThread = /thread=(\S+)/.exec(first)?.[1];
  assert.ok(defaultThread);
  assert.match(
    backend.handleControlCommand({
      conversationKey: "account:user-a",
      text: "/project alpha-project",
    }),
    /alpha-project/,
  );
  const alphaSettings = backend.snapshotSettings("account:user-a");
  assert.equal(alphaSettings.workingDirectory, canonicalAlphaProject);
  const alphaReply = await backend.respond({
    conversationKey: "account:user-a",
    text: "inside alpha",
    settings: alphaSettings,
  });
  const alphaThread = /thread=(\S+)/.exec(alphaReply)?.[1];
  assert.ok(alphaThread);
  assert.notEqual(alphaThread, defaultThread);
  assert.ok(alphaReply.includes(`cwd=${canonicalAlphaProject}`));
  assert.ok(alphaReply.includes(canonicalAlphaProject));

  backend.handleControlCommand({
    conversationKey: "account:user-a",
    text: "/project default",
  });
  const defaultAgain = await backend.respond({
    conversationKey: "account:user-a",
    text: "back to default",
    settings: backend.snapshotSettings("account:user-a"),
  });
  assert.equal(/thread=(\S+)/.exec(defaultAgain)?.[1], defaultThread);

  backend.handleControlCommand({
    conversationKey: "account:user-a",
    text: "/project alpha-project",
  });
  const alphaAgain = await backend.respond({
    conversationKey: "account:user-a",
    text: "back to alpha",
    settings: backend.snapshotSettings("account:user-a"),
  });
  assert.equal(/thread=(\S+)/.exec(alphaAgain)?.[1], alphaThread);

  const compoundText = "切换到alpha-project项目，然后查看README";
  assert.equal(backend.handleControlCommand({ conversationKey: "account:user-a", text: compoundText }), undefined);
  const compoundSettings = backend.snapshotSettings("account:user-a");
  backend.handleControlCommand({ conversationKey: "account:user-a", text: "切回默认项目" });
  const compoundReply = await backend.respond({
    conversationKey: "account:user-a",
    text: compoundText,
    settings: compoundSettings,
  });
  assert.ok(compoundReply.includes(`cwd=${canonicalAlphaProject}`));
  assert.equal(backend.snapshotSettings("account:user-a").projectIsDefault, true);
  backend.handleControlCommand({ conversationKey: "account:user-a", text: "切换到alpha-project项目" });

  const generatedPath = path.join(canonicalAlphaProject, "fake-generated.png");
  fs.writeFileSync(
    generatedPath,
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=", "base64"),
  );
  const artifacts = [];
  backend.handleControlCommand({
    conversationKey: "account:user-image",
    text: "/project alpha-project",
  });
  const imageReply = await backend.respond({
    conversationKey: "account:user-image",
    text: "generate image",
    settings: backend.snapshotSettings("account:user-image"),
    onArtifact: (artifact) => artifacts.push(artifact),
  });
  assert.match(imageReply, /^fake reply turn-/);
  assert.deepEqual(artifacts, [
    { kind: "image", path: generatedPath, mimeType: "image/png" },
  ]);

  const png = fs.readFileSync(generatedPath);
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
  const fallback = imageGenerationArtifact(
    { id: "fallback", result: dataUrl },
    path.join(temporary, "state"),
    temporary,
  );
  assert.equal(fallback?.kind, "image");
  assert.equal(fallback?.mimeType, "image/png");
  assert.match(path.basename(fallback.path), /^fallback-[a-f0-9]{64}\.png$/);
  assert.deepEqual(fs.readFileSync(fallback.path), png);
  assert.deepEqual(
    validateGeneratedImagePath(fallback.path, path.join(temporary, "state"), temporary),
    { path: fallback.path, mimeType: "image/png" },
  );

  const changedPng = Buffer.from(png);
  changedPng[changedPng.length - 1] ^= 1;
  const changedFallback = imageGenerationArtifact(
    { id: "fallback", result: changedPng.toString("base64") },
    path.join(temporary, "state"),
    temporary,
  );
  assert.equal(changedFallback?.mimeType, "image/png");
  assert.notEqual(changedFallback?.path, fallback.path);
  assert.equal(
    imageGenerationArtifact(
      { id: "mismatch", result: `data:image/jpeg;base64,${png.toString("base64")}` },
      path.join(temporary, "state"),
      temporary,
    ),
    undefined,
  );
  assert.equal(
    imageGenerationArtifact(
      { id: "unsupported", result: `data:image/svg+xml;base64,${png.toString("base64")}` },
      path.join(temporary, "state"),
      temporary,
    ),
    undefined,
  );
  assert.equal(
    imageGenerationArtifact(
      { id: "invalid", result: "data:image/png;base64,not-base64" },
      path.join(temporary, "state"),
      temporary,
    ),
    undefined,
  );

  await backend.stop();
  assert.equal(backend.status().appServerReady, false);

  // A fresh backend process must resume the persisted thread using only
  // stable-protocol fields. Current app-server builds reject excludeTurns on
  // thread/resume unless experimentalApi is enabled.
  const resumedBackend = new CodexAppServerBackend(loadGatewayConfig(configPath));
  await resumedBackend.start();
  const resumed = await resumedBackend.respond({
    conversationKey: "account:user-a",
    text: "after restart",
    settings: resumedBackend.snapshotSettings("account:user-a"),
  });
  assert.match(resumed, /^fake reply turn-/);
  assert.equal(/thread=(\S+)/.exec(resumed)?.[1], alphaThread);
  assert.ok(resumed.includes(`cwd=${canonicalAlphaProject}`));
  assert.equal(resumedBackend.status().loadedThreads, 1);
  await resumedBackend.stop();

  process.stdout.write("app-server client tests passed\n");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
