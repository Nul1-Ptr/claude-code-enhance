'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_LOCK_STALE_MS = 5 * 60 * 1000;
const LOCK_POLL_MS = 25;
const heldLocks = new Map();

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function temporaryPath(target) {
  const suffix = `${process.pid}-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
  return path.join(path.dirname(target), `.${path.basename(target)}.claude-enhance-${suffix}.tmp`);
}

function writeAndSync(file, content, mode) {
  const descriptor = fs.openSync(file, 'wx', mode);
  try {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
    let offset = 0;
    while (offset < data.length) offset += fs.writeSync(descriptor, data, offset, data.length - offset);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function syncParentDirectory(target) {
  let descriptor;
  try {
    descriptor = fs.openSync(path.dirname(target), 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EPERM'].includes(error.code)) throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function atomicWriteFileSync(target, content) {
  const mode = fs.existsSync(target) ? fs.statSync(target).mode : 0o644;
  const temporary = temporaryPath(target);
  try {
    writeAndSync(temporary, content, mode);
    fs.renameSync(temporary, target);
    syncParentDirectory(target);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function transactionalWriteFilesSync(entries, verify) {
  const originals = new Map();
  const temporaryFiles = new Map();
  const committed = [];

  try {
    for (const entry of entries) {
      originals.set(entry.path, fs.existsSync(entry.path) ? fs.readFileSync(entry.path) : null);
      const mode = fs.existsSync(entry.path) ? fs.statSync(entry.path).mode : 0o644;
      const temporary = temporaryPath(entry.path);
      writeAndSync(temporary, entry.content, mode);
      temporaryFiles.set(entry.path, temporary);
    }

    if (typeof verify === 'function') verify(temporaryFiles);

    for (const entry of entries) {
      fs.renameSync(temporaryFiles.get(entry.path), entry.path);
      temporaryFiles.delete(entry.path);
      committed.push(entry.path);
    }
    Array.from(new Set(entries.map((entry) => path.dirname(entry.path))))
      .forEach((directory) => syncParentDirectory(path.join(directory, '.')));
  } catch (error) {
    let rollbackError = null;
    for (const target of committed.reverse()) {
      const original = originals.get(target);
      try {
        if (original === null) fs.rmSync(target, { force: true });
        else atomicWriteFileSync(target, original);
      } catch (failure) {
        rollbackError = rollbackError || failure;
      }
    }
    if (rollbackError) error.rollbackError = rollbackError;
    throw error;
  } finally {
    for (const temporary of temporaryFiles.values()) {
      fs.rmSync(temporary, { force: true });
    }
  }
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  atomicWriteFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function sleepSync(milliseconds) {
  const delay = Math.max(1, Number(milliseconds) || 1);
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, delay);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    return null;
  }
}

function ownerIsDead(metadata) {
  return !!metadata && (!metadata.hostname || metadata.hostname === os.hostname()) &&
    processIsAlive(Number(metadata.pid)) === false;
}

function inspectLock(lockPath, staleMs) {
  try {
    const stat = fs.lstatSync(lockPath);
    if (!stat.isDirectory()) {
      return { stat, stale: stat.isFile() && ownerIsDead(readJsonFile(lockPath)), owners: [] };
    }
    const owners = fs.readdirSync(lockPath);
    const stale = owners.length
      ? owners.every((name) => /^owner-[a-f0-9]+\.json$/.test(name) &&
          ownerIsDead(readJsonFile(path.join(lockPath, name))))
      : Date.now() - stat.mtimeMs > staleMs;
    return { stat, stale, owners };
  } catch (error) {
    if (error.code === 'ENOENT') return { stat: null, stale: true, owners: [] };
    throw error;
  }
}

function isStaleLock(lockPath, staleMs = DEFAULT_LOCK_STALE_MS) {
  return inspectLock(lockPath, staleMs).stale;
}

function removeEmptyLock(lockPath) {
  try { fs.rmdirSync(lockPath); }
  catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'ENOTDIR'].includes(error.code)) throw error;
  }
}

function reclaimLock(lockPath, snapshot) {
  if (!snapshot.stale || !snapshot.stat) return;
  if (!snapshot.stat.isDirectory()) {
    try { fs.unlinkSync(lockPath); }
    catch (error) {
      if (!['ENOENT', 'EISDIR', 'EPERM'].includes(error.code)) throw error;
    }
    return;
  }
  for (const name of snapshot.owners) {
    try { fs.unlinkSync(path.join(lockPath, name)); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    }
  }
  removeEmptyLock(lockPath);
}

function releaseHandle(lockPath, entry) {
  let released = false;
  return () => {
    if (released || heldLocks.get(lockPath) !== entry) return;
    released = true;
    if (--entry.depth > 0) return;
    heldLocks.delete(lockPath);
    try { fs.unlinkSync(entry.ownerPath); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    removeEmptyLock(lockPath);
    syncParentDirectory(lockPath);
  };
}

function acquireFileLockSync(lockPath, options = {}) {
  const normalizedPath = path.resolve(lockPath);
  const held = heldLocks.get(normalizedPath);
  if (held) {
    held.depth++;
    return releaseHandle(normalizedPath, held);
  }

  const timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  const staleMs = Math.max(1000, options.staleMs ?? DEFAULT_LOCK_STALE_MS);
  const deadline = Date.now() + timeoutMs;
  fs.mkdirSync(path.dirname(normalizedPath), { recursive: true });
  const token = crypto.randomBytes(12).toString('hex');
  const ownerName = `owner-${token}.json`;
  const preparedDirectory = temporaryPath(normalizedPath);
  try {
    fs.mkdirSync(preparedDirectory, { mode: 0o700 });
    writeAndSync(path.join(preparedDirectory, ownerName), JSON.stringify({
      pid: process.pid,
      hostname: os.hostname(),
      createdAt: new Date().toISOString(),
      token,
    }) + '\n', 0o600);
    while (true) {
      try {
        fs.renameSync(preparedDirectory, normalizedPath);
        const entry = { depth: 1, ownerPath: path.join(normalizedPath, ownerName), token };
        heldLocks.set(normalizedPath, entry);
        return releaseHandle(normalizedPath, entry);
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR', 'EPERM'].includes(error.code)) throw error;
        const snapshot = inspectLock(normalizedPath, staleMs);
        if (!snapshot.stat && error.code === 'EPERM') throw error;
        if (snapshot.stale) {
          reclaimLock(normalizedPath, snapshot);
          if (!fs.existsSync(normalizedPath)) continue;
        }
        if (Date.now() >= deadline) {
          const lockError = new Error(`Timed out waiting for file lock: ${normalizedPath}`);
          lockError.code = 'CLAUDE_ENHANCE_LOCK_TIMEOUT';
          throw lockError;
        }
        sleepSync(Math.min(LOCK_POLL_MS, Math.max(1, deadline - Date.now())));
      }
    }
  } finally {
    fs.rmSync(preparedDirectory, { recursive: true, force: true });
  }
}

function withFileLockSync(lockPath, callback, options = {}) {
  const release = acquireFileLockSync(lockPath, options);
  try {
    return callback();
  } finally {
    release();
  }
}

module.exports = {
  DEFAULT_LOCK_STALE_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  sha256,
  atomicWriteFileSync,
  transactionalWriteFilesSync,
  readJsonFile,
  writeJsonAtomic,
  acquireFileLockSync,
  isStaleLock,
  withFileLockSync,
};
