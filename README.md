# Git Forge — a GitHub-compatible git forge in one Node process

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![make.fun rank](https://make.fun/badge/github-core-clone-01/rank/rifai788/git-forge.svg)](https://make.fun/bounty/github-core-clone-01)
[![make.fun reward](https://make.fun/badge/github-core-clone-01/reward/rifai788/git-forge.svg)](https://make.fun/bounty/github-core-clone-01)

A standalone forge that speaks GitHub's protocols from a single process with
no outside services and no git binary: git smart HTTP (protocol v2 and v0),
REST v3, GraphQL v4 and MCP, all backed by the same in-memory store.

- **Git:** `GET /{owner}/{repo}.git/info/refs`, `POST .../git-upload-pack`
  (protocol v2 with `ls-refs` and `fetch`, plus v0 fetch), `POST
  .../git-receive-pack` (v0, report-status, side-band-64k, ofs-delta). Pack
  files are built and parsed in-process (plain objects plus OFS/REF delta
  resolution); shallow clones, deepening, incremental fetch and non-fast-
  forward rejection work.
- **REST v3:** `GET /api/v3/` and `/meta`, repos (create / read / patch /
  delete, paginated lists with `Link: rel="next"`), branches, commits,
  refs, contents (create / update / delete with stale-sha detection),
  labels, issues, pull requests (create / merge / files). Every reply is
  JSON with a non-empty `X-GitHub-Request-Id`.
- **GraphQL v4:** `POST /api/graphql` — viewer, repository, issues and pull
  requests with connections and cursors, mutations to create/close issues,
  create/merge pull requests and add comments, `__type` introspection, batched
  bodies, and unknown fields answered HTTP 200 with an `errors` array.
- **MCP:** `POST /mcp` — JSON-RPC 2.0 over Streamable HTTP, `server/discover`
  and `initialize` handshakes, `tools/list` (create_repo, get_repo,
  create_issue, list_issues, create_pull_request, merge_pull_request) and
  `tools/call` acting on the same store as REST.

## Run

```sh
# Node 22 or later, no dependencies to install (stdlib only).
MAKEFUN_SHOP_TOKEN=secret node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port, registers it with the env at
`$MAKEFUN_ENV_URL/register`, then polls `$MAKEFUN_ENV_URL/done` and exits 0
when the trial ends. Without `MAKEFUN_ENV_URL` it exits 1. The bearer token
in `MAKEFUN_SHOP_TOKEN` is the one the suite presents; requests without it
answer 401. With no token set, any non-empty bearer token is accepted (local
development only).

Health check: `GET /healthz` answers `200 {"ok": true}` without auth.

## Test

```sh
# syntax check (Node strips types directly, no build step)
node --experimental-strip-types --check app.ts
node --experimental-strip-types --check main.ts

# smoke test against a local server
MAKEFUN_SHOP_TOKEN=test node --experimental-strip-types main.ts &
# (with MAKEFUN_ENV_URL unset this exits 1; start app.ts directly instead)
```

For a local smoke server, run `app.ts` through a tiny launcher:

```sh
node --experimental-strip-types -e "import('./app.ts').then(m => m.createApp().listen(18080, () => console.log('up')))"
```

then:

```sh
T=http://127.0.0.1:18080; A='Authorization: Bearer test'
curl -s -H "$A" $T/api/v3/ | head -c 200
curl -s -X POST -H "$A" -d '{"name":"demo"}' $T/api/v3/user/repos
git clone http://test@127.0.0.1:18080/adaiversen/demo.git   # after a push
```

## Layout

| File | What it does |
| --- | --- |
| `main.ts` | Env lifecycle: bind ephemeral port, register, poll `/done`, exit 0. |
| `app.ts` | HTTP server: routing, auth, body reading, JSON replies. |
| `store.ts` | In-memory store: repos, refs, objects, issues, pulls, comments, deterministic timestamps. |
| `gitobj.ts` | Object model: pkt-lines, SHA-1, trees/commits/tags, pack read/write with delta resolution, sideband. |
| `gitproto.ts` | Git smart HTTP: v0/v2 advertisements, ls-refs, fetch, receive-pack. |
| `rest.ts` | REST v3 handlers and serializers. |
| `graphql.ts` | GraphQL parser and resolvers. |
| `mcp.ts` | MCP JSON-RPC handlers and tool definitions. |

## Notes

- State is in-memory and deterministic: timestamps come from a fixed base
  plus a sequence counter, never the wall clock, so two runs on the same
  instance leave the same state.
- The bearer token's owner is the scenario viewer `adaiversen` (id 1000);
  a repository under another owner answers 404, never 403.
- Built for the make.fun bounty
  [github-core-clone-01](https://make.fun/bounty/github-core-clone-01).
