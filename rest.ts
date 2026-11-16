// rest.ts — GitHub REST v3: repositories, branches, commits, contents,
// labels, issues, comments and pull requests. Every reply is JSON and
// carries X-GitHub-Request-Id (added by app.ts); errors carry {message}.

import { parseCommit } from './gitobj.ts';
import {
  Store,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

export interface ApiRequest {
  store: Store;
  method: string;
  /** Path segments after /api/v3, URL-decoded, no empties. */
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  baseUrl: string;
}

export interface ApiResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function notFound(message = 'Not Found'): ApiResult {
  return { status: 404, body: { message } };
}

function badRequest(message: string): ApiResult {
  return { status: 400, body: { message } };
}

function unprocessable(message: string): ApiResult {
  return { status: 422, body: { message } };
}

// ---------------------------------------------------------------- serializers

export function userJson(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    type: 'User',
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    databaseId: repo.databaseId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

export function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

// ---------------------------------------------------------------- pagination

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function paginate<T>(items: readonly T[], query: URLSearchParams, url: string): { page: T[]; link: string | null } {
  const { page, perPage } = pageParams(query);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (totalPages <= 1) return { page: [...slice], link: null };
  const make = (p: number): string => {
    const u = new URL(url);
    u.searchParams.set('page', String(p));
    u.searchParams.set('per_page', String(perPage));
    return u.toString();
  };
  const parts: string[] = [];
  if (page < totalPages) parts.push(`<${make(page + 1)}>; rel="next"`);
  parts.push(`<${make(totalPages)}>; rel="last"`);
  if (page > 1) parts.push(`<${make(1)}>; rel="first"`);
  return { page: [...slice], link: parts.join(', ') };
}

function withLink(result: ApiResult, link: string | null): ApiResult {
  if (link === null) return result;
  return { ...result, headers: { ...(result.headers ?? {}), link } };
}

// ---------------------------------------------------------------- route helpers

function repoOf(req: ApiRequest, owner: string, name: string): Repo | ApiResult {
  const repo = req.store.getRepo(owner, name);
  if (repo === undefined) return notFound('Not Found');
  return repo;
}

function bodyOf(req: ApiRequest): Record<string, unknown> {
  return isRecord(req.body) ? req.body : {};
}

// ---------------------------------------------------------------- the router

export function handleRest(req: ApiRequest): ApiResult | null {
  const [first, ...rest] = req.segments;
  if (first === undefined || first === '') {
    if (req.method === 'GET') {
      return {
        status: 200,
        body: { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
        headers: { 'x-oauth-scopes': 'repo, read:org' },
      };
    }
    return notFound();
  }
  if (first === 'meta' && req.method === 'GET') {
    return { status: 200, body: { installed_version: '1.0.0' } };
  }
  if (first === 'user') return handleUser(req, rest);
  if (first === 'repos') return handleRepos(req, rest);
  return notFound();
}

function handleUser(req: ApiRequest, rest: string[]): ApiResult | null {
  if (rest.length === 0) {
    if (req.method === 'GET') return { status: 200, body: userJson() };
    return notFound();
  }
  if (rest[0] === 'repos') {
    if (req.method === 'GET') {
      const repos = req.store.listRepos(VIEWER_LOGIN);
      const { page, link } = paginate(repos.map(repoJson), req.query, `${req.baseUrl}/api/v3/user/repos`);
      return withLink({ status: 200, body: page }, link);
    }
    if (req.method === 'POST') {
      const body = bodyOf(req);
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') return unprocessable('name is required');
      if (req.store.getRepo(VIEWER_LOGIN, name) !== undefined) {
        return unprocessable('Repository already exists');
      }
      const repo = req.store.createRepo(VIEWER_LOGIN, name, {
        description: typeof body.description === 'string' ? body.description : undefined,
        private: typeof body.private === 'boolean' ? body.private : undefined,
      });
      if (repo === null) return unprocessable('Repository already exists');
      return { status: 201, body: repoJson(repo) };
    }
    return notFound();
  }
  return notFound();
}

function handleRepos(req: ApiRequest, rest: string[]): ApiResult | null {
  const [owner, name, ...tail] = rest;
  if (owner === undefined || name === undefined) return notFound();
  const repo = repoOf(req, owner, name);
  if (!('refs' in repo)) return repo;
  if (tail.length === 0) {
    if (req.method === 'GET') return { status: 200, body: repoJson(repo) };
    if (req.method === 'PATCH') {
      const body = bodyOf(req);
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      return { status: 200, body: repoJson(repo) };
    }
    if (req.method === 'DELETE') {
      req.store.deleteRepo(owner, name);
      return { status: 204, body: null };
    }
    return notFound();
  }
  const [section, ...sub] = tail;
  if (section === 'branches') return handleBranches(req, repo, sub);
  if (section === 'commits') return handleCommits(req, repo);
  if (section === 'git') return handleGitData(req, repo, sub);
  if (section === 'contents') return handleContents(req, repo, sub);
  if (section === 'labels') return handleLabels(req, repo, sub);
  if (section === 'issues') return handleIssues(req, repo, sub);
  if (section === 'pulls') return handlePulls(req, repo, sub);
  return notFound();
}

function handleBranches(req: ApiRequest, repo: Repo, sub: string[]): ApiResult {
  if (req.method === 'GET' && sub.length === 0) {
    const branches = req.store.listBranches(repo).map((branch) => ({
      name: branch.name,
      commit: { sha: branch.sha },
      protected: false,
    }));
    return { status: 200, body: branches };
  }
  if (req.method === 'GET' && sub.length === 1) {
    const tip = req.store.branchTip(repo, sub[0]!);
    if (tip === undefined) return notFound('Branch not found');
    return { status: 200, body: { name: sub[0], commit: { sha: tip }, protected: false } };
  }
  return notFound();
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> {
  const object = repo.objects.get(sha);
  const parsed = object !== undefined && object.type === 'commit' ? parseCommit(object.data) : null;
  const who = parsed?.author ?? `${VIEWER_LOGIN} <${VIEWER_EMAIL}>`;
  const name = who.split('<')[0]!.trim();
  const email = who.split('<')[1]?.split('>')[0] ?? VIEWER_EMAIL;
  // The commit's own author timestamp, as an ISO date.
  const stamp = Number.parseInt(who.trim().split(' ').slice(-2)[0] ?? '0', 10);
  const date = new Date((Number.isFinite(stamp) ? stamp : 0) * 1000).toISOString();
  return {
    sha,
    commit: {
      // GitHub returns the message without the trailing newline that git
      // commit objects carry (buildCommit appends one, as git does).
      message: (parsed?.message ?? '').replace(/\n$/, ''),
      author: { name, email, date },
      committer: { name, email, date },
    },
    parents: (parsed?.parents ?? []).map((parent) => ({ sha: parent })),
  };
}

function handleCommits(req: ApiRequest, repo: Repo): ApiResult {
  if (req.method !== 'GET') return notFound();
  const sha = req.query.get('sha') ?? undefined;
  const commits = req.store.listCommits(repo, sha);
  const { page, link } = paginate(
    commits.map((commit) => commitJson(repo, commit)),
    req.query,
    `${req.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/commits`,
  );
  return withLink({ status: 200, body: page }, link);
}

function handleGitData(req: ApiRequest, repo: Repo, sub: string[]): ApiResult {
  if (sub[0] === 'refs') {
    if (req.method === 'POST' && sub.length === 1) {
      const body = bodyOf(req);
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || sha === '') return unprocessable('ref and sha are required');
      if (repo.objects.get(sha) === undefined) return unprocessable('object not found');
      repo.refs.set(ref, sha);
      return { status: 201, body: { ref, object: { sha } } };
    }
    if (req.method === 'GET' && sub.length >= 2) {
      const ref = sub.join('/');
      const sha = repo.refs.get(ref);
      if (sha === undefined) return notFound('Reference not found');
      return { status: 200, body: { ref, object: { sha } } };
    }
  }
  return notFound();
}

function handleContents(req: ApiRequest, repo: Repo, sub: string[]): ApiResult {
  const path = sub.join('/');
  if (req.method === 'GET') {
    const ref = req.query.get('ref') ?? undefined;
    const found = req.store.readContent(repo, path, ref);
    if (found === null) return notFound('Not Found');
    if (found.kind === 'file') {
      return {
        status: 200,
        body: {
          type: 'file',
          encoding: 'base64',
          size: found.size,
          name: found.name,
          path: found.path,
          content: found.content.toString('base64'),
          sha: found.sha,
        },
      };
    }
    return { status: 200, body: found.entries };
  }
  if (req.method === 'PUT') {
    const body = bodyOf(req);
    const message = typeof body.message === 'string' ? body.message : 'update';
    const content = typeof body.content === 'string' ? body.content : '';
    let bytes: Buffer;
    try {
      bytes = Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
    } catch {
      return badRequest('content is not valid base64');
    }
    const branch = typeof body.branch === 'string' ? body.branch : undefined;
    const sha = typeof body.sha === 'string' ? body.sha : undefined;
    const result = req.store.putContent(repo, { path, content: bytes, message, branch, sha });
    if ('error' in result) {
      if (result.error === 'stale-sha') return { status: 409, body: { message: 'sha does not match the current blob' } };
      return notFound('Branch not found');
    }
    const created = sha === undefined;
    return {
      status: created ? 201 : 200,
      body: {
        content: { sha: result.contentSha, encoding: 'base64' },
        commit: { sha: result.commitSha },
      },
    };
  }
  if (req.method === 'DELETE') {
    const body = bodyOf(req);
    const message = typeof body.message === 'string' ? body.message : 'delete';
    const sha = typeof body.sha === 'string' ? body.sha : undefined;
    const result = req.store.deleteContent(repo, { path, message, sha });
    if ('error' in result) {
      if (result.error === 'not-found') return notFound('Not Found');
      if (result.error === 'stale-sha') return { status: 409, body: { message: 'sha does not match the current blob' } };
      return notFound('Branch not found');
    }
    return { status: 200, body: { commit: { sha: result.commitSha } } };
  }
  return notFound();
}

function handleLabels(req: ApiRequest, repo: Repo, sub: string[]): ApiResult {
  if (req.method === 'GET' && sub.length === 0) {
    return { status: 200, body: [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })) };
  }
  if (req.method === 'POST' && sub.length === 0) {
    const body = bodyOf(req);
    const name = typeof body.name === 'string' ? body.name : '';
    if (name === '') return unprocessable('name is required');
    const label = req.store.createLabel(repo, name, typeof body.color === 'string' ? body.color : undefined);
    return { status: 201, body: { name: label.name, color: label.color } };
  }
  return notFound();
}

function handleIssues(req: ApiRequest, repo: Repo, sub: string[]): ApiResult {
  if (sub.length === 0) {
    if (req.method === 'GET') {
      const list = req.store.listIssues(repo, {
        state: req.query.get('state') ?? undefined,
        sort: req.query.get('sort') ?? undefined,
        direction: req.query.get('direction') ?? undefined,
      });
      const { page, link } = paginate(
        list.map(issueJson),
        req.query,
        `${req.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/issues`,
      );
      return withLink({ status: 200, body: page }, link);
    }
    if (req.method === 'POST') {
      const body = bodyOf(req);
      const title = typeof body.title === 'string' ? body.title : '';
      if (title === '') return unprocessable('title is required');
      const labels = Array.isArray(body.labels) ? body.labels.filter((entry): entry is string => typeof entry === 'string') : undefined;
      const created = req.store.createIssue(repo, {
        title,
        body: typeof body.body === 'string' ? body.body : undefined,
        labels,
      });
      if ('error' in created) return unprocessable(`Label ${created.label} does not exist`);
      return { status: 201, body: issueJson(created) };
    }
    return notFound();
  }
  const number = Number.parseInt(sub[0]!, 10);
  if (!Number.isInteger(number)) return notFound();
  const issue = req.store.getIssue(repo, number);
  if (issue === undefined) return notFound('Issue not found');
  if (sub.length === 1) {
    if (req.method === 'GET') return { status: 200, body: issueJson(issue) };
    if (req.method === 'PATCH') {
      const body = bodyOf(req);
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      issue.updatedAt = req.store.isoNow();
      return { status: 200, body: issueJson(issue) };
    }
    return notFound();
  }
  if (sub[1] === 'comments') {
    if (req.method === 'GET') {
      return {
        status: 200,
        body: issue.comments.map((comment) => ({
          id: comment.id,
          body: comment.body,
          user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
          created_at: comment.createdAt,
          updated_at: comment.createdAt,
        })),
      };
    }
    if (req.method === 'POST') {
      const body = bodyOf(req);
      const text = typeof body.body === 'string' ? body.body : '';
      if (text === '') return unprocessable('body is required');
      const comment = req.store.createComment(repo, issue, text);
      return {
        status: 201,
        body: {
          id: comment.id,
          body: comment.body,
          user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
          created_at: comment.createdAt,
          updated_at: comment.createdAt,
        },
      };
    }
  }
  return notFound();
}

function handlePulls(req: ApiRequest, repo: Repo, sub: string[]): ApiResult {
  if (sub.length === 0) {
    if (req.method === 'GET') {
      const list = req.store.listPulls(repo, { state: req.query.get('state') ?? undefined });
      const { page, link } = paginate(
        list.map((pull) => pullJson(repo, pull)),
        req.query,
        `${req.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/pulls`,
      );
      return withLink({ status: 200, body: page }, link);
    }
    if (req.method === 'POST') {
      const body = bodyOf(req);
      const head = typeof body.head === 'string' ? body.head : '';
      const base = typeof body.base === 'string' ? body.base : '';
      const title = typeof body.title === 'string' ? body.title : '';
      if (head === '' || base === '' || title === '') return unprocessable('head, base and title are required');
      const created = req.store.createPull(repo, {
        head,
        base,
        title,
        body: typeof body.body === 'string' ? body.body : undefined,
      });
      if ('error' in created) return unprocessable(`Branch ${created.ref} does not exist`);
      return { status: 201, body: pullJson(repo, created) };
    }
    return notFound();
  }
  const number = Number.parseInt(sub[0]!, 10);
  if (!Number.isInteger(number)) return notFound();
  const pull = req.store.getPull(repo, number);
  if (pull === undefined) return notFound('Pull request not found');
  if (sub.length === 1) {
    if (req.method === 'GET') return { status: 200, body: pullJson(repo, pull) };
    return notFound();
  }
  if (sub[1] === 'files' && req.method === 'GET') {
    const files = req.store.pullFiles(repo, pull);
    return { status: 200, body: files };
  }
  if (sub[1] === 'merge' && req.method === 'PUT') {
    const result = req.store.mergePull(repo, pull);
    if ('error' in result) {
      if (result.error === 'conflict') return { status: 405, body: { message: 'Merge conflict' } };
      if (result.error === 'closed') return { status: 405, body: { message: 'Pull request is already closed' } };
      return notFound('Base branch not found');
    }
    return { status: 200, body: { sha: result.sha, merged: true, message: `Pull request successfully merged` } };
  }
  return notFound();
}
