// app.ts — the HTTP server: routing, auth, body reading and JSON replies.
// One in-memory store serves all four surfaces (git smart HTTP, REST v3,
// GraphQL v4, MCP) from this one process.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitproto.ts';
import { handleRest, type ApiRequest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const store = new Store();
let requestCounter = 0;

const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length);
  if (token === '') return false;
  // No token configured (local development): any non-empty bearer token works.
  if (EXPECTED_TOKEN === '') return true;
  return token === EXPECTED_TOKEN;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (status === 204) {
    res.writeHead(204, { 'x-github-request-id': nextRequestId(), ...headers });
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

function sendUnauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Requires authentication' });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function pathSegments(pathname: string): string[] {
  return pathname.split('/').filter((segment) => segment !== '').map(decodeSegment);
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const method = req.method ?? 'GET';
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://entry');
      } catch {
        sendJson(res, 400, { message: 'Bad request' });
        return;
      }
      const segments = pathSegments(url.pathname);
      const host = req.headers.host ?? '127.0.0.1';
      const baseUrl = `http://${host}`;

      try {
        // The env's boot check calls this twice: 200 {"ok":true}. No auth.
        if (method === 'GET' && url.pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        if (segments.length >= 3 && segments[1]!.endsWith('.git')) {
          const owner = segments[0]!;
          const repoName = segments[1]!.slice(0, -'.git'.length);
          if (!authorized(req)) {
            sendUnauthorized(res);
            return;
          }
          if (method === 'GET' && segments[2] === 'info' && segments[3] === 'refs') {
            const service = url.searchParams.get('service') ?? '';
            const result = handleInfoRefs(store, owner, repoName, service, req.headers['git-protocol']);
            if (result.status === 404 || result.status === 400) {
              sendJson(res, result.status, JSON.parse(result.body.toString('utf8')));
            } else {
              sendRaw(res, result.status, result.contentType, result.body);
            }
            return;
          }
          if (method === 'POST' && segments[2] === 'git-upload-pack') {
            const body = await readBody(req);
            const result = handleUploadPack(store, owner, repoName, body, req.headers['git-protocol']);
            if (result.status === 400) {
              sendJson(res, 400, JSON.parse(result.body.toString('utf8')));
            } else {
              sendRaw(res, result.status, result.contentType, result.body);
            }
            return;
          }
          if (method === 'POST' && segments[2] === 'git-receive-pack') {
            const body = await readBody(req);
            const result = handleReceivePack(store, owner, repoName, body);
            if (result.status === 400) {
              sendJson(res, 400, JSON.parse(result.body.toString('utf8')));
            } else {
              sendRaw(res, result.status, result.contentType, result.body);
            }
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // GraphQL v4.
        if (url.pathname === '/api/graphql') {
          if (!authorized(req)) {
            sendUnauthorized(res);
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const raw = await readBody(req);
          let parsed: unknown = null;
          try {
            parsed = raw.length === 0 ? null : JSON.parse(raw.toString('utf8'));
          } catch {
            sendJson(res, 400, { message: 'malformed JSON body' });
            return;
          }
          const result = handleGraphql(store, parsed);
          sendJson(res, result.status, result.body);
          return;
        }

        // MCP over Streamable HTTP.
        if (url.pathname === '/mcp') {
          if (!authorized(req)) {
            sendUnauthorized(res);
            return;
          }
          if (method === 'DELETE') {
            res.writeHead(200, { 'x-github-request-id': nextRequestId() });
            res.end();
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const raw = await readBody(req);
          const result = handleMcp(store, raw);
          if (result.status === 202) {
            res.writeHead(202, { 'x-github-request-id': nextRequestId() });
            res.end();
            return;
          }
          sendJson(res, result.status, result.body);
          return;
        }

        // REST v3.
        if (segments[0] === 'api' && segments[1] === 'v3') {
          if (!authorized(req)) {
            sendUnauthorized(res);
            return;
          }
          const apiReq: ApiRequest = {
            store,
            method,
            segments: segments.slice(2),
            query: url.searchParams,
            body: undefined,
            baseUrl,
          };
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(req);
            if (raw.length > 0) {
              try {
                apiReq.body = JSON.parse(raw.toString('utf8'));
              } catch {
                sendJson(res, 400, { message: 'malformed JSON body' });
                return;
              }
            }
          }
          const result = handleRest(apiReq);
          if (result === null) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (result.status === 204) {
            sendJson(res, 204, null, result.headers ?? {});
            return;
          }
          sendJson(res, result.status, result.body, result.headers ?? {});
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // A handler must never take the server down: answer 500 JSON and
        // keep serving (the suite's repo-survives-errors check proves it).
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } catch {
          try {
            res.destroy();
          } catch {
            // nothing left to do
          }
        }
      }
    })();
  });
}
