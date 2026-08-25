import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ConversationAgentSupport } from "../dist/agent.js";
import { loadGatewayConfig } from "../dist/config.js";
import { ConversationSettingsStore } from "../dist/json-store.js";
import { ProjectDirectoryResolver } from "../dist/projects.js";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-project-switch-test-"));
try {
  const workspace = path.join(temporary, "gateway-workspace");
  const projectsRoot = path.join(temporary, "projects");
  const alpha = path.join(projectsRoot, "group", "alpha-project");
  const spaced = path.join(projectsRoot, "space project");
  const oldDuplicate = path.join(projectsRoot, "old", "duplicate");
  const newDuplicate = path.join(projectsRoot, "new", "duplicate");
  const ignored = path.join(projectsRoot, "node_modules", "hidden-project");
  const volatile = path.join(projectsRoot, "volatile-project");
  const markerDirectoryOnly = path.join(projectsRoot, "marker-directory-only");
  const outside = path.join(temporary, "outside-project");
  for (const directory of [
    workspace,
    alpha,
    spaced,
    oldDuplicate,
    newDuplicate,
    ignored,
    volatile,
    markerDirectoryOnly,
    outside,
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  for (const directory of [alpha, spaced, oldDuplicate, newDuplicate, ignored, volatile]) {
    fs.writeFileSync(path.join(directory, "package.json"), "{}", "utf-8");
  }
  fs.mkdirSync(path.join(markerDirectoryOnly, "package.json"));
  const canonicalWorkspace = fs.realpathSync.native(workspace);
  const canonicalAlpha = fs.realpathSync.native(alpha);
  const canonicalSpaced = fs.realpathSync.native(spaced);
  const now = new Date();
  fs.utimesSync(oldDuplicate, new Date(now.getTime() - 60_000), new Date(now.getTime() - 60_000));
  fs.utimesSync(newDuplicate, now, now);

  const configPath = path.join(temporary, "gateway.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      stateDir: "state",
      codex: {
        workingDirectory: "gateway-workspace",
        projectRoots: ["projects"],
      },
    }),
    "utf-8",
  );
  const config = loadGatewayConfig(configPath);
  const canonicalProjectsRoot = fs.realpathSync.native(projectsRoot);
  assert.equal(config.codex.workingDirectory, canonicalWorkspace);
  assert.deepEqual(config.codex.projectRoots, [canonicalProjectsRoot]);

  const resolver = new ProjectDirectoryResolver(
    config.codex.workingDirectory,
    config.codex.projectRoots,
  );
  assert.equal(resolver.defaultProject().path, canonicalWorkspace);
  assert.equal(resolver.findByName("alpha-project").project?.path, canonicalAlpha);
  assert.equal(resolver.findByName("space project").project?.path, canonicalSpaced);
  const duplicate = resolver.findByName("duplicate");
  assert.equal(duplicate.matchCount, 2);
  assert.equal(duplicate.project, undefined);
  assert.equal(duplicate.error, "ambiguous");
  assert.equal(resolver.findByName("hidden-project").error, "not-found");
  assert.equal(resolver.findByName("marker-directory-only").error, "not-found");
  fs.unlinkSync(path.join(volatile, "package.json"));
  assert.equal(resolver.findByName("volatile-project").error, "not-found");
  assert.equal(resolver.findByName("../outside-project").error, "invalid-name");
  assert.equal(resolver.validate(outside), undefined);
  assert.equal(resolver.threadKey("account:user", canonicalWorkspace), "account:user");
  assert.match(
    resolver.threadKey("account:user", canonicalAlpha),
    /^account:user:project:[a-f0-9]{20}$/,
  );

  const support = new ConversationAgentSupport(config, "test-backend");
  assert.match(support.handleControlCommand("account:user-a", "/project"), /gateway-workspace/);
  assert.match(
    support.handleControlCommand("account:user-a", "/project space project"),
    /space project/,
  );
  const selected = support.settings("account:user-a");
  assert.equal(selected.workingDirectory, canonicalSpaced);
  assert.equal(selected.projectName, "space project");
  assert.equal(selected.projectIsDefault, false);
  assert.equal(support.settings("account:user-b").workingDirectory, canonicalWorkspace);

  assert.match(support.handleControlCommand("account:user-a", "/project duplicate"), /同名/);
  assert.equal(support.settings("account:user-a").workingDirectory, canonicalSpaced);
  assert.match(support.handleControlCommand("account:user-a", "/project missing"), /未找到/);
  assert.equal(support.settings("account:user-a").workingDirectory, canonicalSpaced);
  assert.match(support.handleControlCommand("account:user-a", "/settings"), /space project/);
  assert.match(support.handleControlCommand("account:user-a", "/project default"), /默认项目/);
  assert.equal(support.settings("account:user-a").workingDirectory, canonicalWorkspace);

  const settingsStore = new ConversationSettingsStore(config.stateDir);
  settingsStore.setProject("account:persisted", alpha);
  const reloadedSupport = new ConversationAgentSupport(config, "test-backend");
  assert.equal(reloadedSupport.settings("account:persisted").workingDirectory, canonicalAlpha);
  settingsStore.setProject("account:persisted", outside);
  assert.equal(reloadedSupport.settings("account:persisted").workingDirectory, canonicalWorkspace);
  assert.equal(reloadedSupport.settings("account:persisted").projectUnavailable, outside);

  const legacyFrozen = {
    model: "gpt-5.6-sol",
    modelReasoningEffort: "low",
    serviceTier: "default",
  };
  assert.equal(
    reloadedSupport.resolveSettings("account:legacy", legacyFrozen).workingDirectory,
    canonicalWorkspace,
  );
  assert.throws(
    () =>
      reloadedSupport.resolveSettings("account:unavailable", {
        ...legacyFrozen,
        workingDirectory: outside,
        projectName: "outside-project",
        projectIsDefault: false,
      }),
    /selected project directory is unavailable/,
  );

  process.stdout.write("project switch tests passed\n");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
