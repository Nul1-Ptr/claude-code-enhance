'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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

module.exports = {
  sha256,
  atomicWriteFileSync,
  transactionalWriteFilesSync,
  readJsonFile,
  writeJsonAtomic,
};
