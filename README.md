# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Ball-ibra/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Ball-ibra/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node process: git smart HTTP (upload-pack protocol v2, receive-pack v0), the REST v3 API, GraphQL v4 and MCP, all over one in-memory store. No UI, no dependencies, no git binary, no outside service — only the Node standard library.

## Run it

```sh
node main.ts
```

The platform runs `node /bot/main.ts` on Node 22. The process binds an ephemeral port, registers it with the env at `$MAKEFUN_ENV_URL`, serves until the env says done, then exits 0.

## Layout

- `main.ts` — the entry <-> env lifecycle: listen(0), register, poll /done.
- `app.ts` — the HTTP server: REST v3, GraphQL v4, MCP and routing.
- `store.ts` — the in-memory store: repositories, issues, pull requests, labels, comments, and the git object database (sha1 ids, trees, commits).
- `git.ts` — the git wire protocol: pkt-lines, packfiles (read with delta resolution, write as full objects), and the smart-HTTP handlers.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}` |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org` |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: `server/discover`, `initialize`, `tools/list`, `tools/call` |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

Every API call needs `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; the token names the viewer `adaiversen`, the scenario's fixed login. A repository belongs to its owner, so the same name under another owner is a 404, never a 403. All ids are deterministic: no clock or random value reaches a response.

---

<sub>Entered on [make.fun](https://make.fun/?ref=wn6mtt7s&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
