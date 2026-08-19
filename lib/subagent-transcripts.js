'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_METADATA_BYTES = 256 * 1024;
const ACTIVE_WINDOW_MS = 30 * 1000;
const descriptorCache = new Map();
const sessionCache = new Map();

function defaultProjectsRoot() {
  return path.join(os.homedir(), '.claude', 'projects');
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function safeReadDir(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readBoundedRecords(filePath, fromEnd = false) {
  const stat = safeStat(filePath);
  if (!stat?.isFile() || stat.size === 0) return [];

  let descriptor;
  try {
    descriptor = fs.openSync(filePath, 'r');
    const bytesToRead = Math.min(stat.size, MAX_METADATA_BYTES);
    const start = fromEnd ? stat.size - bytesToRead : 0;
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const bytes = fs.readSync(descriptor, buffer, 0, bytesToRead, start);
    let source = buffer.toString('utf8', 0, bytes);

    if (start > 0) {
      const firstNewline = source.indexOf('\n');
      source = firstNewline === -1 ? '' : source.slice(firstNewline + 1);
    }
    if (!fromEnd && bytes < stat.size) {
      const lastNewline = source.lastIndexOf('\n');
      source = lastNewline === -1 ? '' : source.slice(0, lastNewline);
    }

    const records = [];
    for (const line of source.split(/\r?\n/)) {
      if (!line) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // A bounded read can end inside a JSON record. Metadata discovery is
        // best-effort; complete transcript reads report malformed lines.
      }
    }
    return records;
  } catch {
    return [];
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function textParts(value) {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((part) => {
    if (typeof part === 'string') return [part];
    if (part?.type === 'text' && typeof part.text === 'string') return [part.text];
    if (part?.type === 'thinking' && typeof part.thinking === 'string') return [part.thinking];
    if (typeof part?.content === 'string') return [part.content];
    return [];
  });
}

function firstText(value) {
  return textParts(value).find((text) => text.trim()) || '';
}

function compactLabel(text, length = 96) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  if (compact.length <= length) return compact;
  return compact.slice(0, Math.max(0, length - 3)) + '...';
}

function firstUserPrompt(records) {
  for (const record of records) {
    if (record?.message?.role !== 'user') continue;
    const text = firstText(record.message.content);
    if (text) return text;
  }
  return '';
}

function firstWorkingDirectory(records) {
  return records.find((record) => typeof record?.cwd === 'string' && record.cwd)?.cwd || '';
}

function firstAgentType(records) {
  return records.find((record) => typeof record?.attributionAgent === 'string')?.attributionAgent || '';
}

function transcriptStatus(lastRecord, mtimeMs, now = Date.now()) {
  const blocks = Array.isArray(lastRecord?.message?.content) ? lastRecord.message.content : [];
  if (lastRecord?.error || blocks.some((block) => block?.is_error)) return 'failed';
  if (lastRecord?.message?.stop_reason === 'end_turn') return 'completed';
  if (now - mtimeMs <= ACTIVE_WINDOW_MS) return 'active';
  if (lastRecord?.message?.stop_reason) return 'stopped';
  return 'idle';
}

function sessionMetadata(projectPath, projectId, sessionId) {
  const parentPath = path.join(projectPath, sessionId + '.jsonl');
  const cached = sessionCache.get(parentPath);
  if (cached?.complete) return cached.metadata;

  const stat = safeStat(parentPath);
  const cacheKey = stat ? `${stat.size}:${stat.mtimeMs}` : 'missing';
  if (cached?.cacheKey === cacheKey) return cached.metadata;

  const records = readBoundedRecords(parentPath);
  const cwd = firstWorkingDirectory(records);
  const projectLabel = cwd ? path.basename(cwd) : projectId;
  const prompt = firstUserPrompt(records);
  const metadata = {
    parentPath,
    projectPath: cwd,
    projectLabel,
    sessionLabel: compactLabel(prompt, 80) || sessionId,
    sessionPrompt: prompt,
  };
  sessionCache.set(parentPath, {
    cacheKey,
    complete: !!cwd && !!prompt,
    metadata,
  });
  return metadata;
}

function descriptorFromFile(filePath, projectId, sessionId, session) {
  const stat = safeStat(filePath);
  if (!stat?.isFile()) return null;
  const agentFile = path.basename(filePath);
  if (!/^agent-.+\.jsonl$/.test(agentFile)) return null;

  const cacheKey = `${stat.size}:${stat.mtimeMs}`;
  const cached = descriptorCache.get(filePath);
  if (cached?.cacheKey === cacheKey) {
    if (cached.descriptor.status === 'active' && Date.now() - stat.mtimeMs > ACTIVE_WINDOW_MS) {
      cached.descriptor = { ...cached.descriptor, status: 'idle' };
    }
    return cached.descriptor;
  }

  const agentId = agentFile.replace(/^agent-/, '').replace(/\.jsonl$/, '');
  const previous = cached?.descriptor;
  const firstRecords = previous ? [] : readBoundedRecords(filePath);
  const lastRecords = !previous && stat.size <= MAX_METADATA_BYTES
    ? firstRecords
    : readBoundedRecords(filePath, true);
  const lastRecord = lastRecords.at(-1) || firstRecords.at(-1) || null;
  const prompt = previous?.prompt || firstUserPrompt(firstRecords) || firstUserPrompt(lastRecords);
  const cwd = previous?.projectPath || firstWorkingDirectory(firstRecords) ||
    firstWorkingDirectory(lastRecords) || session.projectPath;
  const agentType = previous?.agentType || firstAgentType(firstRecords) || firstAgentType(lastRecords);
  const descriptor = {
    filePath,
    parentPath: session.parentPath,
    projectId,
    projectPath: cwd,
    projectLabel: cwd ? path.basename(cwd) : session.projectLabel,
    sessionId,
    sessionLabel: session.sessionLabel,
    sessionPrompt: session.sessionPrompt,
    agentId,
    agentType,
    label: compactLabel(prompt, 88) || `agent-${agentId.slice(0, 12)}`,
    prompt,
    status: transcriptStatus(lastRecord, stat.mtimeMs),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
  descriptorCache.set(filePath, { cacheKey, descriptor });
  return descriptor;
}

function findSubagentFiles(projectsRoot = defaultProjectsRoot(), options = {}) {
  const rootStat = safeStat(projectsRoot);
  if (!rootStat?.isDirectory()) return [];

  const descriptors = [];
  const seen = new Set();
  const seenSessions = new Set();
  let selectedProjectIds = options.projectIds
    ? new Set(Array.from(options.projectIds, String).filter((id) => id && path.basename(id) === id))
    : null;
  if (selectedProjectIds && options.includeDescendants) {
    const roots = Array.from(selectedProjectIds);
    for (const entry of safeReadDir(projectsRoot)) {
      if (entry.isDirectory() && roots.some((id) => entry.name.startsWith(id + '-'))) {
        selectedProjectIds.add(entry.name);
      }
    }
  }
  const projectEntries = selectedProjectIds
    ? Array.from(selectedProjectIds, (name) => ({ name, projectPath: path.join(projectsRoot, name) }))
        .filter((entry) => safeStat(entry.projectPath)?.isDirectory())
    : safeReadDir(projectsRoot)
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ name: entry.name, projectPath: path.join(projectsRoot, entry.name) }));

  for (const projectEntry of projectEntries) {
    const projectPath = projectEntry.projectPath;
    for (const sessionEntry of safeReadDir(projectPath)) {
      if (!sessionEntry.isDirectory()) continue;
      const subagentsPath = path.join(projectPath, sessionEntry.name, 'subagents');
      if (!safeStat(subagentsPath)?.isDirectory()) continue;
      const session = sessionMetadata(projectPath, projectEntry.name, sessionEntry.name);
      seenSessions.add(session.parentPath);
      for (const agentEntry of safeReadDir(subagentsPath)) {
        if (!agentEntry.isFile() || !/^agent-.+\.jsonl$/.test(agentEntry.name)) continue;
        const filePath = path.join(subagentsPath, agentEntry.name);
        const descriptor = descriptorFromFile(
          filePath,
          projectEntry.name,
          sessionEntry.name,
          session
        );
        if (descriptor) {
          seen.add(filePath);
          descriptors.push(descriptor);
        }
      }
    }
  }

  const cleanupPrefixes = selectedProjectIds
    ? Array.from(selectedProjectIds, (id) => path.join(projectsRoot, id) + path.sep)
    : [projectsRoot + path.sep];
  for (const filePath of descriptorCache.keys()) {
    if (!seen.has(filePath) && cleanupPrefixes.some((prefix) => filePath.startsWith(prefix))) {
      descriptorCache.delete(filePath);
    }
  }
  for (const parentPath of sessionCache.keys()) {
    if (!seenSessions.has(parentPath) && cleanupPrefixes.some((prefix) => parentPath.startsWith(prefix))) {
      sessionCache.delete(parentPath);
    }
  }
  return descriptors.sort((a, b) => b.mtimeMs - a.mtimeMs || a.filePath.localeCompare(b.filePath));
}

function jsonText(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function contentBlocks(value, kind = 'text', inherited = {}) {
  if (typeof value === 'string') {
    return value ? [{ kind, text: value, ...inherited }] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((part) => contentBlocks(part, kind, inherited));
  }
  if (!value || typeof value !== 'object') return [];

  if (value.type === 'text' && typeof value.text === 'string') {
    return contentBlocks(value.text, kind, inherited);
  }
  if (value.type === 'thinking' && typeof value.thinking === 'string') {
    return contentBlocks(value.thinking, 'thinking', inherited);
  }
  if (value.type === 'tool_use') {
    return [{
      kind: 'tool',
      name: value.name || 'tool',
      toolUseId: value.id || null,
      text: value.input === undefined ? '' : jsonText(value.input),
      ...inherited,
    }];
  }
  if (value.type === 'tool_result') {
    const metadata = {
      ...inherited,
      toolUseId: value.tool_use_id || null,
      isError: value.is_error === true,
    };
    const blocks = contentBlocks(value.content, 'tool-result', metadata);
    return blocks.length ? blocks : [{ kind: 'tool-result', text: '', ...metadata }];
  }
  if (value.type === 'image') {
    return [{ kind: 'attachment', text: 'Image attachment', ...inherited }];
  }
  if (typeof value.content === 'string' || Array.isArray(value.content)) {
    return contentBlocks(value.content, kind, inherited);
  }
  if (typeof value.text === 'string') return contentBlocks(value.text, kind, inherited);
  return [{ kind, text: jsonText(value), ...inherited }];
}

function roleForRecord(record, blocks) {
  if (blocks.length && blocks.every((block) => block.kind === 'tool-result')) return 'tool-result';
  if (record?.message?.role) return record.message.role;
  if (record?.type === 'assistant' || record?.type === 'user') return record.type;
  return record?.isSidechain ? 'sub-agent' : 'event';
}

function parseTranscriptBuffer(buffer, suppliedDescriptor, lineOffset = 0) {
  const source = buffer.toString('utf8');
  const sourceLines = source.split(/\r?\n/);
  const messages = [];
  let malformedLines = 0;
  let partialLine = false;

  sourceLines.forEach((line, index) => {
    if (!line) return;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      if (index === sourceLines.length - 1 && !source.endsWith('\n')) partialLine = true;
      else malformedLines++;
      return;
    }

    const blocks = contentBlocks(record.message?.content);
    if (!blocks.length && record.error) {
      blocks.push({ kind: 'api-error', text: String(record.error), isError: true });
    }
    if (!blocks.length) return;
    const lineNumber = lineOffset + index + 1;
    messages.push({
      id: record.uuid || record.message?.id || `${lineNumber}`,
      line: lineNumber,
      role: roleForRecord(record, blocks),
      timestamp: record.timestamp || null,
      model: record.message?.model || null,
      agentType: record.attributionAgent || suppliedDescriptor.agentType || null,
      stopReason: record.message?.stop_reason || null,
      error: record.error || null,
      blocks,
    });
  });

  let completeLines = 0;
  for (const byte of buffer) {
    if (byte === 0x0a) completeLines++;
  }
  const lastNewline = buffer.lastIndexOf(0x0a);
  return {
    completeBytes: lastNewline === -1 ? 0 : lastNewline + 1,
    completeLines,
    lines: completeLines + (buffer.length && buffer.at(-1) !== 0x0a ? 1 : 0),
    malformedLines,
    messages,
    partialLine,
  };
}

function fileIdentity(stat) {
  return stat ? `${stat.dev ?? ''}:${stat.ino ?? ''}` : '';
}

function descriptorForTranscript(suppliedDescriptor, stat, messages) {
  const lastMessage = messages.at(-1);
  return {
    ...suppliedDescriptor,
    size: stat?.size || 0,
    mtimeMs: stat?.mtimeMs || suppliedDescriptor.mtimeMs || 0,
    status: transcriptStatus({
      error: lastMessage?.error,
      message: {
        stop_reason: lastMessage?.stopReason,
        content: lastMessage?.blocks?.map((block) => ({ is_error: block.isError })),
      },
    }, stat?.mtimeMs || 0),
  };
}

function readFileRange(filePath, start, length) {
  if (length <= 0) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(length);
  const file = fs.openSync(filePath, 'r');
  let offset = 0;
  try {
    while (offset < length) {
      const bytes = fs.readSync(file, buffer, offset, length - offset, start + offset);
      if (!bytes) break;
      offset += bytes;
    }
  } finally {
    fs.closeSync(file);
  }
  return offset === length ? buffer : buffer.subarray(0, offset);
}

function readSubagentTranscript(descriptorOrPath) {
  const suppliedDescriptor = typeof descriptorOrPath === 'string'
    ? { filePath: descriptorOrPath }
    : descriptorOrPath;
  const filePath = suppliedDescriptor?.filePath;
  if (!filePath) throw new TypeError('A sub-agent transcript path is required.');

  const stat = safeStat(filePath);
  if (!stat?.isFile()) throw new Error(`Sub-agent transcript not found: ${filePath}`);
  const buffer = fs.readFileSync(filePath);
  const parsed = parseTranscriptBuffer(buffer, suppliedDescriptor);
  const descriptor = descriptorForTranscript(suppliedDescriptor, stat, parsed.messages);
  return {
    descriptor,
    filePath,
    bytes: descriptor.size,
    lines: parsed.lines,
    malformedLines: parsed.malformedLines,
    partialLine: parsed.partialLine,
    messages: parsed.messages,
    updatedAt: stat ? new Date(stat.mtimeMs).toISOString() : null,
    readState: {
      completeBytes: parsed.completeBytes,
      completeLines: parsed.completeLines,
      fileIdentity: fileIdentity(stat),
    },
  };
}

function updateSubagentTranscript(previous, descriptorOrPath) {
  const suppliedDescriptor = typeof descriptorOrPath === 'string'
    ? { filePath: descriptorOrPath }
    : descriptorOrPath;
  const filePath = suppliedDescriptor?.filePath;
  if (!previous || !filePath || previous.filePath !== filePath) {
    return { append: false, appendedMessages: [], transcript: readSubagentTranscript(descriptorOrPath) };
  }

  const stat = safeStat(filePath);
  const state = previous.readState;
  const safeEnding = previous.partialLine || state?.completeBytes === previous.bytes;
  const canAppend = stat?.isFile() && state && safeEnding &&
    state.fileIdentity === fileIdentity(stat) && stat.size >= previous.bytes;
  if (!canAppend) {
    return { append: false, appendedMessages: [], transcript: readSubagentTranscript(descriptorOrPath) };
  }

  const start = state.completeBytes;
  const buffer = readFileRange(filePath, start, stat.size - start);
  const parsed = parseTranscriptBuffer(buffer, suppliedDescriptor, state.completeLines);
  const messages = previous.messages.concat(parsed.messages);
  const descriptor = descriptorForTranscript(suppliedDescriptor, stat, messages);
  const transcript = {
    descriptor,
    filePath,
    bytes: descriptor.size,
    lines: state.completeLines + parsed.lines,
    malformedLines: previous.malformedLines + parsed.malformedLines,
    partialLine: parsed.partialLine,
    messages,
    updatedAt: new Date(stat.mtimeMs).toISOString(),
    readState: {
      completeBytes: start + parsed.completeBytes,
      completeLines: state.completeLines + parsed.completeLines,
      fileIdentity: fileIdentity(stat),
    },
  };
  return { append: true, appendedMessages: parsed.messages, transcript };
}

module.exports = {
  ACTIVE_WINDOW_MS,
  MAX_METADATA_BYTES,
  defaultProjectsRoot,
  findSubagentFiles,
  readSubagentTranscript,
  updateSubagentTranscript,
  contentBlocks,
  compactLabel,
  transcriptStatus,
  _test: {
    readBoundedRecords,
    firstUserPrompt,
    firstWorkingDirectory,
    firstAgentType,
    parseTranscriptBuffer,
    roleForRecord,
  },
};
