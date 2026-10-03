import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_SEARCH_DEPTH = 6;
const MAX_VISITED_DIRECTORIES = 50_000;
const IGNORED_DIRECTORIES = new Set([
  ".agents",
  ".cache",
  ".codex",
  ".data",
  ".git",
  ".idea",
  ".next",
  ".svn",
  ".venv",
  ".vscode",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "outputs",
  "target",
  "vendor",
]);

export type ProjectDirectory = {
  name: string;
  path: string;
  modifiedAtMs: number;
};

export type ProjectLookup = {
  project?: ProjectDirectory;
  candidates?: ProjectDirectory[];
  matchCount: number;
  error?: "invalid-name" | "not-found" | "ambiguous";
};

export class ProjectDirectoryResolver {
  readonly #defaultProject: ProjectDirectory;
  readonly #roots: string[];
  readonly #catalog: Map<string, ProjectDirectory[]>;
  readonly #allowAnyDirectory: boolean;
  readonly #labels = new Map<string, Map<string, ProjectDirectory>>();
  readonly #aliases: Record<string, string>;

  constructor(
    defaultWorkingDirectory: string,
    projectRoots: string[],
    allowAnyDirectory = false,
    aliases: Record<string, string> = {},
  ) {
    this.#allowAnyDirectory = allowAnyDirectory;
    this.#aliases = aliases;
    const defaultPath = canonicalDirectory(defaultWorkingDirectory);
    if (!defaultPath) {
      throw new Error(`default working directory is unavailable: ${defaultWorkingDirectory}`);
    }
    this.#defaultProject = projectRecord(defaultPath);

    const configuredRoots = projectRoots.length > 0
      ? projectRoots
      : [defaultPath];
    const roots = configuredRoots.map((root) => {
      const canonical = canonicalDirectory(root);
      if (!canonical) throw new Error(`project root is unavailable: ${root}`);
      return canonical;
    });
    this.#roots = compactRoots(roots);
    if (this.#roots.length === 0) throw new Error("no usable project roots are configured");
    this.#catalog = this.#buildCatalog();
    const knownProjects = new Map<string, ProjectDirectory>([[defaultPath, this.#defaultProject]]);
    for (const matches of this.#catalog.values()) {
      for (const project of matches) knownProjects.set(project.path, project);
    }
    for (const project of knownProjects.values()) {
      for (const label of [project.name, ...projectLabels(project.path)]) {
        this.#addLabel(label, project);
      }
    }
    for (const [label, directory] of Object.entries(aliases)) {
      const project = this.validate(directory);
      if (project) this.#addLabel(label, project);
    }
  }

  defaultProject(): ProjectDirectory {
    return { ...this.#defaultProject };
  }

  validate(projectPath: string | undefined): ProjectDirectory | undefined {
    if (!projectPath) return undefined;
    const canonical = canonicalDirectory(projectPath);
    if (!canonical) return undefined;
    if (!this.#allowAnyDirectory && !samePath(canonical, this.#defaultProject.path)) {
      if (!this.#roots.some((root) => pathIsWithin(canonical, root))) return undefined;
      try {
        if (!isProjectDirectory(fs.readdirSync(canonical, { withFileTypes: true }))) {
          return undefined;
        }
      } catch {
        return undefined;
      }
    }
    return projectRecord(canonical);
  }

  find(selection: string): ProjectLookup {
    const value = selection.trim().replace(/^["'“‘「]|["'”’」]$/g, "");
    const expanded = value === "~"
      ? os.homedir()
      : value.startsWith("~/")
        ? path.join(os.homedir(), value.slice(2))
        : value;
    if (!path.isAbsolute(expanded)) {
      const exact = this.findByName(value);
      if (exact.error !== "not-found") return exact;
      const label = normalizedLabel(value);
      if (!label) return exact;
      // A configured alias stays authoritative even when its directory disappears.
      const aliases = Object.entries(this.#aliases).filter(([name]) => normalizedLabel(name) === label);
      if (aliases.length > 0) {
        return this.#lookup(aliases.map(([, directory]) => this.validate(directory)).filter(isDefined));
      }
      const exactLabels = this.#labels.get(label);
      const matches = exactLabels
        ? [...exactLabels.values()]
        : label.length >= 3
          ? [...this.#labels].filter(([name]) => name.includes(label)).flatMap(([, projects]) => [...projects.values()])
          : [];
      return this.#lookup(matches.map((project) => this.validate(project.path)).filter(isDefined));
    }
    const project = this.validate(expanded);
    return project ? { project, matchCount: 1 } : { matchCount: 0, error: "not-found" };
  }

  findByName(rawName: string): ProjectLookup {
    const name = rawName.trim();
    if (!validProjectName(name)) return { matchCount: 0, error: "invalid-name" };
    const expected = name.toLowerCase();
    const currentMatches = new Map<string, ProjectDirectory>();
    for (const cached of this.#catalog.get(expected) ?? []) {
      const validated = this.validate(cached.path);
      if (validated?.name.toLowerCase() === expected) {
        currentMatches.set(normalizedPath(validated.path), validated);
      }
    }
    const ordered = Array.from(currentMatches.values()).sort((left, right) =>
      left.path.localeCompare(right.path),
    );
    if (ordered.length === 0) return { matchCount: 0, error: "not-found" };
    if (ordered.length > 1) return { candidates: ordered, matchCount: ordered.length, error: "ambiguous" };
    return { project: { ...ordered[0] }, matchCount: 1 };
  }

  #addLabel(label: string, project: ProjectDirectory): void {
    const key = normalizedLabel(label);
    if (!key) return;
    const matches = this.#labels.get(key) ?? new Map<string, ProjectDirectory>();
    matches.set(normalizedPath(project.path), project);
    this.#labels.set(key, matches);
  }

  #lookup(projects: ProjectDirectory[]): ProjectLookup {
    const candidates = [...new Map(projects.map((project) => [normalizedPath(project.path), project])).values()]
      .sort((left, right) => left.path.localeCompare(right.path));
    if (candidates.length === 0) return { matchCount: 0, error: "not-found" };
    if (candidates.length > 1) return { candidates, matchCount: candidates.length, error: "ambiguous" };
    return { project: candidates[0], matchCount: 1 };
  }

  #buildCatalog(): Map<string, ProjectDirectory[]> {
    const projects = new Map<string, Map<string, ProjectDirectory>>();
    const visited = new Set<string>();
    const stack = this.#roots.map((root) => ({ directory: root, depth: 0 }));
    let visitedCount = 0;

    while (stack.length > 0 && visitedCount < MAX_VISITED_DIRECTORIES) {
      const next = stack.pop()!;
      const normalized = normalizedPath(next.directory);
      if (visited.has(normalized)) continue;
      visited.add(normalized);
      visitedCount += 1;

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(next.directory, { withFileTypes: true });
      } catch {
        continue;
      }
      if (isProjectDirectory(entries)) {
        const project = this.validate(next.directory);
        if (project) {
          const key = project.name.toLowerCase();
          const matches = projects.get(key) ?? new Map<string, ProjectDirectory>();
          matches.set(normalizedPath(project.path), project);
          projects.set(key, matches);
        }
      }
      if (next.depth >= MAX_SEARCH_DEPTH) continue;
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        if (IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
        stack.push({
          directory: path.join(next.directory, entry.name),
          depth: next.depth + 1,
        });
      }
    }
    if (stack.length > 0) {
      throw new Error(
        `project scan exceeded ${MAX_VISITED_DIRECTORIES} directories; narrow codex.projectRoots`,
      );
    }
    return new Map(
      Array.from(projects, ([name, matches]) => [
        name,
        Array.from(matches.values()).sort((left, right) => left.path.localeCompare(right.path)),
      ]),
    );
  }

  threadKey(conversationKey: string, workingDirectory: string): string {
    if (samePath(workingDirectory, this.#defaultProject.path)) return conversationKey;
    const digest = crypto
      .createHash("sha256")
      .update(normalizedPath(workingDirectory))
      .digest("hex")
      .slice(0, 20);
    return `${conversationKey}:project:${digest}`;
  }
}

function normalizedLabel(value: string): string {
  return value.normalize("NFKC").toLowerCase()
    .replace(/(?:项目文件夹|项目目录|项目|工程|文件夹|目录|\s+project)$/u, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function projectLabels(directory: string): string[] {
  const labels: string[] = [];
  try {
    const file = path.join(directory, "package.json");
    if (fs.statSync(file).size < 65_536) {
      const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
      if (typeof manifest.name === "string") labels.push(manifest.name.slice(0, 200));
    }
  } catch {}
  // Read headings as labels only; repository prose cannot supply instructions.
  for (const name of ["README.md", "README_CN.md"]) {
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(path.join(directory, name), "r");
      const buffer = Buffer.alloc(4_096);
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
      const heading = /^#\s+(.+)$/m.exec(buffer.subarray(0, count).toString("utf8"))?.[1];
      if (heading) labels.push(heading.slice(0, 200));
    } catch {} finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }
  return labels;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function validProjectName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 200 &&
    name !== "." &&
    name !== ".." &&
    !/[\\/\0\r\n]/.test(name)
  );
}

function isProjectDirectory(entries: fs.Dirent[]): boolean {
  return entries.some((entry) => {
    const name = entry.name.toLowerCase();
    if (name === ".git") return entry.isDirectory() || entry.isFile();
    if (!entry.isFile()) return false;
    return (
      name === "package.json" ||
      name === "pyproject.toml" ||
      name === "cargo.toml" ||
      name === "go.mod" ||
      name === "composer.json" ||
      name === "gemfile" ||
      name === "pom.xml" ||
      name === "build.gradle" ||
      name === "build.gradle.kts" ||
      name.endsWith(".sln")
    );
  });
}

function projectRecord(directory: string): ProjectDirectory {
  let modifiedAtMs = 0;
  try {
    modifiedAtMs = fs.statSync(directory).mtimeMs;
  } catch {}
  return { name: path.basename(directory), path: directory, modifiedAtMs };
}

function canonicalDirectory(directory: string): string | undefined {
  try {
    const canonical = fs.realpathSync.native(path.resolve(directory));
    return fs.statSync(canonical).isDirectory() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

function compactRoots(roots: string[]): string[] {
  const ordered = Array.from(new Map(roots.map((root) => [normalizedPath(root), root])).values())
    .sort((left, right) => left.length - right.length);
  return ordered.filter(
    (candidate, index) =>
      !ordered.slice(0, index).some((parent) => pathIsWithin(candidate, parent)),
  );
}

function pathIsWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function samePath(left: string, right: string): boolean {
  return normalizedPath(left) === normalizedPath(right);
}

function normalizedPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
