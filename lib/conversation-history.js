'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const { StringDecoder } = require('string_decoder');
const { createJsonlSearch } = require('./jsonl-search');
const { findLiteral } = require('../vendor/runtime-core');
const {
  compactLabel,
  defaultProjectsRoot,
  isDisplayableTranscriptRecord,
  parseTranscriptRecord,
} = require('./subagent-transcripts');

const CONVERSATION_INDEX_BLOCK_SIZE = 256;
const CONVERSATION_PAGE_SIZE = 60;
const CONVERSATION_SEARCH_BATCH_SIZE = 50;
const CONVERSATION_READ_CHUNK_BYTES = 256 * 1024;
const CONVERSATION_PREVIEW_CHUNK_BYTES = 16 * 1024;
const CONVERSATION_MAX_RECORD_BYTES = 1024 * 1024;
const CONVERSATION_PREVIEW_BYTES = 256 * 1024;
const CONVERSATION_TAIL_VALIDATION_BYTES = 4096;
const CONVERSATION_SCAN_SLICE_MS = 8;

function fileIdentity(stat) {
  return stat ? `${stat.dev ?? ''}:${stat.ino ?? ''}` : '';
}

function safeRoot(root) {
  const value = root || defaultProjectsRoot();
  return path.resolve(value);
}

function withinRoot(root, candidate) {
  const relative = path.relative(safeRoot(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function withinPath(root, candidate) {
  if (!root || !candidate) return false;
  const canonicalPath = (value) => {
    let resolved = path.resolve(value);
    try { resolved = fs.realpathSync.native(resolved); } catch {}
    resolved = path.normalize(resolved);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const relative = path.relative(canonicalPath(root), canonicalPath(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function decodeLine(buffer) {
  return buffer.toString('utf8').replace(/\r$/, '');
}

function abortError() {
  const error = new Error('Conversation history operation was aborted.');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

async function scanJsonl(filePath, options = {}) {
  const chunkBytes = Math.max(16 * 1024, options.chunkBytes || CONVERSATION_READ_CHUNK_BYTES);
  const maximumRecordBytes = Math.max(1, options.maximumRecordBytes || CONVERSATION_MAX_RECORD_BYTES);
  const startOffset = Math.max(0, Number(options.startOffset) || 0);
  const startLine = Math.max(0, Number(options.startLine) || 0);
  let stat;
  let scanEnd;
  let tailValidation;
  let position = startOffset;
  let lineStart = startOffset;
  let lineNumber = startLine;
  let pending = [];
  let pendingBytes = 0;
  let tooLarge = false;
  let completeBytes = startOffset;
  let stopped = false;
  let handle;
  let sliceStarted = performance.now();
  let linesInSlice = 0;

  try {
    handle = await fs.promises.open(filePath, 'r');
    stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Conversation history is not a regular file.');
    if (options.expectedIndex && !await handleSnapshotMatches(handle, stat, options.expectedIndex)) {
      throw staleIndexError();
    }
    scanEnd = Math.min(stat.size, Number.isFinite(options.maxBytes)
      ? startOffset + Math.max(0, options.maxBytes)
      : stat.size);
    tailValidation = await readHandleValidation(handle, stat.size);
    while (position < scanEnd) {
      throwIfAborted(options.signal);
      const length = Math.min(chunkBytes, scanEnd - position);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (!bytesRead) break;
      const data = buffer.subarray(0, bytesRead);
      let cursor = 0;
      while (cursor < bytesRead) {
        const newline = data.indexOf(0x0a, cursor);
        const hasNewline = newline !== -1;
        const end = hasNewline ? newline : bytesRead;
        const piece = data.subarray(cursor, end);
        if (!tooLarge && pendingBytes + piece.length <= maximumRecordBytes) {
          if (piece.length) pending.push(piece);
        } else {
          tooLarge = true;
          pending = [];
        }
        pendingBytes += piece.length;
        position += piece.length;

        if (!hasNewline) break;
        position++;
        lineNumber++;
        completeBytes = position;
        const event = {
          buffer: tooLarge ? null : (pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes)),
          offset: lineStart,
          length: pendingBytes,
          lineNumber,
          oversized: tooLarge,
          nextOffset: position,
        };
        const result = options.onLine?.(event);
        const keepGoing = result && typeof result.then === 'function' ? await result : result;
        lineStart = position;
        pending = [];
        pendingBytes = 0;
        tooLarge = false;
        cursor = end + 1;
        if (keepGoing === false) {
          stopped = true;
          break;
        }
        linesInSlice++;
        if (linesInSlice >= CONVERSATION_INDEX_BLOCK_SIZE ||
            performance.now() - sliceStarted >= CONVERSATION_SCAN_SLICE_MS) {
          await new Promise((resolve) => setImmediate(resolve));
          throwIfAborted(options.signal);
          sliceStarted = performance.now();
          linesInSlice = 0;
        }
      }
      if (stopped) break;
    }
  } finally {
    await handle?.close();
  }

  const partialBytes = !stopped && position === scanEnd && lineStart < scanEnd
    ? scanEnd - lineStart
    : 0;
  return {
    bytes: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    fileIdentity: fileIdentity(stat),
    tailValidation,
    completeBytes,
    completeLines: lineNumber - startLine,
    partialBytes,
    stopped,
  };
}

function parseLineEvent(event, descriptor = {}, options = {}) {
  if (event.oversized) {
    if (options.metadataOnly) return { displayable: true, malformed: false };
    return {
      displayable: true,
      message: {
        id: `${descriptor.sessionId || 'conversation'}:${event.lineNumber}`,
        line: event.lineNumber,
        role: 'event',
        timestamp: null,
        model: null,
        agentType: null,
        stopReason: null,
        error: null,
        blocks: [{
          kind: 'large-record',
          text: `This JSONL record is larger than ${CONVERSATION_MAX_RECORD_BYTES / 1024 / 1024} MiB and is shown as a lightweight placeholder. Open the raw file to inspect its complete contents.`,
        }],
        largeRecord: true,
        rawOffset: event.offset,
        rawLength: event.length,
      },
      malformed: false,
    };
  }

  if (!event.buffer?.length) return { message: null, displayable: false, malformed: false };
  let record;
  try {
    record = JSON.parse(decodeLine(event.buffer));
  } catch {
    return { message: null, displayable: false, malformed: true };
  }
  if (options.metadataOnly) {
    return { displayable: isDisplayableTranscriptRecord(record), malformed: false, record };
  }
  const message = parseTranscriptRecord(record, descriptor, event.lineNumber);
  return { message: message || null, displayable: !!message, malformed: false, record };
}

function conversationSearchText(message) {
  return [
    message?.role,
    message?.agentType,
    message?.model,
    message?.error,
    message?.stopReason,
    message?.timestamp,
    ...(message?.blocks || []).flatMap((block) => [block.kind, block.name, block.text]),
  ].filter(Boolean).join('\n').toLocaleLowerCase();
}

function conversationSearchLocation(message, query) {
  if (message?.largeRecord) return null;
  for (const [blockIndex, block] of (message?.blocks || []).entries()) {
    const match = findLiteral(block.text || '', query);
    if (match) return { blockIndex, ...match };
  }
  return null;
}

function conversationSearchPreview(message, query, location = conversationSearchLocation(message, query)) {
  if (location) {
    const block = message.blocks[location.blockIndex];
    const text = String(block.text || '');
    const start = Math.max(0, location.start - 72);
    const end = Math.min(text.length, location.end + 112);
    return text.slice(start, end).replace(/\s+/g, ' ').trim();
  }
  if (message?.largeRecord) return 'Large JSONL record; open the raw record to inspect it.';
  return 'Matched message metadata.';
}

async function searchLargeLine(filePath, offset, length, query, signal, filter) {
  const search = createJsonlSearch(query, filter);
  const decoder = new StringDecoder('utf8');
  let position = 0;
  let handle;
  try {
    handle = await fs.promises.open(filePath, 'r');
    while (position < length) {
      throwIfAborted(signal);
      const size = Math.min(32 * 1024, length - position);
      const buffer = Buffer.allocUnsafe(size);
      const { bytesRead } = await handle.read(buffer, 0, size, offset + position);
      if (!bytesRead) break;
      position += bytesRead;
      search.write(decoder.write(buffer.subarray(0, bytesRead)));
      await new Promise((resolve) => setImmediate(resolve));
    }
    search.write(decoder.end());
    return search.finish().matched;
  } finally {
    await handle?.close();
  }
}

async function readConversationPreview(filePath, projectId, options = {}) {
  const stat = await fs.promises.stat(filePath);
  let prompt = '';
  let projectPath = '';
  let firstTimestamp = null;
  const maximumNameBytes = Math.min(CONVERSATION_PREVIEW_BYTES, stat.size);
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let position = 0;
  let handle;
  const readRecord = (line) => {
    if (!line) return false;
    let record;
    try { record = JSON.parse(line.replace(/\r$/, '')); } catch { return false; }
    if (!projectPath && typeof record.cwd === 'string') projectPath = record.cwd;
    if (!firstTimestamp && typeof record.timestamp === 'string') firstTimestamp = record.timestamp;
    if (!prompt && (record.message?.role === 'user' || record.type === 'user')) {
      const parsed = parseTranscriptRecord(record, { sessionId: path.basename(filePath, '.jsonl') });
      prompt = (parsed?.blocks || [])
        .filter((block) => block.kind === 'text')
        .map((block) => block.text)
        .find((text) => text.trim()) || '';
    }
    return !!prompt;
  };
  try {
    handle = await fs.promises.open(filePath, 'r');
    while (position < maximumNameBytes && !prompt) {
      throwIfAborted(options.signal);
      const length = Math.min(CONVERSATION_PREVIEW_CHUNK_BYTES, maximumNameBytes - position);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (!bytesRead) break;
      position += bytesRead;
      const lines = (pending + decoder.write(buffer.subarray(0, bytesRead))).split('\n');
      pending = lines.pop() || '';
      for (const line of lines) {
        if (readRecord(line)) break;
      }
    }
    if (!prompt && position === stat.size && pending) readRecord(pending + decoder.end());
  } finally {
    await handle?.close();
  }
  const sessionId = path.basename(filePath, '.jsonl');
  return {
    filePath,
    projectId,
    projectPath,
    projectLabel: projectPath ? path.basename(projectPath) : projectId,
    sessionId,
    label: compactLabel(prompt, 88) || sessionId,
    firstTimestamp,
    status: 'local',
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

async function listConversationFiles(projectsRoot = defaultProjectsRoot(), options = {}) {
  const root = safeRoot(projectsRoot);
  let projects;
  try {
    projects = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const projectIds = options.projectIds
    ? new Set(Array.from(options.projectIds, String).filter((id) => id && path.basename(id) === id))
    : null;
  const workspacePaths = options.workspacePaths
    ? Array.from(options.workspacePaths, (value) => path.resolve(String(value))).filter(Boolean)
    : null;
  const workspaceProjectIds = workspacePaths
    ? new Set(workspacePaths.flatMap((workspacePath) => {
        const canonicalWorkspacePath = (() => {
          try { return fs.realpathSync.native(workspacePath); } catch { return workspacePath; }
        })();
        return [workspacePath, canonicalWorkspacePath]
          .map((value) => path.resolve(value).replace(/[^a-zA-Z0-9]/g, '-'));
      }))
    : null;
  const projectDirectories = projects.filter((entry) => entry.isDirectory() && (
    !projectIds || Array.from(projectIds).some((id) => entry.name === id ||
      (options.includeDescendants && entry.name.startsWith(`${id}-`)))
  ));
  const filesToRead = [];
  for (const projectEntry of projectDirectories) {
    throwIfAborted(options.signal);
    const projectPath = path.join(root, projectEntry.name);
    let entries;
    try {
      entries = await fs.promises.readdir(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }
    const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl') &&
      !entry.name.startsWith('agent-'));
    for (const file of files) {
      filesToRead.push({ filePath: path.join(projectPath, file.name), projectId: projectEntry.name });
    }
  }
  const descriptors = [];
  let nextFileIndex = 0;
  const readBatch = async () => {
    while (nextFileIndex < filesToRead.length) {
      throwIfAborted(options.signal);
      const file = filesToRead[nextFileIndex++];
      try {
        const descriptor = await readConversationPreview(file.filePath, file.projectId, options);
        const inWorkspace = !workspacePaths || (descriptor.projectPath
          ? workspacePaths.some((workspacePath) => withinPath(workspacePath, descriptor.projectPath))
          : Array.from(workspaceProjectIds || []).some((id) => descriptor.projectId === id ||
            descriptor.projectId.startsWith(`${id}-`)));
        if (withinRoot(root, descriptor.filePath) && inWorkspace) descriptors.push(descriptor);
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
      }
    }
  };
  const concurrency = Math.min(8, filesToRead.length);
  await Promise.all(Array.from({ length: concurrency }, () => readBatch()));
  return descriptors.sort((a, b) => b.mtimeMs - a.mtimeMs || a.filePath.localeCompare(b.filePath));
}

function addLineToIndex(index, event) {
  index.lines = event.lineNumber;
  const parsed = parseLineEvent(event, {}, { metadataOnly: true });
  if (parsed.malformed) index.malformedLines++;
  if (!parsed.displayable) return;
  const messageIndex = index.messageCount;
  if (messageIndex % CONVERSATION_INDEX_BLOCK_SIZE === 0) {
    index.checkpoints.push({
      messageIndex,
      offset: event.offset,
      lineNumber: event.lineNumber,
    });
  }
  index.messageCount++;
}

async function buildConversationIndex(descriptor, options = {}) {
  if (!descriptor?.filePath) throw new TypeError('A conversation history path is required.');
  throwIfAborted(options.signal);
  const index = {
    filePath: descriptor.filePath,
    sessionId: descriptor.sessionId,
    bytes: 0,
    mtimeMs: 0,
    fileIdentity: '',
    completeBytes: 0,
    lines: 0,
    malformedLines: 0,
    partialLine: false,
    messageCount: 0,
    checkpoints: [],
  };
  const scan = await scanJsonl(descriptor.filePath, {
    signal: options.signal,
    onLine(event) {
      addLineToIndex(index, event);
    },
  });
  throwIfAborted(options.signal);
  index.bytes = scan.bytes;
  index.mtimeMs = scan.mtimeMs;
  index.ctimeMs = scan.ctimeMs;
  index.fileIdentity = scan.fileIdentity;
  index.completeBytes = scan.completeBytes;
  index.partialLine = scan.partialBytes > 0;
  index.tailValidation = scan.tailValidation;
  if (!await indexSnapshotMatches(index)) {
    throw staleIndexError();
  }
  return index;
}

function staleIndexError() {
  const error = new Error('Conversation history was replaced or rewritten while it was being read.');
  error.code = 'CONVERSATION_INDEX_STALE';
  return error;
}

async function readHandleValidation(handle, endOffset) {
  const end = Math.max(0, Number(endOffset) || 0);
  const start = Math.max(0, end - CONVERSATION_TAIL_VALIDATION_BYTES);
  const length = end - start;
  const buffer = Buffer.allocUnsafe(length);
  let bytesRead = 0;
  while (bytesRead < length) {
    const result = await handle.read(buffer, bytesRead, length - bytesRead, start + bytesRead);
    if (!result.bytesRead) throw staleIndexError();
    bytesRead += result.bytesRead;
  }
  return {
    start,
    length,
    hash: crypto.createHash('sha256').update(buffer).digest('hex'),
  };
}

function snapshotMetadataMatches(stat, index) {
  return fileIdentity(stat) === index.fileIdentity && stat.size >= index.bytes &&
    (stat.size > index.bytes || (stat.mtimeMs === index.mtimeMs && stat.ctimeMs === index.ctimeMs));
}

async function handleSnapshotMatches(handle, stat, index) {
  const validation = index.tailValidation;
  if (!snapshotMetadataMatches(stat, index) || !validation) return false;
  const current = await readHandleValidation(handle, index.bytes);
  return current.start === validation.start && current.length === validation.length &&
    current.hash === validation.hash;
}

async function updateConversationIndex(index, descriptor, options = {}) {
  throwIfAborted(options.signal);
  if (!index || !descriptor?.filePath || index.filePath !== descriptor.filePath) {
    return buildConversationIndex(descriptor, options);
  }
  const stat = await fs.promises.stat(descriptor.filePath);
  const identity = fileIdentity(stat);
  if (identity !== index.fileIdentity || stat.size < index.bytes ||
      (stat.size === index.bytes && (stat.mtimeMs !== index.mtimeMs || stat.ctimeMs !== index.ctimeMs))) {
    return { ...(await buildConversationIndex(descriptor, options)), updateType: 'rebuilt' };
  }
  if (!await indexSnapshotMatches(index)) {
    return { ...(await buildConversationIndex(descriptor, options)), updateType: 'rebuilt' };
  }
  if (stat.size === index.bytes && stat.mtimeMs === index.mtimeMs && stat.ctimeMs === index.ctimeMs) return index;

  const nextIndex = { ...index, checkpoints: index.checkpoints.slice() };
  const scan = await scanJsonl(descriptor.filePath, {
    expectedIndex: index,
    startOffset: index.completeBytes,
    startLine: index.lines,
    signal: options.signal,
    onLine(event) {
      addLineToIndex(nextIndex, event);
    },
  });
  throwIfAborted(options.signal);
  nextIndex.bytes = scan.bytes;
  nextIndex.mtimeMs = scan.mtimeMs;
  nextIndex.ctimeMs = scan.ctimeMs;
  nextIndex.fileIdentity = scan.fileIdentity;
  nextIndex.completeBytes = scan.completeBytes;
  nextIndex.partialLine = scan.partialBytes > 0;
  nextIndex.tailValidation = scan.tailValidation;
  if (!await indexSnapshotMatches(nextIndex)) {
    throw staleIndexError();
  }
  nextIndex.updateType = 'appended';
  return nextIndex;
}

async function indexSnapshotMatches(index) {
  const handle = await fs.promises.open(index.filePath, 'r');
  try {
    return await handleSnapshotMatches(handle, await handle.stat(), index) &&
      snapshotMetadataMatches(await fs.promises.stat(index.filePath), index);
  } finally {
    await handle.close();
  }
}

async function assertIndexCurrent(index) {
  if (!await indexSnapshotMatches(index)) {
    throw staleIndexError();
  }
}

async function loadConversationPage(index, pageIndex, options = {}) {
  if (!index || !Number.isInteger(Number(pageIndex)) || Number(pageIndex) < 0) {
    throw new TypeError('A valid conversation page is required.');
  }
  await assertIndexCurrent(index);
  throwIfAborted(options.signal);
  const page = Number(pageIndex);
  const pageStart = page * CONVERSATION_PAGE_SIZE;
  const pageEnd = Math.min(index.messageCount, pageStart + CONVERSATION_PAGE_SIZE);
  const checkpointIndex = Math.floor(pageStart / CONVERSATION_INDEX_BLOCK_SIZE);
  const checkpoint = index.checkpoints[checkpointIndex];
  if (!checkpoint || checkpoint.messageIndex > pageStart || pageStart >= index.messageCount) {
    return { pageIndex: page, pageSize: CONVERSATION_PAGE_SIZE, totalMessages: index.messageCount, messages: [] };
  }
  const messages = [];
  let messageIndex = checkpoint.messageIndex;
  await scanJsonl(index.filePath, {
    expectedIndex: index,
    startOffset: checkpoint.offset,
    startLine: checkpoint.lineNumber - 1,
    maxBytes: index.completeBytes - checkpoint.offset,
    signal: options.signal,
    async onLine(event) {
      const parsed = parseLineEvent(event, { sessionId: index.sessionId }, { metadataOnly: messageIndex < pageStart });
      if (!parsed.displayable) return true;
      const currentIndex = messageIndex++;
      if (currentIndex >= pageStart && currentIndex < pageEnd) {
        const message = { ...parsed.message, conversationIndex: currentIndex };
        if (options.onMessage) await options.onMessage(message);
        else messages.push(message);
      }
      return messageIndex < pageEnd;
    },
  });
  await assertIndexCurrent(index);
  return {
    pageIndex: page,
    pageSize: CONVERSATION_PAGE_SIZE,
    totalMessages: index.messageCount,
    messages,
  };
}

async function searchConversationPage(index, query, cursor = null, options = {}) {
  const normalizedQuery = String(query || '').trim();
  const filter = ['assistant', 'thinking', 'tools', 'errors'].includes(options.filter) ? options.filter : 'all';
  if ((!normalizedQuery && filter === 'all') || normalizedQuery.length > 512) {
    return { query: normalizedQuery, hits: [], nextCursor: null, done: true };
  }
  await assertIndexCurrent(index);
  throwIfAborted(options.signal);
  const startOffset = Math.max(0, Number(cursor?.offset) || 0);
  const startLine = Math.max(0, Number(cursor?.lineNumber) || 0);
  let messageIndex = Math.max(0, Number(cursor?.messageIndex) || 0);
  let nextCursor = null;
  const hits = [];
  await scanJsonl(index.filePath, {
    expectedIndex: index,
    startOffset,
    startLine,
    maxBytes: Math.max(0, index.completeBytes - startOffset),
    signal: options.signal,
    async onLine(event) {
      const parsed = parseLineEvent(event, { sessionId: index.sessionId });
      let message = parsed.message;
      const currentMessageIndex = message ? messageIndex : -1;
      let matches = false;
      if (event.oversized) {
        matches = await searchLargeLine(index.filePath, event.offset, event.length, normalizedQuery, options.signal, filter);
      } else if (message) {
        const search = createJsonlSearch(normalizedQuery, filter);
        const source = decodeLine(event.buffer);
        let started = performance.now();
        for (let offset = 0; offset < source.length; offset += 32 * 1024) {
          search.write(source.slice(offset, offset + 32 * 1024));
          if (performance.now() - started >= CONVERSATION_SCAN_SLICE_MS) {
            await new Promise((resolve) => setImmediate(resolve));
            throwIfAborted(options.signal);
            started = performance.now();
          }
        }
        matches = search.finish().matched;
      }
      if (message) messageIndex++;
      nextCursor = {
        offset: event.nextOffset,
        lineNumber: event.lineNumber,
        messageIndex,
      };
      if (matches && hits.length < CONVERSATION_SEARCH_BATCH_SIZE) {
        if (!message) {
          message = parseLineEvent(event, { sessionId: index.sessionId }).message;
        }
        const location = conversationSearchLocation(message, normalizedQuery);
        hits.push({
          messageIndex: currentMessageIndex,
          line: event.lineNumber,
          role: message?.role || 'event',
          location,
          raw: !!message?.largeRecord,
          preview: message ? conversationSearchPreview(message, normalizedQuery, location) :
            'Large JSONL record; open the raw record to inspect it.',
        });
      }
      return hits.length < CONVERSATION_SEARCH_BATCH_SIZE;
    },
  });
  await assertIndexCurrent(index);
  const done = hits.length < CONVERSATION_SEARCH_BATCH_SIZE ||
    !nextCursor || nextCursor.offset >= index.completeBytes;
  return {
    query: normalizedQuery,
    hits,
    nextCursor: done ? null : nextCursor,
    done,
  };
}

module.exports = {
  CONVERSATION_INDEX_BLOCK_SIZE,
  CONVERSATION_MAX_RECORD_BYTES,
  CONVERSATION_PAGE_SIZE,
  CONVERSATION_PREVIEW_BYTES,
  CONVERSATION_READ_CHUNK_BYTES,
  CONVERSATION_SEARCH_BATCH_SIZE,
  CONVERSATION_SCAN_SLICE_MS,
  CONVERSATION_TAIL_VALIDATION_BYTES,
  buildConversationIndex,
  conversationSearchText,
  listConversationFiles,
  loadConversationPage,
  parseLineEvent,
  scanJsonl,
  searchConversationPage,
  updateConversationIndex,
  withinRoot,
  withinPath,
};
