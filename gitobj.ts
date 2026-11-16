// gitobj.ts — pure git primitives: object hashing, pkt-lines, trees, commits,
// tags, packfiles (read/write, delta resolution) and reachability. No I/O,
// no state; the store owns the objects, this module owns their bytes.

import { createHash } from 'node:crypto';
import { deflateSync as zlibDeflate, inflateSync as zlibInflate } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export type ObjectLookup = (oid: string) => GitObject | undefined;

/** SHA-1 of a buffer, lowercase hex. */
export function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The object id of a (type, data) pair: sha1("<type> <len>\0" + data). */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1(Buffer.concat([header, data]));
}

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------- pkt-line

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface GitPacket {
  kind: PktKind;
  payload: Buffer;
  /** The raw bytes of the whole packet, length prefix included. */
  raw: Buffer;
}

/** One pkt-line: 4 hex length bytes (payload + 4) + payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

/** Encode several lines: strings become pkt-lines, 'flush'/'delim' control packets. */
export function encodePktLines(lines: ReadonlyArray<string | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(pktFlush());
    else if (line === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

/**
 * Decode a whole buffer of pkt-lines. Throws on a bad length prefix or a
 * truncated packet (callers turn that into a 400, never a crash).
 */
export function decodePktLines(bytes: Buffer): GitPacket[] {
  const packets: GitPacket[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('truncated pkt-line length');
    const head = bytes.subarray(offset, offset + 4).toString('ascii');
    if (head === '0000') {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0), raw: bytes.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (head === '0001') {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0), raw: bytes.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (head === '0002') {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0), raw: bytes.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || offset + len > bytes.length) {
      throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    }
    packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + len), raw: bytes.subarray(offset, offset + len) });
    offset += len;
  }
  return packets;
}

/** The data lines of a decoded buffer, as UTF-8 strings without trailing \n. */
export function pktLinesToStrings(packets: readonly GitPacket[]): string[] {
  const out: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    out.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return out;
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('malformed tree: no mode terminator');
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('malformed tree: no name terminator');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort: entries sort by name, directories as if named "name/". */
export function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  if (an < bn) return -1;
  if (an > bn) return 1;
  return 0;
}

/** Serialize tree entries (sorted git-style) into a tree object body. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits / tags

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse a commit object's headers and message. */
export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export interface BuildCommitFields {
  tree: string;
  parents?: readonly string[];
  author: string;
  committer: string;
  message: string;
}

export function buildCommit(fields: BuildCommitFields): Buffer {
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`);
  lines.push(`committer ${fields.committer}`);
  lines.push('');
  lines.push(fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export interface BuildTagFields {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function buildTag(fields: BuildTagFields): Buffer {
  const lines = [`object ${fields.object}`, `type ${fields.type}`, `tag ${fields.tag}`, `tagger ${fields.tagger}`, ''];
  lines.push(fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`);
  return Buffer.from(lines.join('\n'), 'utf8');
}

// ---------------------------------------------------------------- reachability

/**
 * Every object reachable from the tips: commits (parents + trees), trees
 * (entries), tags (their object). Unknown tips are skipped silently — the
 * caller decides whether a missing object is an error.
 */
export function collectReachable(tips: Iterable<string>, lookup: ObjectLookup): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid) || oid === ZERO_OID) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** The commit ancestors of a tip (parents only, no trees/blobs). */
export function collectAncestors(tip: string, lookup: ObjectLookup): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid) || oid === ZERO_OID) continue;
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return seen;
}

// ---------------------------------------------------------------- packfiles

const PACK_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number } {
  let size = buffer[start]! & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while ((buffer[offset - 1]! & 0x80) !== 0) {
    size |= (buffer[offset]! & 0x7f) << shift;
    shift += 7;
    offset += 1;
  }
  return { size, next: offset };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start]!;
  let offset = start + 1;
  let baseOffset = byte & 0x7f;
  while ((byte & 0x80) !== 0) {
    byte = buffer[offset]!;
    offset += 1;
    baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
  }
  return { baseOffset, next: offset };
}

/**
 * Inflate one zlib stream starting at offset; returns the data and the next
 * offset. Node's inflateSync tolerates trailing bytes, so the stream's exact
 * end is found by binary search on "inflate succeeds" (false below the end,
 * true at and above it) — logarithmic attempts per object, exact to the byte.
 */
export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  // The whole rest must inflate at all, or the pack is truncated/corrupt.
  try {
    zlibInflate(buffer.subarray(offset));
  } catch {
    throw new Error('truncated zlib stream in pack');
  }
  let lo = offset;
  let hi = buffer.length;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    try {
      zlibInflate(buffer.subarray(offset, mid));
      hi = mid;
    } catch {
      lo = mid;
    }
  }
  return { data: zlibInflate(buffer.subarray(offset, hi)), next: hi };
}

/** Apply a git delta to its base. Throws on a malformed delta. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset]!;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta source size does not match its base');
  const parts: Buffer[] = [];
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset]!;
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          copyOffset |= delta[offset]! << (i * 8);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          copySize |= delta[offset]! << (i * 8);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy runs past its base');
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      written += copySize;
    } else if (op !== 0) {
      parts.push(delta.subarray(offset, offset + op));
      offset += op;
      written += op;
    } else {
      throw new Error('delta op 0 is reserved');
    }
  }
  const out = Buffer.concat(parts);
  if (written !== targetSize || out.length !== targetSize) throw new Error('delta target size does not match');
  return out;
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/**
 * Parse a packfile (version 2/3). Resolves OFS and REF deltas; a REF base
 * may come from an earlier entry in the pack or from `resolveBase`.
 */
export function readPack(pack: Buffer, options: { resolveBase?: ObjectLookup } = {}): PackReadResult {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let deltaCount = 0;
  let offset = 12;
  const resolve = (oid: string): GitObject | undefined => objects.get(oid) ?? options.resolveBase?.(oid);
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    const first = pack[offset]!;
    const typeCode = (first >> 4) & 0x07;
    const { size, next } = readVarintSize(pack, offset);
    offset = next;
    let baseObject: GitObject | undefined;
    if (typeCode === 6) {
      const { baseOffset, next: afterBase } = readOfsDeltaBase(pack, offset);
      offset = afterBase;
      baseObject = byOffset.get(entryOffset - baseOffset);
      if (baseObject === undefined) throw new Error('ofs-delta base is not an earlier pack entry');
      deltaCount += 1;
    } else if (typeCode === 7) {
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      baseObject = resolve(baseOid);
      if (baseObject === undefined) throw new Error(`ref-delta base ${baseOid} is unknown`);
      deltaCount += 1;
    }
    const { data, next: afterData } = inflateAt(pack, offset);
    offset = afterData;
    if (data.length !== size) throw new Error('pack entry size does not match its header');
    let object: GitObject;
    if (typeCode === 6 || typeCode === 7) {
      const resolved = applyDelta(baseObject!.data, data);
      object = { type: baseObject!.type, data: resolved };
    } else {
      const type = PACK_TYPES[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      object = { type, data };
    }
    const oid = hashObject(object.type, object.data);
    objects.set(oid, object);
    byOffset.set(entryOffset, object);
  }
  return { objects, deltaCount };
}

/** The SHA-1 trailer of a pack: sha1 of every byte before the trailer. */
export function packChecksum(pack: Buffer): string {
  return sha1(pack.subarray(0, pack.length - 20));
}

export function verifyPackChecksum(pack: Buffer): { ok: boolean; expected: string; actual: string } {
  if (pack.length < 32) return { ok: false, expected: '', actual: '' };
  const expected = packChecksum(pack);
  const actual = pack.subarray(pack.length - 20).toString('hex');
  return { ok: expected === actual, expected, actual };
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const typeCode = PACK_TYPE_CODES[type];
  const bytes: number[] = [];
  let first = (size & 0x0f) | (typeCode << 4);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Serialize objects as a version-2 packfile with plain (undeltified) entries. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [Buffer.from('PACK', 'ascii')];
  const version = Buffer.alloc(4);
  version.writeUInt32BE(2, 0);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(list.length, 0);
  parts.push(version, count);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(zlibDeflate(object.data));
  }
  const head = Buffer.concat(parts);
  return Buffer.concat([head, Buffer.from(sha1(head), 'hex')]);
}

// ---------------------------------------------------------------- sideband

/** Split data into sideband pkt-lines (band byte + chunk), chunked under the pkt-line limit. */
export function sidebandPackets(data: Buffer, band = 1, chunkSize = 32768): Buffer[] {
  const out: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    const chunk = data.subarray(offset, offset + chunkSize);
    out.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  if (out.length === 0) out.push(pktLine(Buffer.from([band])));
  return out;
}
