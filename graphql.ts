// graphql.ts — GitHub GraphQL v4 for the documents gh and github-mcp-server
// send: a small recursive-descent parser for the query subset, plus resolvers
// over the same store the REST surface uses. Unknown fields answer HTTP 200
// with an errors array naming the field; an unknown repository is
// data.repository = null with no errors; batched bodies answer in order.

import {
  Store,
  VIEWER_ID,
  VIEWER_LOGIN,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------- parsing

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Record<string, Value> };

interface FieldSelection {
  kind: 'field';
  alias?: string;
  name: string;
  args: Record<string, Value>;
  selections: Selection[];
}

interface FragmentSelection {
  kind: 'fragment';
  typeCondition: string;
  selections: Selection[];
}

type Selection = FieldSelection | FragmentSelection;

interface Operation {
  type: 'query' | 'mutation';
  name?: string;
  variables: Array<{ name: string; defaultValue?: Value }>;
  selections: Selection[];
}

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():$=![]'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'number', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }

  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): Operation {
    let type: 'query' | 'mutation' = 'query';
    let name: string | undefined;
    const first = this.peek();
    if (first !== undefined && first.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      this.next();
      type = first.value as 'query' | 'mutation';
      const maybeName = this.peek();
      if (maybeName !== undefined && maybeName.kind === 'name') name = this.next().value;
    }
    const variables: Operation['variables'] = [];
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let defaultValue: Value | undefined;
        if (this.acceptPunct('=')) defaultValue = this.parseValue();
        variables.push({ name: varName, defaultValue });
      }
    }
    const selections = this.parseSelections();
    return { type, name, variables, selections };
  }

  private parseType(): void {
    if (this.acceptPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.acceptPunct('!');
  }

  private parseSelections(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.acceptPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): Selection {
    if (this.acceptPunct('...')) {
      const next = this.peek();
      if (next !== undefined && next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'fragment', typeCondition, selections: this.parseSelections() };
      }
      throw new Error('named fragment spreads are not supported');
    }
    let alias: string | undefined;
    let name = this.expectName();
    if (this.acceptPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args: Record<string, Value> = {};
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
    }
    let selections: Selection[] = [];
    const next = this.peek();
    if (next !== undefined && next.kind === 'punct' && next.value === '{') {
      selections = this.parseSelections();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'var', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: Value[] = [];
      while (!this.acceptPunct(']')) items.push(this.parseValue());
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, Value> = {};
      while (!this.acceptPunct('}')) {
        const key = this.expectName();
        this.expectPunct(':');
        fields[key] = this.parseValue();
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') {
      return token.value.includes('.') || token.value.includes('e') || token.value.includes('E')
        ? { kind: 'float', value: Number.parseFloat(token.value) }
        : { kind: 'int', value: Number.parseInt(token.value, 10) };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return variables[value.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(value.fields)) out[key] = resolveValue(field, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- execution

/** A resolved value, tagged with its GraphQL type for field dispatch. */
interface Typed {
  __type: string;
  value: unknown;
}

interface ConnectionValue {
  nodes: Typed[];
  pageInfo?: { hasNextPage: boolean; endCursor: string | null };
}

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author', 'comments', 'labels', 'repository', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'createdAt', 'updatedAt', 'author', 'repository', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'description', 'private', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'url'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'WIKI', 'PACKAGE', 'MARKETPLACE'],
};

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string | null | undefined): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? -1 : Number.parseInt(match[1], 10);
  } catch {
    return -1;
  }
}

class Executor {
  private errors: Array<{ message: string }> = [];
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  execute(operation: Operation, variables: Record<string, unknown>): { data: Record<string, unknown>; errors?: Array<{ message: string }> } {
    const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
    const root: Typed = { __type: rootType, value: {} };
    const data = this.resolveSelections(root, operation.selections, variables) as Record<string, unknown>;
    const result: { data: Record<string, unknown>; errors?: Array<{ message: string }> } = { data };
    if (this.errors.length > 0) result.errors = this.errors;
    return result;
  }

  /** Resolve a selection set against a typed value; lists map over items. */
  private resolveSelections(parent: Typed, selections: Selection[], variables: Record<string, unknown>): unknown {
    if (parent.__type === 'Null') return null;
    if (parent.__type === 'List') {
      return (parent.value as Typed[]).map((item) => this.resolveSelections(item, selections, variables));
    }
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'fragment') {
        if (selection.typeCondition === parent.__type) {
          Object.assign(out, this.resolveSelections(parent, selection.selections, variables) as Record<string, unknown>);
        }
        continue;
      }
      const key = selection.alias ?? selection.name;
      const args: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(selection.args)) args[name] = resolveValue(value, variables);
      const resolved = this.resolveField(parent, selection.name, args);
      if (resolved === undefined) {
        out[key] = null;
        continue;
      }
      if (resolved.__type === 'Null') {
        out[key] = null;
        continue;
      }
      if (selection.selections.length === 0) {
        out[key] = resolved.value;
      } else {
        out[key] = this.resolveSelections(resolved, selection.selections, variables);
      }
    }
    return out;
  }

  private fieldError(type: string, field: string): undefined {
    this.errors.push({ message: `Cannot query field "${field}" on type "${type}".` });
    return undefined;
  }

  private resolveField(parent: Typed, field: string, args: Record<string, unknown>): Typed | undefined {
    if (field === '__typename') return { __type: 'String', value: parent.__type };
    switch (parent.__type) {
      case 'Query':
        return this.queryField(field, args);
      case 'Mutation':
        return this.mutationField(field, args);
      case 'Repository':
        return this.repositoryField(parent.value as Repo, field, args);
      case 'Issue':
        return this.issueField(parent.value as Issue, field, args);
      case 'PullRequest':
        return this.pullField(parent.value as Pull, field, args);
      case 'User': {
        const user = parent.value as { login: string; id: number };
        if (field === 'login') return { __type: 'String', value: user.login };
        if (field === 'id') return { __type: 'String', value: String(user.id) };
        return this.fieldError('User', field);
      }
      case 'Ref': {
        const ref = parent.value as { name: string };
        if (field === 'name') return { __type: 'String', value: ref.name };
        return this.fieldError('Ref', field);
      }
      case 'IssueConnection':
      case 'PullRequestConnection':
      case 'FileConnection': {
        const conn = parent.value as ConnectionValue;
        if (field === 'nodes') return { __type: 'List', value: conn.nodes };
        if (field === 'pageInfo' && conn.pageInfo !== undefined) return { __type: 'PageInfo', value: conn.pageInfo };
        if (field === 'totalCount') return { __type: 'Int', value: conn.nodes.length };
        return this.fieldError(parent.__type, field);
      }
      case 'PageInfo': {
        const info = parent.value as { hasNextPage: boolean; endCursor: string | null };
        if (field === 'hasNextPage') return { __type: 'Boolean', value: info.hasNextPage };
        if (field === 'endCursor') return { __type: 'String', value: info.endCursor };
        if (field === 'hasPreviousPage') return { __type: 'Boolean', value: false };
        if (field === 'startCursor') return { __type: 'String', value: null };
        return this.fieldError('PageInfo', field);
      }
      case 'CreateIssuePayload':
      case 'CloseIssuePayload': {
        const payload = parent.value as { issue?: Issue };
        if (field === 'issue' && payload.issue !== undefined) return { __type: 'Issue', value: payload.issue };
        return this.fieldError(parent.__type, field);
      }
      case 'CreatePullRequestPayload':
      case 'MergePullRequestPayload': {
        const payload = parent.value as { pullRequest?: Pull };
        if (field === 'pullRequest' && payload.pullRequest !== undefined) return { __type: 'PullRequest', value: payload.pullRequest };
        return this.fieldError(parent.__type, field);
      }
      case 'AddCommentPayload': {
        const payload = parent.value as { commentEdge?: { node: { id: string; body: string } } };
        if (field === 'commentEdge' && payload.commentEdge !== undefined) return { __type: 'IssueCommentEdge', value: payload.commentEdge };
        return this.fieldError(parent.__type, field);
      }
      case 'IssueCommentEdge': {
        const edge = parent.value as { node: { id: string; body: string } };
        if (field === 'node') return { __type: 'IssueComment', value: edge.node };
        return this.fieldError(parent.__type, field);
      }
      case 'IssueComment': {
        const comment = parent.value as { id: string; body: string };
        if (field === 'id') return { __type: 'String', value: comment.id };
        if (field === 'body') return { __type: 'String', value: comment.body };
        return this.fieldError(parent.__type, field);
      }
      case 'PullRequestFile': {
        const file = parent.value as { path: string };
        if (field === 'path') return { __type: 'String', value: file.path };
        return this.fieldError(parent.__type, field);
      }
      case 'Type': {
        const type = parent.value as { name: string };
        if (field === 'name') return { __type: 'String', value: type.name };
        if (field === 'fields') {
          const names = TYPE_FIELDS[type.name] ?? [];
          return { __type: 'List', value: names.map((name) => ({ __type: 'Field', value: { name } }) as Typed) };
        }
        if (field === 'enumValues') {
          const names = TYPE_ENUM_VALUES[type.name] ?? [];
          return { __type: 'List', value: names.map((name) => ({ __type: 'EnumValue', value: { name } }) as Typed) };
        }
        return this.fieldError(parent.__type, field);
      }
      case 'Field':
      case 'EnumValue': {
        const entry = parent.value as { name: string };
        if (field === 'name') return { __type: 'String', value: entry.name };
        return this.fieldError(parent.__type, field);
      }
      default:
        return this.fieldError(parent.__type, field);
    }
  }

  private queryField(field: string, args: Record<string, unknown>): Typed | undefined {
    if (field === 'viewer') return { __type: 'User', value: { login: VIEWER_LOGIN, id: VIEWER_ID } };
    if (field === 'repository') {
      const repo = this.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      if (repo === undefined) return { __type: 'Null', value: null };
      return { __type: 'Repository', value: repo };
    }
    if (field === 'node') {
      const resolved = this.store.resolveGlobalId(String(args.id ?? ''));
      if (resolved === null) return { __type: 'Null', value: null };
      if (resolved.issue !== undefined) return { __type: 'Issue', value: resolved.issue };
      if (resolved.pull !== undefined) return { __type: 'PullRequest', value: resolved.pull };
      return { __type: 'Repository', value: resolved.repo };
    }
    if (field === '__type') {
      const name = String(args.name ?? '');
      if (TYPE_FIELDS[name] === undefined && TYPE_ENUM_VALUES[name] === undefined) {
        return { __type: 'Null', value: null };
      }
      return { __type: 'Type', value: { name } };
    }
    return this.fieldError('Query', field);
  }

  private mutationField(field: string, args: Record<string, unknown>): Typed | undefined {
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (field === 'createIssue') {
      const resolved = this.store.resolveGlobalId(String(input.repositoryId ?? ''));
      if (resolved === null) return this.fieldError('Mutation', field);
      const created = this.store.createIssue(resolved.repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : undefined,
      });
      if ('error' in created) return this.fieldError('Mutation', field);
      return { __type: 'CreateIssuePayload', value: { issue: created } };
    }
    if (field === 'closeIssue') {
      const resolved = this.store.resolveGlobalId(String(input.issueId ?? ''));
      if (resolved === null || resolved.issue === undefined) return this.fieldError('Mutation', field);
      resolved.issue.state = 'closed';
      resolved.issue.updatedAt = this.store.isoNow();
      return { __type: 'CloseIssuePayload', value: { issue: resolved.issue } };
    }
    if (field === 'createPullRequest') {
      const resolved = this.store.resolveGlobalId(String(input.repositoryId ?? ''));
      if (resolved === null) return this.fieldError('Mutation', field);
      const created = this.store.createPull(resolved.repo, {
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
        title: String(input.title ?? ''),
      });
      if ('error' in created) return this.fieldError('Mutation', field);
      return { __type: 'CreatePullRequestPayload', value: { pullRequest: created } };
    }
    if (field === 'mergePullRequest') {
      const resolved = this.store.resolveGlobalId(String(input.pullRequestId ?? ''));
      if (resolved === null || resolved.pull === undefined) return this.fieldError('Mutation', field);
      const merged = this.store.mergePull(resolved.repo, resolved.pull);
      if ('error' in merged) return this.fieldError('Mutation', field);
      return { __type: 'MergePullRequestPayload', value: { pullRequest: resolved.pull } };
    }
    if (field === 'addComment') {
      const resolved = this.store.resolveGlobalId(String(input.subjectId ?? ''));
      if (resolved === null || resolved.issue === undefined) return this.fieldError('Mutation', field);
      const comment = this.store.createComment(resolved.repo, resolved.issue, String(input.body ?? ''));
      return {
        __type: 'AddCommentPayload',
        value: { commentEdge: { node: { id: comment.globalId, body: comment.body } } },
      };
    }
    return this.fieldError('Mutation', field);
  }

  private repositoryField(repo: Repo, field: string, args: Record<string, unknown>): Typed | undefined {
    switch (field) {
      case 'id':
        return { __type: 'String', value: repo.id };
      case 'databaseId':
        return { __type: 'Int', value: repo.databaseId };
      case 'name':
        return { __type: 'String', value: repo.name };
      case 'nameWithOwner':
        return { __type: 'String', value: `${repo.owner}/${repo.name}` };
      case 'owner':
        return { __type: 'User', value: { login: repo.owner, id: VIEWER_ID } };
      case 'defaultBranchRef':
        return { __type: 'Ref', value: { name: repo.defaultBranch } };
      case 'viewerPermission':
        return { __type: 'String', value: 'ADMIN' };
      case 'hasIssuesEnabled':
        return { __type: 'Boolean', value: true };
      case 'description':
        return { __type: 'String', value: repo.description };
      case 'private':
        return { __type: 'Boolean', value: repo.private };
      case 'createdAt':
        return { __type: 'String', value: repo.createdAt };
      case 'url':
        return { __type: 'String', value: `https://github.com/${repo.owner}/${repo.name}` };
      case 'issue': {
        const issue = this.store.getIssue(repo, Number(args.number ?? 0));
        if (issue === undefined) return { __type: 'Null', value: null };
        return { __type: 'Issue', value: issue };
      }
      case 'issues':
        return this.issuesConnection(repo, args);
      case 'pullRequests':
        return this.pullsConnection(repo, args);
      case 'pullRequest': {
        const pull = this.store.getPull(repo, Number(args.number ?? 0));
        if (pull === undefined) return { __type: 'Null', value: null };
        return { __type: 'PullRequest', value: pull };
      }
      default:
        return this.fieldError('Repository', field);
    }
  }

  private issuesConnection(repo: Repo, args: Record<string, unknown>): Typed {
    const states = Array.isArray(args.states) ? (args.states as string[]) : null;
    let issues = [...repo.issues];
    if (states !== null) {
      const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : state.toLowerCase())));
      issues = issues.filter((issue) => wanted.has(issue.state));
    }
    const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
    if (orderBy.field === 'CREATED_AT' && orderBy.direction === 'DESC') {
      issues.sort((a, b) => b.number - a.number);
    } else {
      issues.sort((a, b) => a.number - b.number);
    }
    const after = decodeCursor(typeof args.after === 'string' ? args.after : null);
    const start = after + 1;
    const first = typeof args.first === 'number' ? args.first : issues.length;
    const slice = issues.slice(start, start + first);
    const endIndex = start + slice.length - 1;
    return {
      __type: 'IssueConnection',
      value: {
        nodes: slice.map((issue) => ({ __type: 'Issue', value: issue }) as Typed),
        pageInfo: {
          hasNextPage: start + slice.length < issues.length,
          endCursor: slice.length > 0 ? encodeCursor(endIndex) : null,
        },
      } satisfies ConnectionValue,
    };
  }

  private pullsConnection(repo: Repo, args: Record<string, unknown>): Typed {
    const states = Array.isArray(args.states) ? (args.states as string[]) : ['OPEN'];
    const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : state.toLowerCase())));
    let pulls = repo.pulls.filter((pull) => wanted.has(pull.state));
    pulls = [...pulls].sort((a, b) => b.number - a.number);
    const after = decodeCursor(typeof args.after === 'string' ? args.after : null);
    const start = after + 1;
    const first = typeof args.first === 'number' ? args.first : pulls.length;
    const slice = pulls.slice(start, start + first);
    const endIndex = start + slice.length - 1;
    return {
      __type: 'PullRequestConnection',
      value: {
        nodes: slice.map((pull) => ({ __type: 'PullRequest', value: pull }) as Typed),
        pageInfo: {
          hasNextPage: start + slice.length < pulls.length,
          endCursor: slice.length > 0 ? encodeCursor(endIndex) : null,
        },
      } satisfies ConnectionValue,
    };
  }

  private issueField(issue: Issue, field: string, args: Record<string, unknown>): Typed | undefined {
    void args;
    switch (field) {
      case 'id':
        return { __type: 'String', value: issue.globalId };
      case 'number':
        return { __type: 'Int', value: issue.number };
      case 'title':
        return { __type: 'String', value: issue.title };
      case 'body':
        return { __type: 'String', value: issue.body };
      case 'state':
        return { __type: 'String', value: issue.state === 'open' ? 'OPEN' : 'CLOSED' };
      case 'createdAt':
        return { __type: 'String', value: issue.createdAt };
      case 'updatedAt':
        return { __type: 'String', value: issue.updatedAt };
      default:
        return this.fieldError('Issue', field);
    }
  }

  private pullField(pull: Pull, field: string, args: Record<string, unknown>): Typed | undefined {
    switch (field) {
      case 'id':
        return { __type: 'String', value: pull.globalId };
      case 'number':
        return { __type: 'Int', value: pull.number };
      case 'title':
        return { __type: 'String', value: pull.title };
      case 'body':
        return { __type: 'String', value: pull.body };
      case 'state':
        return { __type: 'String', value: pull.state === 'open' ? 'OPEN' : 'CLOSED' };
      case 'merged':
        return { __type: 'Boolean', value: pull.merged };
      case 'mergeable': {
        const repo = this.findRepoOfPull(pull);
        const conflict = repo !== undefined && this.store.mergeWouldConflict(repo, pull);
        return { __type: 'String', value: conflict ? 'CONFLICTING' : 'MERGEABLE' };
      }
      case 'headRefName':
        return { __type: 'String', value: pull.head };
      case 'baseRefName':
        return { __type: 'String', value: pull.base };
      case 'createdAt':
        return { __type: 'String', value: pull.createdAt };
      case 'updatedAt':
        return { __type: 'String', value: pull.updatedAt };
      case 'files': {
        const repo = this.findRepoOfPull(pull);
        const files = repo === undefined ? [] : this.store.pullFiles(repo, pull);
        const first = typeof args.first === 'number' ? args.first : files.length;
        return {
          __type: 'FileConnection',
          value: {
            nodes: files.slice(0, first).map((file) => ({ __type: 'PullRequestFile', value: { path: file.filename } }) as Typed),
          } satisfies ConnectionValue,
        };
      }
      default:
        return this.fieldError('PullRequest', field);
    }
  }

  private findRepoOfPull(pull: Pull): Repo | undefined {
    for (const repo of this.store.repos.values()) {
      if (repo.pulls.includes(pull)) return repo;
    }
    return undefined;
  }
}

// ---------------------------------------------------------------- entry point

export interface GraphqlResult {
  status: number;
  body: unknown;
}

/** Execute one GraphQL request body (a single operation or a batch array). */
export function handleGraphql(store: Store, body: unknown): GraphqlResult {
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { errors: [{ message: 'Request must be a JSON object with a query string.' }] };
    }
    const record = entry as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = (record.variables ?? {}) as Record<string, unknown>;
    if (query === '') {
      return { errors: [{ message: 'No query string was provided.' }] };
    }
    let operations: Operation[];
    try {
      operations = new Parser(tokenize(query)).parseDocument();
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : 'Failed to parse the query.' }] };
    }
    if (operations.length === 0) {
      return { errors: [{ message: 'No operation was provided.' }] };
    }
    const operation = operations[0]!;
    const vars: Record<string, unknown> = { ...variables };
    for (const def of operation.variables) {
      if (vars[def.name] === undefined && def.defaultValue !== undefined) {
        vars[def.name] = resolveValue(def.defaultValue, vars);
      }
    }
    return new Executor(store).execute(operation, vars);
  };
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((entry) => runOne(entry)) };
  }
  return { status: 200, body: runOne(body) };
}
