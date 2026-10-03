import path from "node:path";

import { Codex } from "@openai/codex-sdk";
import type { Input, ThreadOptions } from "@openai/codex-sdk";

import type { GatewayConfig } from "./config.js";
import {
  ConversationSettingsStore,
  ThreadStore,
  type ModelReasoningEffort,
  type ServiceTier,
} from "./json-store.js";
import { ProjectDirectoryResolver } from "./projects.js";
import { projectSwitchIntent } from "./project-intent.js";
import { logger } from "./weixin/util/logger.js";

export type AgentProgressStage =
  | "thread-ready"
  | "turn-started"
  | "first-delta"
  | "completed";

export type AgentArtifact = {
  kind: "image" | "file";
  path: string;
  mimeType?: string;
};

export type AgentRequest = {
  requestId?: string;
  conversationKey: string;
  text: string;
  mediaPath?: string;
  mediaType?: string;
  settings?: ResolvedConversationSettings;
  onProgress?: (stage: AgentProgressStage) => void;
  onArtifact?: (artifact: AgentArtifact) => void;
};

export interface AgentBackend {
  readonly name: string;
  start?(): Promise<void>;
  stop?(): Promise<void>;
  snapshotSettings(conversationKey: string): ResolvedConversationSettings;
  handleControlCommand(request: AgentRequest): string | undefined;
  respond(request: AgentRequest): Promise<string>;
  status?(): Record<string, unknown>;
}

export type ResolvedConversationSettings = {
  model: string;
  modelReasoningEffort: ModelReasoningEffort;
  serviceTier: ServiceTier;
  workingDirectory: string;
  projectName: string;
  projectIsDefault: boolean;
  projectUnavailable?: string;
};

/** Shared prompt, settings, and local command behavior for every backend. */
export class ConversationAgentSupport {
  readonly #settings: ConversationSettingsStore;
  readonly #defaultModel: string;
  readonly #defaultReasoningEffort: ModelReasoningEffort;
  readonly #switchableModels: string[];
  readonly #promptPrefix: string;
  readonly #backendName: string;
  readonly #defaultServiceTier: ServiceTier;
  readonly #projects: ProjectDirectoryResolver;

  constructor(config: GatewayConfig, backendName: string) {
    this.#settings = new ConversationSettingsStore(config.stateDir);
    this.#defaultModel = config.codex.model;
    this.#defaultReasoningEffort = config.codex.modelReasoningEffort;
    this.#switchableModels = Array.from(
      new Set([config.codex.model, ...config.codex.switchableModels]),
    );
    this.#promptPrefix = config.codex.promptPrefix;
    this.#backendName = backendName;
    this.#defaultServiceTier = config.codex.serviceTier;
    this.#projects = new ProjectDirectoryResolver(
      config.codex.workingDirectory,
      config.codex.projectRoots,
      config.codex.sandboxMode === "danger-full-access",
      config.codex.projectAliases,
    );
  }

  settings(conversationKey: string): ResolvedConversationSettings {
    const settings = this.#settings.get(conversationKey);
    const defaultProject = this.#projects.defaultProject();
    const validatedProject = this.#projects.validate(settings.projectPath);
    const selectedProject = validatedProject ?? defaultProject;
    const projectUnavailable = settings.projectPath && !validatedProject
      ? settings.projectPath
      : undefined;
    return {
      model: settings.model ?? this.#defaultModel,
      modelReasoningEffort:
        settings.modelReasoningEffort ?? this.#defaultReasoningEffort,
      serviceTier: settings.serviceTier ?? this.#defaultServiceTier,
      workingDirectory: selectedProject.path,
      projectName: projectUnavailable ? path.basename(projectUnavailable) : selectedProject.name,
      projectIsDefault: !projectUnavailable && selectedProject.path === defaultProject.path,
      projectUnavailable,
    };
  }

  resolveSettings(
    conversationKey: string,
    frozen?: ResolvedConversationSettings,
  ): ResolvedConversationSettings {
    const current = this.settings(conversationKey);
    if (!frozen) {
      if (current.projectUnavailable) {
        throw new Error(`selected project directory is unavailable: ${current.projectUnavailable}`);
      }
      return current;
    }
    if (frozen.projectUnavailable) {
      throw new Error(`selected project directory is unavailable: ${frozen.projectUnavailable}`);
    }
    const frozenWorkingDirectory =
      typeof frozen.workingDirectory === "string" ? frozen.workingDirectory : undefined;
    const selectedProject = frozenWorkingDirectory
      ? this.#projects.validate(frozenWorkingDirectory)
      : this.#projects.defaultProject();
    if (!selectedProject) {
      throw new Error(
        `selected project directory is unavailable: ${frozen.projectName ?? frozenWorkingDirectory}`,
      );
    }
    return {
      ...current,
      ...frozen,
      workingDirectory: selectedProject.path,
      projectName: selectedProject.name,
      projectIsDefault: selectedProject.path === this.#projects.defaultProject().path,
      projectUnavailable: undefined,
    };
  }

  threadKey(conversationKey: string, workingDirectory: string): string {
    return this.#projects.threadKey(conversationKey, workingDirectory);
  }

  prompt(request: AgentRequest, settings = this.resolveSettings(request.conversationKey, request.settings)): string {
    const body = request.text || "（用户发送了一个附件）";
    let prompt = `${this.#promptPrefix}\n\n微信用户消息：\n${body}`;
    prompt += `\n\n当前项目：${settings.projectName}\n项目目录：${settings.workingDirectory}`;
    if (request.mediaPath && !request.mediaType?.startsWith("image/")) {
      prompt += `\n\n附件已保存到：${request.mediaPath}\n附件类型：${request.mediaType ?? "未知"}`;
    }
    return prompt;
  }

  handleControlCommand(conversationKey: string, text: string): string | undefined {
    const intent = projectSwitchIntent(text);
    if (intent) {
      const lookup = this.#projects.find(intent.selection);
      // "打开 README" and switches of models or topics must remain ordinary requests.
      if (intent.explicitProject || lookup.project || lookup.error === "ambiguous" || /^(?:默认|默认项目)$/u.test(intent.selection)) {
        const reply = this.#switchProject(conversationKey, intent.selection);
        return intent.hasFollowup && reply.startsWith("已切") ? undefined : reply;
      }
    }
    if (/^(?:当前|现在|我|我们)?(?:在哪个项目|是哪个项目|用的是哪个项目)[？?。]?$/u.test(text.trim())) {
      return this.#formatProject(conversationKey);
    }
    const parts = text.trim().split(/\s+/);
    const command = parts[0]?.toLowerCase();
    const argument = parts.slice(1).join(" ").trim() || undefined;

    if (["/settings", "/设置"].includes(command)) {
      if (argument?.toLowerCase() === "reset" || argument === "重置") {
        this.#settings.clear(conversationKey);
        return `已恢复默认设置。\n\n${this.#formatSettings(conversationKey)}`;
      }
      return this.#formatSettings(conversationKey);
    }

    if (["/model", "/模型"].includes(command)) {
      if (!argument) return this.#formatModel(conversationKey);
      if (argument.toLowerCase() === "list" || argument === "列表") {
        return `可切换模型：\n${this.#switchableModels
          .map((model) => `- ${model}`)
          .join("\n")}`;
      }
      if (["default", "reset"].includes(argument.toLowerCase()) || argument === "默认") {
        this.#settings.setModel(conversationKey);
        return `模型已恢复默认：${this.#defaultModel}`;
      }
      const selected = this.#switchableModels.find(
        (model) => model.toLowerCase() === argument.toLowerCase(),
      );
      if (!selected) {
        return `不允许使用模型：${argument}\n可用模型：${this.#switchableModels.join("、")}`;
      }
      this.#settings.setModel(conversationKey, selected);
      return `模型已切换为：${selected}\n下一条普通消息开始生效。`;
    }

    if (["/effort", "/reasoning", "/推理"].includes(command)) {
      if (!argument) return this.#formatEffort(conversationKey);
      if (["default", "reset"].includes(argument.toLowerCase()) || argument === "默认") {
        this.#settings.setReasoningEffort(conversationKey);
        return `推理强度已恢复默认：${this.#defaultReasoningEffort}`;
      }
      const effort = argument.toLowerCase();
      if (!isModelReasoningEffort(effort)) {
        return "无效的推理强度。可选：minimal、low、medium、high、xhigh";
      }
      this.#settings.setReasoningEffort(conversationKey, effort);
      return `推理强度已切换为：${effort}\n下一条普通消息开始生效。`;
    }

    if (["/speed", "/tier", "/速度"].includes(command)) {
      if (!argument) return this.#formatServiceTier(conversationKey);
      const normalized = argument.toLowerCase();
      if (["default", "standard", "reset"].includes(normalized) || argument === "默认") {
        this.#settings.setServiceTier(conversationKey);
        return `服务等级已恢复默认：${this.#defaultServiceTier}`;
      }
      if (["fast", "priority"].includes(normalized)) {
        this.#settings.setServiceTier(conversationKey, "priority");
        return "已启用 Fast（priority）服务等级；下一条普通消息生效，并会增加用量成本。";
      }
      return "无效的服务等级。可选：default、fast（priority）";
    }

    if (["/project", "/项目"].includes(command)) {
      if (!argument) return this.#formatProject(conversationKey);
      return this.#switchProject(conversationKey, argument);
    }

    return undefined;
  }

  #switchProject(conversationKey: string, selection: string): string {
    if (["default", "reset", "默认", "默认项目", "默认目录"].includes(selection.toLowerCase())) {
      this.#settings.setProject(conversationKey);
      const project = this.settings(conversationKey);
      return `已切回默认项目：${project.projectName}\n目录：${project.workingDirectory}`;
    }
    const lookup = this.#projects.find(selection);
    if (lookup.error === "invalid-name") return "没有识别到项目，请告诉我项目名称或目录。";
    if (lookup.error === "ambiguous") {
      const candidates = (lookup.candidates ?? []).slice(0, 8)
        .map((project) => `${project.name}：${project.path}`).join("\n");
      return `找到 ${lookup.matchCount} 个同名或相关项目：${selection}\n${candidates}\n请告诉我你要切换到哪一个。`;
    }
    if (!lookup.project) return `未找到项目：${selection}\n可以告诉我这个项目的另一个名称或目录。`;
    this.#settings.setProject(conversationKey, lookup.project.path);
    return `已切换项目：${lookup.project.name}\n目录：${lookup.project.path}`;
  }

  #formatSettings(conversationKey: string): string {
    return [
      "当前会话设置：",
      this.#formatModel(conversationKey),
      this.#formatEffort(conversationKey),
      this.#formatServiceTier(conversationKey),
      this.#formatProject(conversationKey),
      `后端：${this.#backendName}`,
      "",
      "命令：/project、/model、/model list、/effort、/speed、/settings reset",
    ].join("\n");
  }

  #formatModel(conversationKey: string): string {
    const model = this.#settings.get(conversationKey).model;
    return `模型：${model ?? this.#defaultModel}（${model ? "会话设置" : "默认"}）`;
  }

  #formatEffort(conversationKey: string): string {
    const effort = this.#settings.get(conversationKey).modelReasoningEffort;
    return `推理强度：${effort ?? this.#defaultReasoningEffort}（${effort ? "会话设置" : "默认"}）`;
  }

  #formatServiceTier(conversationKey: string): string {
    const serviceTier = this.#settings.get(conversationKey).serviceTier;
    return `服务等级：${serviceTier ?? this.#defaultServiceTier}（${serviceTier ? "会话设置" : "默认"}）`;
  }

  #formatProject(conversationKey: string): string {
    const project = this.settings(conversationKey);
    if (project.projectUnavailable) {
      return `项目：${project.projectName}（不可用）\n原目录：${project.projectUnavailable}\n请使用 /project 新项目名 或 /project default 恢复。`;
    }
    return `项目：${project.projectName}（${project.projectIsDefault ? "默认" : "会话设置"}）\n目录：${project.workingDirectory}`;
  }
}

export class CodexSdkBackend implements AgentBackend {
  readonly name = "sdk";
  readonly #codexByTier = new Map<ServiceTier, Codex>();
  readonly #threads: ThreadStore;
  readonly #support: ConversationAgentSupport;
  readonly #baseThreadOptions: ThreadOptions;
  readonly #timeoutMs: number;
  readonly #codexPath?: string;

  constructor(config: GatewayConfig) {
    this.#codexPath = config.codex.codexPath;
    this.#codexByTier.set(
      config.codex.serviceTier,
      new Codex({
        codexPathOverride: config.codex.codexPath,
        config: { service_tier: config.codex.serviceTier },
      }),
    );
    this.#threads = new ThreadStore(config.stateDir);
    this.#support = new ConversationAgentSupport(config, this.name);
    this.#baseThreadOptions = {
      workingDirectory: config.codex.workingDirectory,
      skipGitRepoCheck: true,
      sandboxMode: config.codex.sandboxMode,
      approvalPolicy: config.codex.approvalPolicy,
      networkAccessEnabled: config.codex.networkAccessEnabled,
      additionalDirectories: [
        path.join(config.stateDir, "media"),
        ...config.codex.additionalDirectories,
      ],
    };
    this.#timeoutMs = config.codex.turnTimeoutMs;
  }

  handleControlCommand(request: AgentRequest): string | undefined {
    if (request.mediaPath) return undefined;
    return this.#support.handleControlCommand(request.conversationKey, request.text);
  }

  snapshotSettings(conversationKey: string): ResolvedConversationSettings {
    return this.#support.settings(conversationKey);
  }

  async respond(request: AgentRequest): Promise<string> {
    const commandResponse = request.settings ? undefined : this.handleControlCommand(request);
    if (commandResponse !== undefined) return commandResponse;

    const settings = this.#support.resolveSettings(request.conversationKey, request.settings);
    const threadOptions: ThreadOptions = {
      ...this.#baseThreadOptions,
      workingDirectory: settings.workingDirectory,
      model: settings.model,
      modelReasoningEffort: settings.modelReasoningEffort,
    };
    const threadKey = this.#support.threadKey(
      request.conversationKey,
      settings.workingDirectory,
    );
    const existingId = this.#threads.get(threadKey);
    const codex = this.#codexForTier(settings.serviceTier);
    const thread = existingId
      ? codex.resumeThread(existingId, threadOptions)
      : codex.startThread(threadOptions);
    request.onProgress?.("thread-ready");

    const body = this.#support.prompt(request, settings);
    const input: Input = request.mediaPath && request.mediaType?.startsWith("image/")
      ? [
          { type: "text", text: body },
          { type: "local_image", path: request.mediaPath },
        ]
      : body;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      request.onProgress?.("turn-started");
      const turn = await thread.run(input, { signal: controller.signal });
      if (thread.id) this.#threads.set(threadKey, thread.id);
      const response = turn.finalResponse.trim();
      if (!response) throw new Error("Codex returned an empty response");
      request.onProgress?.("completed");
      return response;
    } catch (error) {
      logger.error(
        `codex SDK turn failed conversation=${request.conversationKey} error=${String(error)}`,
      );
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  #codexForTier(serviceTier: ServiceTier): Codex {
    let codex = this.#codexByTier.get(serviceTier);
    if (!codex) {
      codex = new Codex({
        codexPathOverride: this.#codexPath,
        config: { service_tier: serviceTier },
      });
      this.#codexByTier.set(serviceTier, codex);
    }
    return codex;
  }
}

function isModelReasoningEffort(value: string): value is ModelReasoningEffort {
  return ["minimal", "low", "medium", "high", "xhigh"].includes(value);
}
