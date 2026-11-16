// store.ts — the forge's whole state, in memory: repositories, git objects and
// refs, issues, pull requests, labels and comments. Deterministic by design:
// every timestamp and id derives from a counter, never the wall clock, so two
// runs on the same requests leave the same state.
//
// The token owner (the login every suite check uses) is the scenario's fixed
// viewer, derived from the kit's constant SCENARIO_SEED (wire.ts
// buildScenario): login "adaiversen", id 1000. It is a constant of the
// competition, not of this server, and the local test run re-derives it from
// the kit to prove the constant still holds.

import {
  buildCommit,
  buildTag,
  buildTree,
  collectAncestors,
  collectReachable,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  ZERO_OID,
  type GitObject,
  type TreeEntry,
} from './gitobj.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const SERVER_NAME = 'github-forge';
export const SERVER_VERSION = '1.0.0';

/** Deterministic base time: 2025-01-01T00:00:00Z, one second per sequence step. */
const TIME_BASE_MS = Date.parse('2025-01-01T00:00:00Z');
/** Deterministic base commit timestamp (Unix seconds). */
const COMMIT_BASE_SEC = 1700000000;

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  globalId: string;
  body: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  globalId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  globalId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: string;
  databaseId: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  seq: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextNumber: number;
  nextCommentId: number;
  nextIssueId: number;
  createdAt: string;
  updatedAt: string;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
}

export class Store {
  repos = new Map<string, Repo>();
  private seq = 0;
  private nextDatabaseId = 1;
  private nextGlobalIssueId = 1;

  /** Next deterministic sequence step (timestamps and ids derive from it). */
  private tick(): number {
    this.seq += 1;
    return this.seq;
  }

  isoNow(): string {
    return new Date(TIME_BASE_MS + this.tick() * 1000).toISOString();
  }

  private commitTimestamp(): number {
    return COMMIT_BASE_SEC + this.tick();
  }

  private identity(): string {
    return `${VIEWER_LOGIN} <${VIEWER_EMAIL}>`;
  }

  /** An opaque, stable global id: base64 of "kind:parts...". */
  globalId(kind: string, ...parts: Array<string | number>): string {
    return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64');
  }

  /** Decode a global id into its kind and parts, or null when it is not one. */
  parseGlobalId(id: string): { kind: string; parts: string[] } | null {
    try {
      const text = Buffer.from(id, 'base64').toString('utf8');
      const parts = text.split(':');
      const kind = parts.shift();
      if (kind === undefined || parts.length === 0) return null;
      return { kind, parts };
    } catch {
      return null;
    }
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  createRepo(owner: string, name: string, opts: { description?: string; private?: boolean } = {}): Repo | null {
    if (this.repos.has(this.repoKey(owner, name))) return null;
    const seq = this.tick();
    const databaseId = this.nextDatabaseId;
    this.nextDatabaseId += 1;
    const now = new Date(TIME_BASE_MS + seq * 1000).toISOString();
    const repo: Repo = {
      id: this.globalId('R', databaseId),
      databaseId,
      name,
      owner,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: 'main',
      seq,
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      nextCommentId: 1,
      nextIssueId: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  // ---------------------------------------------------------------- refs

  getRef(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** Resolve a branch name, a full ref or a commit oid to a commit oid. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (repo.refs.has(ref)) return repo.refs.get(ref);
    const head = repo.refs.get(`refs/heads/${ref}`);
    if (head !== undefined) return head;
    if (repo.objects.has(ref)) return ref;
    return undefined;
  }

  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  listBranches(repo: Repo): Array<{ name: string; sha: string }> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    return out;
  }

  /** Commits on a branch, newest first, following first parents. */
  listCommits(repo: Repo, ref?: string): string[] {
    const tip = ref === undefined ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) : this.resolveRef(repo, ref);
    if (tip === undefined || tip === ZERO_OID) return [];
    const out: string[] = [];
    let current: string | undefined = tip;
    const seen = new Set<string>();
    while (current !== undefined && current !== ZERO_OID && !seen.has(current)) {
      seen.add(current);
      const object = repo.objects.get(current);
      if (object === undefined || object.type !== 'commit') break;
      out.push(current);
      current = parseCommit(object.data).parents[0];
    }
    return out;
  }

  // ---------------------------------------------------------------- objects / trees

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  putObject(repo: Repo, object: GitObject): string {
    const oid = hashObject(object.type, object.data);
    repo.objects.set(oid, object);
    return oid;
  }

  /** The flat path -> entry map of a commit's tree (recursive). */
  treeMap(repo: Repo, commitOid: string): Map<string, { mode: string; oid: string }> {
    const out = new Map<string, { mode: string; oid: string }>();
    const commit = repo.objects.get(commitOid);
    if (commit === undefined || commit.type !== 'commit') return out;
    const walk = (treeOid: string, prefix: string): void => {
      const tree = repo.objects.get(treeOid);
      if (tree === undefined || tree.type !== 'tree') return;
      for (const entry of parseTree(tree.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { mode: entry.mode, oid: entry.oid });
      }
    };
    walk(parseCommit(commit.data).tree, '');
    return out;
  }

  /**
   * Build nested tree objects from a flat path map and store them; returns
   * the root tree oid. Directories are created as needed.
   */
  buildTreeFromFiles(repo: Repo, files: Map<string, { mode: string; oid: string }>): string {
    interface Node {
      files: Map<string, TreeEntry>;
      dirs: Map<string, Node>;
    }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, entry] of files) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const segment = segments[i]!;
        let child = node.dirs.get(segment);
        if (child === undefined) {
          child = { files: new Map(), dirs: new Map() };
          node.dirs.set(segment, child);
        }
        node = child;
      }
      node.files.set(segments[segments.length - 1]!, { mode: entry.mode, name: segments[segments.length - 1]!, oid: entry.oid });
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [...node.files.values()];
      for (const [name, child] of node.dirs) {
        entries.push({ mode: '40000', name, oid: build(child) });
      }
      const data = buildTree(entries);
      return this.putObject(repo, { type: 'tree', data });
    };
    return build(root);
  }

  /** Create a commit over a flat file map; stores blobs, trees and commit. */
  createCommit(repo: Repo, files: Map<string, Buffer>, parents: string[], message: string): string {
    const flat = new Map<string, { mode: string; oid: string }>();
    for (const [path, content] of files) {
      const oid = this.putObject(repo, { type: 'blob', data: content });
      flat.set(path, { mode: '100644', oid });
    }
    const tree = this.buildTreeFromFiles(repo, flat);
    return this.createCommitFromTree(repo, tree, parents, message);
  }

  createCommitFromTree(repo: Repo, tree: string, parents: string[], message: string): string {
    const ts = this.commitTimestamp();
    const who = `${this.identity()} ${ts} +0000`;
    const data = buildCommit({ tree, parents, author: who, committer: who, message });
    return this.putObject(repo, { type: 'commit', data });
  }

  /** The merge-base of two commits: the first common ancestor walking from head. */
  mergeBase(repo: Repo, head: string, base: string): string | undefined {
    const baseAncestors = collectAncestors(base, this.lookup(repo));
    const seen = new Set<string>();
    const stack = [head];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid) || oid === ZERO_OID) continue;
      seen.add(oid);
      if (baseAncestors.has(oid)) return oid;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    return undefined;
  }

  // ---------------------------------------------------------------- contents

  /**
   * Write one file on a branch. A branch that does not exist yet is created
   * from the default branch tip (the contents API's branch-creation route,
   * which the MCP setup falls back to); the default branch of an unborn repo
   * starts empty. Returns the commit and blob shas, or 'stale-sha' (409)
   * when an update names the wrong blob sha.
   */
  putContent(
    repo: Repo,
    opts: { path: string; content: Buffer; message: string; branch?: string; sha?: string },
  ): { commitSha: string; contentSha: string } | { error: 'stale-sha' } {
    const branch = opts.branch ?? repo.defaultBranch;
    let tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined && branch !== repo.defaultBranch) {
      tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    }
    const current = tip === undefined ? new Map<string, { mode: string; oid: string }>() : this.treeMap(repo, tip);
    const existing = current.get(opts.path);
    if (existing !== undefined) {
      if (opts.sha === undefined || opts.sha.toLowerCase() !== existing.oid.toLowerCase()) {
        return { error: 'stale-sha' };
      }
    }
    const blobOid = this.putObject(repo, { type: 'blob', data: opts.content });
    const next = new Map(current);
    next.set(opts.path, { mode: '100644', oid: blobOid });
    const tree = this.buildTreeFromFiles(repo, next);
    const commitSha = this.createCommitFromTree(repo, tree, tip === undefined ? [] : [tip], opts.message);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha, contentSha: blobOid };
  }

  /** Delete one file on a branch. Error kinds: 'no-branch', 'not-found', 'stale-sha'. */
  deleteContent(
    repo: Repo,
    opts: { path: string; message: string; branch?: string; sha?: string },
  ): { commitSha: string } | { error: 'no-branch' | 'not-found' | 'stale-sha' } {
    const branch = opts.branch ?? repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) return { error: 'no-branch' };
    const current = this.treeMap(repo, tip);
    const existing = current.get(opts.path);
    if (existing === undefined) return { error: 'not-found' };
    if (opts.sha !== undefined && opts.sha.toLowerCase() !== existing.oid.toLowerCase()) {
      return { error: 'stale-sha' };
    }
    const next = new Map(current);
    next.delete(opts.path);
    const tree = this.buildTreeFromFiles(repo, next);
    const commitSha = this.createCommitFromTree(repo, tree, [tip], opts.message);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha };
  }

  /** Read one path at a ref: a file, a directory listing, or null. */
  readContent(
    repo: Repo,
    path: string,
    ref?: string,
  ): { kind: 'file'; name: string; path: string; sha: string; size: number; content: Buffer } | { kind: 'dir'; entries: Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string }> } | null {
    const tip = ref === undefined ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) : this.resolveRef(repo, ref);
    if (tip === undefined) return null;
    const flat = this.treeMap(repo, tip);
    const clean = path.replace(/^\/+/, '').replace(/\/+$/, '');
    if (clean === '') {
      const entries = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
      for (const [filePath, entry] of flat) {
        const first = filePath.split('/')[0]!;
        const rest = filePath.slice(first.length + 1);
        if (rest === '') entries.set(first, { type: 'file', name: first, path: filePath, sha: entry.oid });
        else if (!entries.has(first)) {
          const dirOid = this.dirOid(repo, tip, first);
          entries.set(first, { type: 'dir', name: first, path: first, sha: dirOid ?? '' });
        }
      }
      return { kind: 'dir', entries: [...entries.values()] };
    }
    const file = flat.get(clean);
    if (file !== undefined) {
      const blob = repo.objects.get(file.oid);
      if (blob === undefined) return null;
      return { kind: 'file', name: clean.split('/').pop()!, path: clean, sha: file.oid, size: blob.data.length, content: blob.data };
    }
    // A directory: every flat path under clean + '/'.
    const prefix = `${clean}/`;
    const entries = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
    for (const [filePath, entry] of flat) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const first = rest.split('/')[0]!;
      if (rest === first) entries.set(first, { type: 'file', name: first, path: filePath, sha: entry.oid });
      else if (!entries.has(first)) {
        const dirOid = this.dirOid(repo, tip, `${clean}/${first}`);
        entries.set(first, { type: 'dir', name: first, path: `${clean}/${first}`, sha: dirOid ?? '' });
      }
    }
    if (entries.size === 0) return null;
    return { kind: 'dir', entries: [...entries.values()] };
  }

  private dirOid(repo: Repo, commitOid: string, dirPath: string): string | undefined {
    const commit = repo.objects.get(commitOid);
    if (commit === undefined || commit.type !== 'commit') return undefined;
    let treeOid = parseCommit(commit.data).tree;
    for (const segment of dirPath.split('/')) {
      const tree = repo.objects.get(treeOid);
      if (tree === undefined || tree.type !== 'tree') return undefined;
      const entry = parseTree(tree.data).find((candidate) => candidate.name === segment);
      if (entry === undefined) return undefined;
      treeOid = entry.oid;
    }
    return treeOid;
  }

  // ---------------------------------------------------------------- labels / issues

  createLabel(repo: Repo, name: string, color?: string): Label {
    const existing = repo.labels.get(name);
    if (existing !== undefined) return existing;
    const label: Label = { name, color: color ?? 'ededed' };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, opts: { title: string; body?: string; labels?: string[] }): Issue | { error: 'bad-label'; label: string } {
    const labels: Label[] = [];
    for (const name of opts.labels ?? []) {
      const label = repo.labels.get(name);
      if (label === undefined) return { error: 'bad-label', label: name };
      labels.push(label);
    }
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const now = this.isoNow();
    const issue: Issue = {
      id: this.nextGlobalIssueId,
      globalId: this.globalId('I', repo.databaseId, number),
      number,
      title: opts.title,
      body: opts.body ?? '',
      state: 'open',
      labels,
      comments: [],
      createdAt: now,
      updatedAt: now,
    };
    this.nextGlobalIssueId += 1;
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  listIssues(repo: Repo, opts: { state?: string; sort?: string; direction?: string } = {}): Issue[] {
    const state = opts.state ?? 'open';
    let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    const direction = opts.direction ?? 'desc';
    list = [...list].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
    return list;
  }

  createComment(repo: Repo, issue: Issue, body: string): Comment {
    const comment: Comment = {
      id: repo.nextCommentId,
      globalId: this.globalId('C', repo.databaseId, repo.nextCommentId),
      body,
      createdAt: this.isoNow(),
    };
    repo.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  // ---------------------------------------------------------------- pulls

  createPull(repo: Repo, opts: { head: string; base: string; title: string; body?: string }): Pull | { error: 'no-branch'; ref: string } {
    const headSha = this.branchTip(repo, opts.head);
    if (headSha === undefined) return { error: 'no-branch', ref: opts.head };
    const baseSha = this.branchTip(repo, opts.base);
    if (baseSha === undefined) return { error: 'no-branch', ref: opts.base };
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const now = this.isoNow();
    const pull: Pull = {
      id: this.nextGlobalIssueId,
      globalId: this.globalId('P', repo.databaseId, number),
      number,
      title: opts.title,
      body: opts.body ?? '',
      state: 'open',
      head: opts.head,
      base: opts.base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdAt: now,
      updatedAt: now,
    };
    this.nextGlobalIssueId += 1;
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  listPulls(repo: Repo, opts: { state?: string } = {}): Pull[] {
    const state = opts.state ?? 'open';
    return repo.pulls.filter((pull) => state === 'all' || pull.state === state);
  }

  /** Whether a squash merge of this pull would conflict (three-way, per file). */
  mergeWouldConflict(repo: Repo, pull: Pull): boolean {
    const baseTip = this.branchTip(repo, pull.base);
    if (baseTip === undefined) return true;
    const headTip = pull.headSha;
    const base = this.mergeBase(repo, headTip, baseTip);
    if (base === undefined) return false;
    const baseTree = this.treeMap(repo, base);
    const headTree = this.treeMap(repo, headTip);
    const tipTree = this.treeMap(repo, baseTip);
    const paths = new Set([...baseTree.keys(), ...headTree.keys(), ...tipTree.keys()]);
    for (const path of paths) {
      const b = baseTree.get(path)?.oid;
      const h = headTree.get(path)?.oid;
      const t = tipTree.get(path)?.oid;
      if (h === b) continue;
      if (t === b) continue;
      if (h === t) continue;
      return true;
    }
    return false;
  }

  /**
   * Squash-merge a pull request onto its base branch: one commit whose tree
   * is the three-way merge and whose parent is the base tip. Returns the
   * merge commit sha, or an error kind.
   */
  mergePull(repo: Repo, pull: Pull): { sha: string } | { error: 'conflict' | 'no-branch' | 'closed' } {
    if (pull.state !== 'open') return { error: 'closed' };
    const baseTip = this.branchTip(repo, pull.base);
    if (baseTip === undefined) return { error: 'no-branch' };
    const headTip = pull.headSha;
    const base = this.mergeBase(repo, headTip, baseTip);
    const baseTree = base === undefined ? new Map() : this.treeMap(repo, base);
    const headTree = this.treeMap(repo, headTip);
    const tipTree = this.treeMap(repo, baseTip);
    const merged = new Map<string, { mode: string; oid: string }>();
    const paths = new Set([...baseTree.keys(), ...headTree.keys(), ...tipTree.keys()]);
    for (const path of paths) {
      const b = baseTree.get(path);
      const h = headTree.get(path);
      const t = tipTree.get(path);
      if (h?.oid === b?.oid) {
        if (t !== undefined) merged.set(path, t);
      } else if (t?.oid === b?.oid) {
        if (h !== undefined) merged.set(path, h);
      } else if (h?.oid === t?.oid) {
        if (h !== undefined) merged.set(path, h);
      } else {
        return { error: 'conflict' };
      }
    }
    const tree = this.buildTreeFromFiles(repo, merged);
    const sha = this.createCommitFromTree(repo, tree, [baseTip], `Merge pull request #${pull.number} from ${repo.owner}/${pull.head}`);
    repo.refs.set(`refs/heads/${pull.base}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.isoNow();
    pull.mergeCommitSha = sha;
    pull.updatedAt = pull.mergedAt;
    return { sha };
  }

  /** The changed files of a pull request, base tip vs head tip. */
  pullFiles(repo: Repo, pull: Pull): PullFile[] {
    const baseTree = this.treeMap(repo, pull.baseSha);
    const headTree = this.treeMap(repo, pull.headSha);
    const paths = new Set([...baseTree.keys(), ...headTree.keys()]);
    const out: PullFile[] = [];
    for (const path of [...paths].sort()) {
      const b = baseTree.get(path);
      const h = headTree.get(path);
      if (b?.oid === h?.oid) continue;
      const oldData = b === undefined ? undefined : repo.objects.get(b.oid)?.data;
      const newData = h === undefined ? undefined : repo.objects.get(h.oid)?.data;
      const { additions, deletions } = diffLines(oldData, newData);
      out.push({
        filename: path,
        status: b === undefined ? 'added' : h === undefined ? 'removed' : 'modified',
        additions,
        deletions,
        changes: additions + deletions,
        sha: h?.oid ?? b?.oid ?? '',
      });
    }
    return out;
  }

  // ---------------------------------------------------------------- global-id resolution

  /** Find the object a global id names: a repo, an issue, a pull or a comment. */
  resolveGlobalId(id: string): { repo: Repo; issue?: Issue; pull?: Pull; comment?: Comment } | null {
    const parsed = this.parseGlobalId(id);
    if (parsed === null) return null;
    const [kind, dbId, num] = [parsed.kind, Number(parsed.parts[0]), Number(parsed.parts[1])];
    for (const repo of this.repos.values()) {
      if (repo.databaseId !== dbId) continue;
      if (kind === 'R') return { repo };
      if (kind === 'I') {
        const issue = repo.issues.find((entry) => entry.number === num);
        return issue === undefined ? null : { repo, issue };
      }
      if (kind === 'P') {
        const pull = repo.pulls.find((entry) => entry.number === num);
        return pull === undefined ? null : { repo, pull };
      }
      if (kind === 'C') {
        for (const issue of repo.issues) {
          const comment = issue.comments.find((entry) => entry.id === num);
          if (comment !== undefined) return { repo, issue, comment };
        }
        return null;
      }
    }
    return null;
  }

  /** The object store lookup bound to one repo (for git reachability). */
  lookupFor(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  /** Re-exported for callers that walk a repo's graph. */
  reachable(repo: Repo, tips: Iterable<string>): Set<string> {
    return collectReachable(tips, this.lookupFor(repo));
  }
}

/** Line counts of a change, by multiset difference of lines. */
export function diffLines(oldData: Buffer | undefined, newData: Buffer | undefined): { additions: number; deletions: number } {
  const split = (data: Buffer | undefined): string[] => {
    if (data === undefined) return [];
    const text = data.toString('utf8');
    if (text === '') return [];
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  const oldLines = split(oldData);
  const newLines = split(newData);
  const oldCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const left = oldCounts.get(line) ?? 0;
    if (left > 0) oldCounts.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of oldCounts.values()) deletions += left;
  return { additions, deletions };
}

/** Re-export for modules that only import the store. */
export { buildTag, parseTag, ZERO_OID };
