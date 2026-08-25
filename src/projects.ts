import crypto from "node:crypto";
import fs from "node:fs";
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
  matchCount: number;
  error?: "invalid-name" | "not-found" | "ambiguous";
};

export class ProjectDirectoryResolver {
  readonly #defaultProject: ProjectDirectory;
  readonly #roots: string[];
  readonly #catalog: Map<string, ProjectDirectory[]>;

  constructor(defaultWorkingDirectory: string, projectRoots: string[]) {
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
  }

  defaultProject(): ProjectDirectory {
    return { ...this.#defaultProject };
  }

  validate(projectPath: string | undefined): ProjectDirectory | undefined {
    if (!projectPath) return undefined;
    const canonical = canonicalDirectory(projectPath);
    if (!canonical) return undefined;
    if (!samePath(canonical, this.#defaultProject.path)) {
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
    if (ordered.length > 1) return { matchCount: ordered.length, error: "ambiguous" };
    return { project: { ...ordered[0] }, matchCount: 1 };
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
