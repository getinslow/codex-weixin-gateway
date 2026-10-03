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
  fs.writeFileSync(path.join(alpha, "README.md"), "# Ethereum Liquidity Protocol Discovery Engine\n");
  fs.writeFileSync(path.join(spaced, "README.md"), "# 流动性守夜人\n");
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
        projectAliases: {
          "以太坊流动性": "projects/group/alpha-project",
          "以太坊流动性协议发现": "projects/group/alpha-project",
        },
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
    false,
    config.codex.projectAliases,
  );
  assert.equal(resolver.defaultProject().path, canonicalWorkspace);
  assert.equal(resolver.findByName("alpha-project").project?.path, canonicalAlpha);
  assert.equal(resolver.findByName("space project").project?.path, canonicalSpaced);
  assert.equal(resolver.find("以太坊流动性项目").project?.path, canonicalAlpha);
  assert.equal(resolver.find("Ethereum Liquidity").project?.path, canonicalAlpha);
  assert.equal(resolver.find("alpha project").project?.path, canonicalAlpha);
  assert.equal(resolver.find("流动性项目").error, "ambiguous");
  assert.equal(resolver.find("流动性项目").matchCount, 2);
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
  assert.equal(resolver.find(alpha).project?.path, canonicalAlpha);
  assert.equal(resolver.find(outside).error, "not-found");
  assert.equal(resolver.find("../outside-project").error, "invalid-name");
  const fullAccessResolver = new ProjectDirectoryResolver(workspace, [projectsRoot], true);
  assert.equal(fullAccessResolver.find(outside).project?.path, fs.realpathSync.native(outside));
  assert.equal(fullAccessResolver.find(path.join(temporary, "missing")).error, "not-found");
  assert.equal(fullAccessResolver.find(path.join(alpha, "package.json")).error, "not-found");
  assert.equal(fullAccessResolver.find("~").project?.path, fs.realpathSync.native(os.homedir()));
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

  for (const message of [
    "切换到以太坊流动性项目",
    "让你切换到以太坊流动性项目",
    "请帮我切到以太坊流动性项目吧",
    "麻烦你进入以太坊流动性协议发现项目",
    "请把当前项目切换到以太坊流动性项目",
    "我想让你打开以太坊流动性项目",
    "切换到 Ethereum Liquidity",
  ]) {
    assert.match(support.handleControlCommand("account:natural", message), /已切换项目/);
    assert.equal(support.settings("account:natural").workingDirectory, canonicalAlpha);
  }
  assert.equal(support.handleControlCommand("account:natural", "切换到流动性守夜人项目，然后看看进展"), undefined);
  assert.equal(support.settings("account:natural").workingDirectory, canonicalSpaced);
  assert.equal(support.handleControlCommand("account:natural", "去以太坊流动性项目看看进展"), undefined);
  assert.equal(support.settings("account:natural").workingDirectory, canonicalAlpha);
  assert.equal(support.handleControlCommand("account:natural", "切换到流动性守夜人项目后，帮我检查README"), undefined);
  assert.equal(support.settings("account:natural").workingDirectory, canonicalSpaced);
  assert.match(support.handleControlCommand("account:natural", "现在在哪个项目？"), /space project/);
  assert.match(support.handleControlCommand("account:natural", "切换到流动性项目"), /alpha-project[\s\S]*space project/);
  assert.equal(support.settings("account:natural").workingDirectory, canonicalSpaced);
  assert.match(support.handleControlCommand("account:natural", "切换到不存在的项目"), /未找到/);
  assert.equal(support.settings("account:natural").workingDirectory, canonicalSpaced);
  for (const message of [
    "不要切换到以太坊流动性项目",
    "如果以后切换到以太坊流动性项目会怎样？",
    "解释一下切换到以太坊流动性项目的命令",
    "我可能会说切换到以太坊流动性项目",
    "打开 README.md",
    "打开项目的 README",
    "打开 README.md，看看项目说明",
    "切换到 gpt-5.6-terra",
  ]) {
    assert.equal(support.handleControlCommand("account:natural", message), undefined);
    assert.equal(support.settings("account:natural").workingDirectory, canonicalSpaced);
  }
  const reloadedNaturalSupport = new ConversationAgentSupport(config, "test-backend");
  assert.equal(reloadedNaturalSupport.settings("account:natural").workingDirectory, canonicalSpaced);
  assert.match(reloadedNaturalSupport.handleControlCommand("account:natural", "切回默认项目"), /默认项目/);
  assert.equal(reloadedNaturalSupport.settings("account:natural").workingDirectory, canonicalWorkspace);

  const settingsStore = new ConversationSettingsStore(config.stateDir);
  const fullAccessConfig = { ...config, codex: { ...config.codex, sandboxMode: "danger-full-access" } };
  const fullAccessSupport = new ConversationAgentSupport(fullAccessConfig, "test-backend");
  assert.match(fullAccessSupport.handleControlCommand("account:full-access", `/project ${outside}`), /已切换项目/);
  assert.equal(fullAccessSupport.settings("account:full-access").workingDirectory, fs.realpathSync.native(outside));
  const reloadedFullAccessSupport = new ConversationAgentSupport(fullAccessConfig, "test-backend");
  assert.equal(reloadedFullAccessSupport.settings("account:full-access").workingDirectory, fs.realpathSync.native(outside));
  assert.match(reloadedFullAccessSupport.handleControlCommand("account:full-access", `/project ${path.join(temporary, "missing")}`), /未找到/);
  assert.equal(reloadedFullAccessSupport.settings("account:full-access").workingDirectory, fs.realpathSync.native(outside));
  assert.equal(reloadedFullAccessSupport.resolveSettings("account:full-access", fullAccessSupport.settings("account:full-access")).workingDirectory, fs.realpathSync.native(outside));
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
