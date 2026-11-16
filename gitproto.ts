// gitproto.ts — git smart HTTP: info/refs advertisements (v0 + v2), protocol
// v2 ls-refs/fetch, protocol v0 fetch, and receive-pack (push) with
// report-status. No git binary anywhere: packs, pkt-lines and reachability
// are all implemented on gitobj.ts.

import {
  collectAncestors,
  collectReachable,
  decodePktLines,
  encodePktLines,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  pktDelim,
  pktFlush,
  pktLine,
  readPack,
  sidebandPackets,
  writePack,
  ZERO_OID,
  type GitObject,
} from './gitobj.ts';
import { Store, type Repo } from './store.ts';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

const UPLOAD_AD_CT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD_CT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT_CT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT_CT = 'application/x-git-receive-pack-result';
const JSON_CT = 'application/json; charset=utf-8';

function jsonResponse(status: number, body: unknown): GitResponse {
  return { status, contentType: JSON_CT, body: Buffer.from(`${JSON.stringify(body)}\n`, 'utf8') };
}

function notFound(): GitResponse {
  return jsonResponse(404, { message: 'Not Found' });
}

function repoOr404(store: Store, owner: string, name: string): Repo | GitResponse {
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return notFound();
  return repo;
}

// ---------------------------------------------------------------- advertisements

const UPLOAD_CAPS = 'side-band-64k thin-pack ofs-delta shallow';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta';
const AGENT = 'makefun-git-forge/1.0';

function refLines(repo: Repo): Array<{ oid: string; name: string; peeled?: string }> {
  const refs: Array<{ oid: string; name: string; peeled?: string }> = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    refs.push({ oid, name });
    if (name.startsWith('refs/tags/')) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        refs.push({ oid: parseTag(object.data).object, name: `${name}^{}` });
      }
    }
  }
  return refs;
}

/** The v0 advertisement body for one service. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const serviceLine = `# service=${service}\n`;
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS : RECEIVE_CAPS;
  const lines: Array<string | 'flush'> = [serviceLine, 'flush'];
  const refs = refLines(repo);
  const symref = `symref=HEAD:refs/heads/${repo.defaultBranch}`;
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps} ${symref} agent=${AGENT}\n`);
  } else {
    const main = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    const headOid = main ?? ZERO_OID;
    lines.push(`${headOid} HEAD\0${caps} ${symref} agent=${AGENT}\n`);
    for (const ref of refs) lines.push(`${ref.oid} ${ref.name}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/** The protocol v2 capability advertisement (upload-pack only). */
function v2Advertisement(): Buffer {
  const lines: Array<string | 'flush'> = [
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    'agent\n',
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    'flush',
  ];
  return encodePktLines(lines);
}

export function handleInfoRefs(
  store: Store,
  owner: string,
  repoName: string,
  service: string,
  gitProtocol: string | undefined,
): GitResponse {
  const repo = repoOr404(store, owner, repoName);
  if (!(repo instanceof Object) || !('refs' in repo)) return repo as GitResponse;
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return jsonResponse(400, { message: `unknown service ${service}` });
  }
  if (service === 'git-upload-pack' && gitProtocol === 'version=2') {
    return { status: 200, contentType: UPLOAD_AD_CT, body: v2Advertisement() };
  }
  const ct = service === 'git-upload-pack' ? UPLOAD_AD_CT : RECEIVE_AD_CT;
  return { status: 200, contentType: ct, body: v0Advertisement(repo, service) };
}

// ---------------------------------------------------------------- ls-refs (v2)

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefsResponse(repo: Repo, args: LsRefsArgs): Buffer {
  const lines: string[] = [];
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const mainOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const hasRefs = repo.refs.size > 0;
  if (!hasRefs) {
    if (keep('HEAD')) lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
  } else {
    if (mainOid !== undefined && keep('HEAD')) {
      lines.push(args.symrefs ? `${mainOid} HEAD symref-target:refs/heads/${repo.defaultBranch}\n` : `${mainOid} HEAD\n`);
    }
    for (const ref of refLines(repo)) {
      if (ref.name.endsWith('^{}')) continue;
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (args.peel) {
        const object = repo.objects.get(ref.oid);
        if (object !== undefined && object.type === 'tag') {
          line += ` peeled:${parseTag(object.data).object}`;
        }
      }
      lines.push(`${line}\n`);
    }
  }
  return Buffer.concat([...lines.map((line) => pktLine(line)), pktFlush()]);
}

// ---------------------------------------------------------------- fetch planning

interface FetchPlan {
  /** Objects to send, by oid. */
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
}

/**
 * The objects a fetch sends. `wants` are the tips, `haves` what the client
 * holds, `shallow` the client's current shallow boundaries, `depth` the
 * deepen limit (null = full history). The walk from each want covers at most
 * `depth` generations; objects reachable from a have are withheld, except
 * that a shallow boundary only withholds itself and its tree (its parents
 * are precisely what the client lacks).
 */
function planFetch(repo: Repo, wants: string[], haves: string[], shallow: string[], depth: number | null): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const shallowSet = new Set(shallow);

  // The commits the walk includes, with their generation from a want.
  const included = new Map<string, number>();
  const queue: Array<{ oid: string; generation: number }> = [];
  for (const want of wants) {
    const object = lookup(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      included.set(want, 0);
      queue.push({ oid: parseTag(object.data).object, generation: 0 });
    } else if (object.type === 'commit') {
      queue.push({ oid: want, generation: 0 });
    } else {
      included.set(want, 0);
    }
  }
  while (queue.length > 0) {
    const { oid, generation } = queue.shift()!;
    if (included.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    included.set(oid, generation);
    if (depth === null || generation + 1 < depth) {
      for (const parent of parseCommit(object.data).parents) {
        queue.push({ oid: parent, generation: generation + 1 });
      }
    }
  }

  // The object closure of the included commits (trees and blobs, no parents
  // beyond the included set) plus any tag objects named directly.
  const send = new Map<string, GitObject>();
  const addTreeClosure = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (send.has(oid)) continue;
      const object = lookup(oid);
      if (object === undefined) continue;
      send.set(oid, object);
      if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      }
    }
  };
  for (const oid of included.keys()) {
    const object = lookup(oid);
    if (object === undefined) continue;
    send.set(oid, object);
    if (object.type === 'commit') addTreeClosure(parseCommit(object.data).tree);
    else if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObject = lookup(target);
      if (targetObject !== undefined && targetObject.type === 'commit') addTreeClosure(parseCommit(targetObject.data).tree);
    }
  }

  // What the client already holds: full closure of each have, except a
  // shallow boundary withholds only itself and its tree.
  const held = new Set<string>();
  for (const have of haves) {
    if (shallowSet.has(have)) {
      const object = lookup(have);
      if (object === undefined) continue;
      held.add(have);
      if (object.type === 'commit') {
        const stack = [parseCommit(object.data).tree];
        while (stack.length > 0) {
          const oid = stack.pop()!;
          if (held.has(oid)) continue;
          const entry = lookup(oid);
          if (entry === undefined) continue;
          held.add(oid);
          if (entry.type === 'tree') for (const child of parseTree(entry.data)) stack.push(child.oid);
        }
      }
    } else {
      for (const oid of collectReachable([have], lookup)) held.add(oid);
    }
  }
  for (const oid of held) send.delete(oid);

  // Shallow-info: the depth boundary commits are newly shallow; an old
  // boundary whose parents are now all included is no longer shallow.
  const shallowOut: string[] = [];
  const unshallowOut: string[] = [];
  if (depth !== null) {
    for (const [oid, generation] of included) {
      if (generation === depth - 1) {
        const object = lookup(oid);
        if (object !== undefined && object.type === 'commit') shallowOut.push(oid);
      }
    }
  }
  for (const boundary of shallow) {
    if (!included.has(boundary)) continue;
    const object = lookup(boundary);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.every((parent) => included.has(parent))) unshallowOut.push(boundary);
  }
  return { objects: send, shallow: shallowOut, unshallow: unshallowOut };
}

function packOf(objects: Map<string, GitObject>): Buffer {
  const sorted = [...objects.values()].sort((a, b) => {
    const ao = hashObject(a.type, a.data);
    const bo = hashObject(b.type, b.data);
    return ao < bo ? -1 : ao > bo ? 1 : 0;
  });
  return writePack(sorted);
}

// ---------------------------------------------------------------- upload-pack

export function handleUploadPack(store: Store, owner: string, repoName: string, body: Buffer, gitProtocol: string | undefined): GitResponse {
  const repo = repoOr404(store, owner, repoName);
  if (!(repo instanceof Object) || !('refs' in repo)) return repo as GitResponse;
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return jsonResponse(400, { message: 'malformed pkt-line stream' });
  }
  const lines = packets.filter((packet) => packet.kind === 'data').map((packet) => packet.payload.toString('utf8'));
  const isV2 = gitProtocol === 'version=2' || (lines.length > 0 && lines[0]!.startsWith('command='));
  if (isV2) return uploadPackV2(repo, packets);
  return uploadPackV0(repo, packets);
}

function uploadPackV2(repo: Repo, packets: ReturnType<typeof decodePktLines>): GitResponse {
  const data = packets.filter((packet) => packet.kind === 'data').map((packet) => packet.payload.toString('utf8').replace(/\n$/, ''));
  const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
  const head = delimIndex < 0 ? data : data.slice(0, delimIndex);
  const args = delimIndex < 0 ? [] : data.slice(delimIndex);
  const command = head.find((line) => line.startsWith('command='))?.slice('command='.length);
  if (command === 'ls-refs') {
    const lsArgs: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    for (const arg of args) {
      if (arg === 'peel') lsArgs.peel = true;
      else if (arg === 'symrefs') lsArgs.symrefs = true;
      else if (arg === 'unborn') lsArgs.unborn = true;
      else if (arg.startsWith('ref-prefix ')) lsArgs.prefixes.push(arg.slice('ref-prefix '.length));
    }
    return { status: 200, contentType: UPLOAD_RESULT_CT, body: lsRefsResponse(repo, lsArgs) };
  }
  if (command !== 'fetch') {
    return jsonResponse(400, { message: `unknown upload-pack command ${command ?? ''}` });
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let done = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = Number.parseInt(arg.slice(7).trim(), 10);
    else if (arg === 'done') done = true;
  }
  if (depth !== null && !Number.isFinite(depth)) depth = null;
  // An unknown want is an error: the packfile section carries a band-3
  // sideband error, which both git and the kit client surface as a failure.
  // The acknowledgments section is only sent when the client is still
  // negotiating (no `done`); a client that sent `done` expects the next
  // section to be shallow-info or packfile.
  for (const want of wants) {
    if (!isObjectId(want) || repo.objects.get(want) === undefined) {
      const parts: Buffer[] = [];
      if (!done) parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), pktDelim());
      parts.push(pktLine('packfile\n'));
      parts.push(...sidebandPackets(Buffer.from('', 'utf8'), 3));
      parts.push(pktFlush());
      return { status: 200, contentType: UPLOAD_RESULT_CT, body: Buffer.concat(parts) };
    }
  }
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const pack = packOf(plan.objects);
  const parts: Buffer[] = [];
  if (!done) {
    // A negotiation round: answer the client's haves before it sends `done`.
    // A common have ends the negotiation (ACK + ready, then the packfile);
    // no common have means NAK and a flush, and the client sends another
    // round. A client that already sent `done` gets no acknowledgments
    // section at all: git's fetch-pack expects shallow-info or packfile
    // next, and dies on an `acknowledgments` header there.
    const common = firstCommonHave(repo, wants, haves);
    if (common === null) {
      parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), pktFlush());
      return { status: 200, contentType: UPLOAD_RESULT_CT, body: Buffer.concat(parts) };
    }
    parts.push(pktLine('acknowledgments\n'), pktLine(`ACK ${common}\n`), pktLine('ready\n'), pktDelim());
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(pack, 1));
  parts.push(pktFlush());
  return { status: 200, contentType: UPLOAD_RESULT_CT, body: Buffer.concat(parts) };
}

/** The first have that is a want itself or an ancestor of a want, if any. */
function firstCommonHave(repo: Repo, wants: string[], haves: string[]): string | null {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  for (const have of haves) {
    if (repo.objects.get(have) === undefined) continue;
    for (const want of wants) {
      if (want === have) return have;
      if (collectAncestors(want, lookup).has(have)) return have;
    }
  }
  return null;
}

function uploadPackV0(repo: Repo, packets: ReturnType<typeof decodePktLines>): GitResponse {
  const lines = packets.filter((packet) => packet.kind === 'data').map((packet) => packet.payload.toString('utf8').replace(/\n$/, ''));
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let seenFlush = false;
  for (const line of lines) {
    if (line.startsWith('want ')) {
      wants.push(line.slice(5).split(' ')[0]!);
    } else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line === 'done') {
      // end of negotiation
    }
    void seenFlush;
  }
  if (depth !== null && !Number.isFinite(depth)) depth = null;
  for (const want of wants) {
    if (!isObjectId(want) || repo.objects.get(want) === undefined) {
      return jsonResponse(400, { message: `unknown object ${want}` });
    }
  }
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const pack = packOf(plan.objects);
  const common = firstCommonHave(repo, wants, haves);
  const parts: Buffer[] = [pktLine(common === null ? 'NAK\n' : `ACK ${common}\n`)];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPackets(pack, 1));
  parts.push(pktFlush());
  return { status: 200, contentType: UPLOAD_RESULT_CT, body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(store: Store, owner: string, repoName: string, body: Buffer): GitResponse {
  const repo = repoOr404(store, owner, repoName);
  if (!(repo instanceof Object) || !('refs' in repo)) return repo as GitResponse;
  // The command list is pkt-lined up to the first flush; the pack follows raw.
  let flushEnd = -1;
  let offset = 0;
  const commands: PushCommand[] = [];
  let malformed = false;
  let clientSideband = false;
  while (offset + 4 <= body.length) {
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (head === '0000') {
      flushEnd = offset + 4;
      break;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || offset + len > body.length) {
      malformed = true;
      break;
    }
    const line = body.subarray(offset + 4, offset + len).toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const text = nul < 0 ? line : line.slice(0, nul);
    // The first command line carries the client's capabilities after a NUL.
    if (nul >= 0 && commands.length === 0) {
      clientSideband = line.slice(nul + 1).split(' ').includes('side-band-64k');
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(text);
    if (match === null) {
      malformed = true;
      break;
    }
    commands.push({ oldOid: match[1]!, newOid: match[2]!, ref: match[3]! });
    offset += len;
  }
  if (malformed || flushEnd < 0 || commands.length === 0) {
    return jsonResponse(400, { message: 'malformed receive-pack request' });
  }
  const packBytes = body.subarray(flushEnd);
  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const { objects } = readPack(packBytes);
      for (const [oid, object] of objects) repo.objects.set(oid, object);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref) ?? ZERO_OID;
      if (!command.ref.startsWith('refs/')) {
        reportLines.push(`ng ${command.ref} invalid ref\n`);
        continue;
      }
      if (command.oldOid !== current) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
      if (command.newOid === ZERO_OID) {
        if (current === ZERO_OID) {
          reportLines.push(`ng ${command.ref} ref does not exist\n`);
        } else {
          repo.refs.delete(command.ref);
          reportLines.push(`ok ${command.ref}\n`);
        }
        continue;
      }
      const target = lookup(command.newOid);
      if (target === undefined) {
        reportLines.push(`ng ${command.ref} object not found\n`);
        continue;
      }
      if (current !== ZERO_OID) {
        if (target.type !== 'commit') {
          reportLines.push(`ng ${command.ref} non-fast-forward\n`);
          continue;
        }
        const ancestors = new Set<string>();
        const stack = [command.newOid];
        while (stack.length > 0) {
          const oid = stack.pop()!;
          if (ancestors.has(oid)) continue;
          ancestors.add(oid);
          const object = lookup(oid);
          if (object === undefined || object.type !== 'commit') continue;
          for (const parent of parseCommit(object.data).parents) stack.push(parent);
        }
        if (!ancestors.has(current)) {
          reportLines.push(`ng ${command.ref} non-fast-forward\n`);
          continue;
        }
      }
      repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}\n`);
    }
  } else {
    for (const command of commands) reportLines.push(`ng ${command.ref} unpack failed\n`);
  }
  const reportText = `unpack ${unpackOk ? 'ok' : unpackDetail}\n${reportLines.join('')}`;
  const reportLinesPkt = reportText.split('\n').filter((line) => line !== '').map((line) => `${line}\n`);
  // The report is a pkt-line stream that ends with a flush. With sideband
  // the whole stream — flush included — travels inside band-1 packets, and
  // the response ends with one more bare flush (git's receive-pack writes
  // the report through send_sideband, then packet_flush). Without sideband
  // the stream is sent raw and ends with its own flush. One flush too few
  // and git reports "the remote end hung up unexpectedly".
  const reportPkt = encodePktLines([...reportLinesPkt, 'flush']);
  const parts: Buffer[] = clientSideband
    ? [...sidebandPackets(reportPkt, 1), pktFlush()]
    : [reportPkt];
  return { status: 200, contentType: RECEIVE_RESULT_CT, body: Buffer.concat(parts) };
}
