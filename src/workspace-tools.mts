import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { HarnessError, requireCondition } from './contracts.mjs';

export interface WorkspaceTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(callId: string, args: unknown, signal: AbortSignal): Promise<unknown>;
}
const schema = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
const pathProperty = { type: 'string', description: 'Relative workspace path; hidden paths and symlinks are denied' };
export const WORKSPACE_TOOL_SCHEMAS: readonly Pick<WorkspaceTool,'name'|'description'|'parameters'>[] = [
 {name:'read_file',description:'Read a UTF-8 file up to 64KiB inside this instance workspace',parameters:schema({path:pathProperty},['path'])},
 {name:'list_files',description:'List visible workspace entries, optionally recursively; bounded to 200 entries and 5 levels',parameters:schema({path:pathProperty,recursive:{type:'boolean'}},[])},
 {name:'search_text',description:'Search visible UTF-8 workspace files using a literal, case-sensitive query; max 100 matching lines',parameters:schema({path:pathProperty,query:{type:'string',maxLength:256}},['query'])},
];
const MAX_BYTES = 65536, MAX_ENTRIES = 2000, MAX_FILES = 200;
function allowed(name: string): boolean {
  return !name.startsWith('.') && name !== 'node_modules' && !/\.env(?:$|\.)/i.test(name);
}
function input(raw: unknown, fields: readonly string[]): Record<string, unknown> {
  requireCondition(raw !== null && typeof raw === 'object' && !Array.isArray(raw), 'INVALID_TOOL_ARGUMENT', 'Expected an argument object');
  const value = raw as Record<string, unknown>;
  requireCondition(Object.keys(value).every(k => fields.includes(k)), 'INVALID_TOOL_ARGUMENT', 'Unexpected argument');
  return value;
}
export async function createWorkspaceTools(workspaceRoot: string): Promise<readonly WorkspaceTool[]> {
  requireCondition(!(await lstat(workspaceRoot)).isSymbolicLink(), 'PATH_DENIED', 'Workspace root cannot be a symbolic link');
  const root = await realpath(workspaceRoot);
  requireCondition((await lstat(root)).isDirectory(), 'WORKSPACE_INVALID', 'Workspace must be a directory');
  async function locate(raw: unknown, signal: AbortSignal): Promise<{ relative: string; absolute: string }> {
    signal.throwIfAborted();
    requireCondition(typeof raw === 'string' && raw.length > 0 && raw.length <= 1024 && !raw.includes('\\') && !raw.includes('\0') && !path.isAbsolute(raw),
      'PATH_DENIED', 'Use a relative workspace path');
    const segments = raw === '.' ? [] : raw.split('/');
    requireCondition(segments.every(s => s.length > 0 && s !== '..' && allowed(s)), 'PATH_DENIED', 'Hidden, credential and parent paths are denied');
    let absolute = root;
    for (const segment of segments) {
      absolute = path.join(absolute, segment);
      const stat = await lstat(absolute); signal.throwIfAborted();
      requireCondition(!stat.isSymbolicLink(), 'PATH_DENIED', 'Symbolic links are not followed');
    }
    const resolved = await realpath(absolute);
    const relative = path.relative(root, resolved);
    requireCondition(relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)),
      'PATH_DENIED', 'Path is outside workspace');
    return { relative: relative || '.', absolute: resolved };
  }
  async function read(relative: string, signal: AbortSignal): Promise<{ path: string; text: string; bytes: number }> {
    const file = await locate(relative, signal);
    const handle = await open(file.absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      requireCondition(stat.isFile(), 'FILE_TYPE_DENIED', 'Only regular files may be read');
      requireCondition(stat.size <= MAX_BYTES, 'FILE_TOO_LARGE', 'File exceeds 64KiB');
      // Recheck path and identity after opening; no reliance on a stale path check alone.
      const checked = await locate(relative, signal), current = await lstat(checked.absolute);
      requireCondition(checked.absolute === file.absolute && current.dev === stat.dev && current.ino === stat.ino,
        'PATH_DENIED', 'File changed during admission');
      const buffer = Buffer.alloc(MAX_BYTES + 1); let size = 0;
      while (size < buffer.length) {
        signal.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
        if (!bytesRead) break; size += bytesRead;
      }
      requireCondition(size <= MAX_BYTES, 'FILE_TOO_LARGE', 'File exceeds 64KiB');
      requireCondition(!buffer.subarray(0, size).includes(0), 'BINARY_FILE_DENIED', 'Only UTF-8 text is supported');
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)); }
      catch { throw new HarnessError('BINARY_FILE_DENIED', 'Only UTF-8 text is supported'); }
      signal.throwIfAborted(); return { path: file.relative, text, bytes: size };
    } finally { await handle.close(); }
  }
  async function walk(relative: string, signal: AbortSignal, recursive: boolean) {
    const entries: { path: string; type: 'file' | 'directory' }[] = [];
    let examined = 0, truncated = false;
    const visit = async (directory: string, depth: number): Promise<void> => {
      const located = await locate(directory, signal);
      requireCondition((await lstat(located.absolute)).isDirectory(), 'FILE_TYPE_DENIED', 'Directory required');
      // opendir-style streaming avoids allocating an unbounded directory listing.
      const { opendir } = await import('node:fs/promises');
      const handle = await opendir(located.absolute);
      for await (const entry of handle) {
        signal.throwIfAborted();
        if (++examined > MAX_ENTRIES || entries.length >= MAX_FILES) { truncated = true; break; }
        if (!allowed(entry.name) || entry.isSymbolicLink()) continue;
        const item = directory === '.' ? entry.name : directory + '/' + entry.name;
        if (entry.isFile()) entries.push({ path: item, type: 'file' });
        else if (entry.isDirectory()) {
          entries.push({ path: item, type: 'directory' });
          if (recursive && depth < 5) await visit(item, depth + 1);
          else if (recursive) truncated = true;
        }
        if (truncated && (examined > MAX_ENTRIES || entries.length >= MAX_FILES)) break;
      }
    };
    await visit(relative, 0); entries.sort((a, b) => a.path.localeCompare(b.path));
    return { entries, truncated };
  }
  const result = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
  const safe = (fn: (args: unknown, signal: AbortSignal) => Promise<unknown>) => async (_: string, args: unknown, signal: AbortSignal) => {
    try { return result(await fn(args, signal)); }
    catch (error) {
      signal.throwIfAborted();
      const code = error instanceof HarnessError ? error.code : 'FILE_UNAVAILABLE';
      throw new HarnessError(code, code); // Never leak absolute paths or OS error strings.
    }
  };
  return [
    { ...WORKSPACE_TOOL_SCHEMAS[0]!, execute: safe(async (raw, signal) => {
        const args = input(raw, ['path']); requireCondition(typeof args.path === 'string', 'INVALID_TOOL_ARGUMENT', 'path required');
        return read(args.path, signal);
      }) },
    { ...WORKSPACE_TOOL_SCHEMAS[1]!, execute: safe(async (raw, signal) => {
        const args = input(raw, ['path', 'recursive']);
        requireCondition(args.recursive === undefined || typeof args.recursive === 'boolean', 'INVALID_TOOL_ARGUMENT', 'recursive must be boolean');
        const located = await locate(args.path ?? '.', signal); return walk(located.relative, signal, args.recursive === true);
      }) },
    { ...WORKSPACE_TOOL_SCHEMAS[2]!, execute: safe(async (raw, signal) => {
        const args = input(raw, ['path', 'query']);
        requireCondition(typeof args.query === 'string' && args.query.length > 0 && args.query.length <= 256, 'INVALID_TOOL_ARGUMENT', 'query must be 1..256 characters');
        const located = await locate(args.path ?? '.', signal);
        const listing = await walk(located.relative, signal, true);
        const matches: { path: string; line: number; text: string }[] = []; let skipped = 0;
        for (const item of listing.entries.filter(e => e.type === 'file')) {
          signal.throwIfAborted(); let file;
          try { file = await read(item.path, signal); }
          catch (error) { signal.throwIfAborted(); if (error instanceof HarnessError && ['FILE_TOO_LARGE', 'BINARY_FILE_DENIED'].includes(error.code)) { skipped++; continue; } throw error; }
          for (const [index, text] of file.text.split(/\r?\n/).entries()) {
            if (text.includes(args.query)) matches.push({ path: item.path, line: index + 1, text: text.slice(0, 500) });
            if (matches.length >= 100) return { matches, truncated: true, skipped };
          }
        }
        return { matches, truncated: listing.truncated, skipped };
      }) },
  ];
}
