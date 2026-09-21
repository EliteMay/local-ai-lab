import { access, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function durableWrite(path, content) {
  const handle = await open(path, "w");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function backupPathFor(path) {
  return path + ".backup";
}

export async function atomicWriteText(path, content, { backup = true, backupPath: customBackupPath = null } = {}) {
  const target = String(path);
  const backupPath = customBackupPath || backupPathFor(target);
  const tempPath = target + ".tmp-" + process.pid + "-" + randomUUID();
  await mkdir(dirname(target), { recursive: true });
  await durableWrite(tempPath, String(content));

  let movedOriginal = false;
  try {
    if (backup && await exists(target)) {
      await rm(backupPath, { force: true });
      await rename(target, backupPath);
      movedOriginal = true;
    } else if (!backup) {
      await rm(target, { force: true });
    }

    await rename(tempPath, target);
  } catch (error) {
    if (movedOriginal && !(await exists(target)) && await exists(backupPath)) {
      try { await rename(backupPath, target); } catch {}
    }
    throw error;
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

export async function atomicWriteJson(path, value, options = {}) {
  await atomicWriteText(path, JSON.stringify(value, null, 2) + "\n", options);
}

async function restoreBackup(target, backupPath, text) {
  const tempPath = target + ".restore-" + process.pid + "-" + randomUUID();
  try {
    await durableWrite(tempPath, text);
    await rm(target, { force: true });
    await rename(tempPath, target);
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

export async function readTextWithBackup(path, encoding = "utf8", { backupPath: customBackupPath = null } = {}) {
  const target = String(path);
  try {
    return await readFile(target, encoding);
  } catch (primaryError) {
    const backupPath = customBackupPath || backupPathFor(target);
    try {
      const backupText = await readFile(backupPath, encoding);
      await restoreBackup(target, backupPath, backupText);
      return backupText;
    } catch {
      throw primaryError;
    }
  }
}

export async function readJsonWithBackup(path, { backupPath: customBackupPath = null } = {}) {
  const target = String(path);
  try {
    return JSON.parse(await readFile(target, "utf8"));
  } catch (primaryError) {
    const backupPath = customBackupPath || backupPathFor(target);
    try {
      const backupText = await readFile(backupPath, "utf8");
      const value = JSON.parse(backupText);
      await restoreBackup(target, backupPath, backupText);
      return value;
    } catch {
      throw primaryError;
    }
  }
}
