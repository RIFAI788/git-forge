// mcp.ts — Model Context Protocol over Streamable HTTP (JSON-RPC 2.0, plain
// JSON answers): server/discover for the 2026-07-28 era, the initialize
// handshake for earlier revisions, tools/list and tools/call over the same
// store the REST surface uses. No sessions are needed: every request is
// independent, and tools/list answers byte-identically every time.

import { Store, SERVER_NAME, SERVER_VERSION, VIEWER_LOGIN } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

export interface McpResult {
  status: number;
  body: unknown;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function serverInfo(): { name: string; version: string } {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

function toolResult(data: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const str = (value: unknown): string => (typeof value === 'string' ? value : '');
  const num = (value: unknown): number => (typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10));
  switch (name) {
    case 'create_repo': {
      const repoName = str(args.name);
      if (repoName === '') return toolError('name is required');
      if (store.getRepo(VIEWER_LOGIN, repoName) !== undefined) return toolError(`Repository ${repoName} already exists`);
      const repo = store.createRepo(VIEWER_LOGIN, repoName, {
        description: typeof args.description === 'string' ? args.description : undefined,
        private: typeof args.private === 'boolean' ? args.private : undefined,
      });
      if (repo === null) return toolError(`Repository ${repoName} already exists`);
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = store.getRepo(str(args.owner), str(args.repo));
      if (repo === undefined) return toolError(`Repository ${str(args.owner)}/${str(args.repo)} not found`);
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = store.getRepo(str(args.owner), str(args.repo));
      if (repo === undefined) return toolError(`Repository ${str(args.owner)}/${str(args.repo)} not found`);
      const title = str(args.title);
      if (title === '') return toolError('title is required');
      const created = store.createIssue(repo, { title, body: typeof args.body === 'string' ? args.body : undefined });
      if ('error' in created) return toolError(`Label ${created.label} does not exist`);
      return toolResult(issueJson(created));
    }
    case 'list_issues': {
      const repo = store.getRepo(str(args.owner), str(args.repo));
      if (repo === undefined) return toolError(`Repository ${str(args.owner)}/${str(args.repo)} not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = store.listIssues(repo, { state });
      return toolResult(issues.map(issueJson));
    }
    case 'create_pull_request': {
      const repo = store.getRepo(str(args.owner), str(args.repo));
      if (repo === undefined) return toolError(`Repository ${str(args.owner)}/${str(args.repo)} not found`);
      const created = store.createPull(repo, {
        head: str(args.head),
        base: str(args.base),
        title: str(args.title),
      });
      if ('error' in created) return toolError(`Branch ${created.ref} does not exist`);
      return toolResult(pullJson(repo, created));
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(str(args.owner), str(args.repo));
      if (repo === undefined) return toolError(`Repository ${str(args.owner)}/${str(args.repo)} not found`);
      const pull = store.getPull(repo, num(args.pull_number));
      if (pull === undefined) return toolError(`Pull request ${num(args.pull_number)} not found`);
      const merged = store.mergePull(repo, pull);
      if ('error' in merged) {
        if (merged.error === 'conflict') return toolError('Merge conflict');
        if (merged.error === 'closed') return toolError('Pull request is already closed');
        return toolError('Base branch not found');
      }
      return toolResult(pullJson(repo, pull));
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/**
 * Handle one POST /mcp body. `raw` is the exact request text (a body that
 * is not JSON answers HTTP 400 with JSON-RPC -32700).
 */
export function handleMcp(store: Store, raw: Buffer): McpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error') };
  }
  if (!isRecord(parsed)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  }
  const request = parsed as JsonRpcRequest;
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = isRecord(request.params) ? request.params : {};

  // A notification (no id) is answered with 202 and no body.
  const isNotification = id === undefined;

  if (method === 'server/discover') {
    if (isNotification) return { status: 202, body: null };
    return {
      status: 200,
      body: rpcResult(id, {
        serverInfo: serverInfo(),
        capabilities: { tools: {} },
        supportedVersions: SUPPORTED_VERSIONS,
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
      }),
    };
  }

  if (method === 'initialize') {
    if (isNotification) return { status: 202, body: null };
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: serverInfo(),
      }),
    };
  }

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }

  if (method === 'ping') {
    if (isNotification) return { status: 202, body: null };
    return { status: 200, body: rpcResult(id, {}) };
  }

  if (method === 'tools/list') {
    if (isNotification) return { status: 202, body: null };
    return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
  }

  if (method === 'tools/call') {
    if (isNotification) return { status: 202, body: null };
    const toolName = typeof params.name === 'string' ? params.name : '';
    const tool = TOOLS.find((entry) => entry.name === toolName);
    if (tool === undefined) {
      return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${toolName}`) };
    }
    const args = isRecord(params.arguments) ? params.arguments : {};
    const missing = tool.inputSchema.required.filter((key) => args[key] === undefined);
    if (missing.length > 0) {
      return { status: 200, body: rpcResult(id, toolError(`Missing required argument(s): ${missing.join(', ')}`)) };
    }
    return { status: 200, body: rpcResult(id, callTool(store, toolName, args)) };
  }

  if (isNotification) return { status: 202, body: null };
  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
}
