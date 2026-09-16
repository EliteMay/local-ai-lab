import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, resolve, sep, relative } from "node:path";

function isInside(root, target) {
  return target === root || target.startsWith(`${root}${sep}`);
}

const DEFAULT_BLOCKED_FILE_NAMES = new Set([
  ".npmrc",
  ".pypirc",
  ".netrc",
  "credentials",
  "credentials.json",
  "service-account.json",
  "id_rsa",
  "id_ed25519"
]);

const DEFAULT_BLOCKED_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".jks"]);
const ENV_TEMPLATE_NAMES = new Set([".env.example", ".env.sample", ".env.template"]);

function isBlockedEnvironmentFile(name) {
  const lower = name.toLowerCase();
  if (ENV_TEMPLATE_NAMES.has(lower)) return false;
  return lower === ".env" || lower.startsWith(".env.");
}

export class RepoReader {
  constructor(rootPath, options = {}) {
    if (typeof rootPath !== "string" || rootPath.trim() === "") {
      throw new Error("rootPath is required");
    }

    this.root = resolve(rootPath);
    this.maxFiles = options.maxFiles ?? 5000;
    this.maxFileBytes = options.maxFileBytes ?? 262144;
    this.excludedDirectories = new Set(options.excludedDirectories ?? [".git", "node_modules", "runtime-data", "dist", "build"]);
    this.blockedFileNames = new Set(options.blockedFileNames ?? DEFAULT_BLOCKED_FILE_NAMES);
    this.blockedExtensions = new Set(options.blockedExtensions ?? DEFAULT_BLOCKED_EXTENSIONS);
  }

  #resolve(relativePath = ".") {
    const target = resolve(this.root, relativePath);
    if (!isInside(this.root, target)) {
      throw new Error("Path escapes repository root");
    }
    return target;
  }

  #isBlocked(relativePath) {
    const name = basename(relativePath).toLowerCase();
    const extension = extname(name).toLowerCase();
    return isBlockedEnvironmentFile(name) || this.blockedFileNames.has(name) || this.blockedExtensions.has(extension);
  }

  async assertRepositoryExists() {
    const info = await stat(this.root);
    if (!info.isDirectory()) {
      throw new Error("Repository root is not a directory");
    }
    return true;
  }

  async listFilesDetailed() {
    await this.assertRepositoryExists();
    const files = [];
    let truncated = false;

    const walk = async (directory) => {
      if (truncated) return;
      const entries = await readdir(directory, { withFileTypes: true });

      for (const entry of entries) {
        if (truncated) break;
        if (entry.isSymbolicLink()) {
          continue;
        }
        if (entry.isDirectory() && this.excludedDirectories.has(entry.name)) {
          continue;
        }

        const absolute = resolve(directory, entry.name);
        if (!isInside(this.root, absolute)) {
          continue;
        }

        if (entry.isDirectory()) {
          await walk(absolute);
        } else if (entry.isFile()) {
          const relativePath = relative(this.root, absolute).split(sep).join("/");
          if (this.#isBlocked(relativePath)) {
            continue;
          }
          if (files.length >= this.maxFiles) {
            truncated = true;
            break;
          }
          files.push(relativePath);
        }
      }
    };

    await walk(this.root);
    files.sort((a, b) => a.localeCompare(b));
    return { files, truncated };
  }

  async listFiles() {
    const inventory = await this.listFilesDetailed();
    return inventory.files;
  }

  async readTextFile(relativePath) {
    if (this.#isBlocked(relativePath)) {
      throw new Error(`Sensitive file blocked: ${relativePath}`);
    }

    const absolute = this.#resolve(relativePath);
    const info = await lstat(absolute);

    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error("Only regular files can be read");
    }
    if (info.size > this.maxFileBytes) {
      throw new Error(`File exceeds read limit: ${relativePath}`);
    }

    const buffer = await readFile(absolute);
    if (buffer.includes(0)) {
      throw new Error(`Binary file rejected: ${relativePath}`);
    }
    return buffer.toString("utf8");
  }

  async searchText(query, { maxResults = 50 } = {}) {
    if (typeof query !== "string" || query.trim() === "") {
      throw new Error("query is required");
    }

    const needle = query.toLowerCase();
    const results = [];
    const files = await this.listFiles();

    for (const file of files) {
      if (results.length >= maxResults) {
        break;
      }
      try {
        const text = await this.readTextFile(file);
        const lines = text.split(/\r?\n/);
        for (let index = 0; index < lines.length && results.length < maxResults; index += 1) {
          if (lines[index].toLowerCase().includes(needle)) {
            results.push({ file, line: index + 1, text: lines[index].trim() });
          }
        }
      } catch {
        // Oversized, binary, sensitive, and unreadable files are intentionally ignored.
      }
    }

    return results;
  }
}
