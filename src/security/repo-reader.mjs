import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { resolve, sep, relative } from "node:path";

function isInside(root, target) {
  return target === root || target.startsWith(`${root}${sep}`);
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
  }

  #resolve(relativePath = ".") {
    const target = resolve(this.root, relativePath);
    if (!isInside(this.root, target)) {
      throw new Error("Path escapes repository root");
    }
    return target;
  }

  async assertRepositoryExists() {
    const info = await stat(this.root);
    if (!info.isDirectory()) {
      throw new Error("Repository root is not a directory");
    }
    return true;
  }

  async listFiles() {
    await this.assertRepositoryExists();
    const files = [];

    const walk = async (directory) => {
      if (files.length >= this.maxFiles) {
        return;
      }

      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (files.length >= this.maxFiles) {
          break;
        }
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
          files.push(relative(this.root, absolute).split(sep).join("/"));
        }
      }
    };

    await walk(this.root);
    return files;
  }

  async readTextFile(relativePath) {
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
        // Oversized and binary files are intentionally ignored during text search.
      }
    }

    return results;
  }
}
