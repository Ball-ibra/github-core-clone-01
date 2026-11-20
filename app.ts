// app.ts — the forge's HTTP server: REST v3, GraphQL v4, MCP and git smart
// HTTP, all over one in-memory store (store.ts) and one git protocol
// implementation (git.ts).
//
// Conventions the suite leans on, kept everywhere in this file:
//   * every reply is JSON (or a git pkt stream) with a non-empty
//     X-GitHub-Request-Id header; errors are {"message": "..."}.
//   * a request with no Bearer token is 401 on the API surfaces; the token
//     itself names the viewer "adaiversen" (the scenario's fixed login —
//     any non-empty Bearer token is that user, because the suite's token
//     is the only credential and it names exactly one login).
//   * a repository is addressed by (owner, name); the same name under a
//     different owner is a 404, never a 403.
//   * ids and timestamps are deterministic: repo ids count up from 5000,
//     issue/PR numbers count up per repository, global ids are base64url
//     of a typed key, and commit times are a fixed epoch.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  VIEWER, Store, Repo, hashObject, storeBlob, storeTree, flattenTree, filesAt,
  makeCommit, isAncestor, globalId, parseGlobalId, FIXED_TS, type Issue, type Pull,
} from './store.ts';
import { gitInfoRefs, gitUploadPack, gitReceivePack } from './git.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const FIXED_DATE = '2025-01-01T00:00:00Z';
const store = new Store();
let requestSeq = 0;

type Json = Record<string, unknown>;

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = {
    'content-type': JSON_TYPE,
    'x-github-request-id': `forge-${(requestSeq += 1).toString(36)}`,
    ...extra,
  };
  if (status !== 204) headers['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, headers);
  res.end(text);
}
function sendErr(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
/** Parse a JSON body; on failure, answer 400 and return null. */
function parseJsonBody(res: ServerResponse, raw: Buffer): Json | null {
  if (raw.length === 0) return {};
  try {
    const value = JSON.parse(raw.toString('utf8')) as unknown;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Json;
    return {};
  } catch {
    sendErr(res, 400, 'Invalid JSON body');
    return null;
  }
}
function bearer(req: IncomingMessage): string | null {
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  return token === '' ? null : token;
}
function urlOf(req: IncomingMessage): { path: string; query: URLSearchParams } {
  try {
    const u = new URL(req.url ?? '/', 'http://forge');
    return { path: decodeURIComponent(u.pathname), query: u.searchParams };
  } catch {
    return { path: '/', query: new URLSearchParams() };
  }
}
function seg(path: string): string[] {
  return path.split('/').filter((s) => s !== '');
}
function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

// ---------------------------------------------------------------- shapes

function repoJson(r: Repo): Json {
  return {
    id: r.id, node_id: globalId('repo', r.id), name: r.name, full_name: r.fullName,
    owner: { login: r.owner, id: r.owner === VIEWER.login ? VIEWER.id : 1001, type: 'User' },
    private: r.privateFlag, description: r.description, default_branch: r.defaultBranch,
    html_url: `https://example.invalid/${r.fullName}`, url: `/api/v3/repos/${r.owner}/${r.name}`,
    created_at: FIXED_DATE, updated_at: FIXED_DATE, pushed_at: FIXED_DATE,
    has_issues: true, has_projects: true, has_wiki: true, fork: false,
    open_issues_count: r.issues.filter((i) => i.state === 'open').length,
    watchers_count: 0, stargazers_count: 0, forks_count: 0,
  };
}
function issueJson(r: Repo, i: Issue): Json {
  return {
    id: r.id * 1000 + i.number, node_id: globalId('issue', r.id, i.number), number: i.number,
    title: i.title, body: i.body, state: i.state,
    user: { login: VIEWER.login, id: VIEWER.id },
    labels: i.labels.map((name) => ({ name, color: r.labels.get(name)?.color ?? 'ededed' })),
    comments: i.comments.length, created_at: FIXED_DATE, updated_at: FIXED_DATE,
    html_url: `https://example.invalid/${r.fullName}/issues/${i.number}`,
    url: `/api/v3/repos/${r.owner}/${r.name}/issues/${i.number}`,
  };
}
function pullJson(r: Repo, p: Pull): Json {
  const headSha = r.branchTip(p.head) ?? p.headSha;
  const baseSha = r.branchTip(p.base) ?? p.baseSha;
  return {
    id: r.id * 1000 + p.number, node_id: globalId('pull', r.id, p.number), number: p.number,
    title: p.title, body: p.body, state: p.state,
    user: { login: VIEWER.login, id: VIEWER.id },
    head: { ref: p.head, sha: headSha, label: `${r.owner}:${p.head}`, repo: repoJson(r) },
    base: { ref: p.base, sha: baseSha, label: `${r.owner}:${p.base}`, repo: repoJson(r) },
    merged: p.merged, mergeable: prMergeable(r, p), merge_commit_sha: p.mergeSha,
    merged_at: p.mergedAt, created_at: FIXED_DATE, updated_at: FIXED_DATE,
    html_url: `https://example.invalid/${r.fullName}/pull/${p.number}`,
    url: `/api/v3/repos/${r.owner}/${r.name}/pulls/${p.number}`,
  };
}

/** The files a pull request changes, base tree -> head tree. */
function pullFiles(r: Repo, p: Pull): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
  const baseFiles = filesAt(r, p.baseSha);
  const headFiles = filesAt(r, p.headSha);
  const names = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
  for (const name of [...names].sort()) {
    const b = baseFiles.get(name);
    const h = headFiles.get(name);
    if (b && h && b.oid === h.oid) continue;
    const status = !b ? 'added' : !h ? 'removed' : 'modified';
    const additions = status === 'removed' ? 0 : 1;
    const deletions = status === 'added' ? 0 : 1;
    out.push({ filename: name, status, additions, deletions, changes: additions + deletions });
  }
  return out;
}

/** 'CONFLICTING' when the head and the current base both changed a file
 *  differently since the pull's base; 'MERGEABLE' otherwise. */
function prMergeable(r: Repo, p: Pull): string {
  if (p.state !== 'open') return 'UNKNOWN';
  const baseFiles = filesAt(r, p.baseSha);
  const headFiles = filesAt(r, p.headSha);
  const currentTip = r.branchTip(p.base);
  if (!currentTip || currentTip === p.baseSha) return 'MERGEABLE';
  const currentFiles = filesAt(r, currentTip);
  for (const [path, head] of headFiles) {
    const base = baseFiles.get(path);
    if (base && base.oid !== head.oid) {
      const cur = currentFiles.get(path);
      if (cur && cur.oid !== base.oid && cur.oid !== head.oid) return 'CONFLICTING';
    }
  }
  for (const [path, base] of baseFiles) {
    if (!headFiles.has(path)) {
      const cur = currentFiles.get(path);
      if (cur && cur.oid !== base.oid) return 'CONFLICTING';
    }
  }
  return 'MERGEABLE';
}

/** Squash-merge an open pull request onto its base branch. */
function mergePull(r: Repo, p: Pull): { ok: boolean; status: number; message: string; sha?: string } {
  if (p.state !== 'open') return { ok: false, status: 405, message: 'Pull request is not open' };
  if (prMergeable(r, p) === 'CONFLICTING') return { ok: false, status: 405, message: 'Merge conflict' };
  const baseTip = r.branchTip(p.base);
  if (!baseTip) return { ok: false, status: 405, message: 'Base branch has no commits' };
  const baseFiles = filesAt(r, p.baseSha);
  const headFiles = filesAt(r, p.headSha);
  const mergedFiles = filesAt(r, baseTip);
  for (const [path, file] of headFiles) mergedFiles.set(path, file);
  for (const path of baseFiles.keys()) if (!headFiles.has(path)) mergedFiles.delete(path);
  const sha = makeCommit(r, mergedFiles, [baseTip], `Merge pull request #${p.number} from ${p.head}\n\n${p.title}`);
  r.branches.set(p.base, sha);
  p.state = 'closed';
  p.merged = true;
  p.mergeSha = sha;
  p.mergedAt = FIXED_DATE;
  return { ok: true, status: 200, message: `Merge pull request #${p.number}`, sha };
}

/** Commit one file change on a branch (contents PUT / DELETE helper). */
function commitFileChange(r: Repo, branch: string, path: string, content: Buffer | null, message: string): { commitSha: string; blobSha: string } | null {
  const tip = r.branchTip(branch);
  const files = tip ? filesAt(r, tip) : new Map<string, { oid: string; mode: string }>();
  let blobSha = '';
  if (content === null) {
    files.delete(path);
  } else {
    blobSha = storeBlob(r, content);
    files.set(path, { oid: blobSha, mode: '100644' });
  }
  const commitSha = makeCommit(r, files, tip ? [tip] : [], message);
  r.branches.set(branch, commitSha);
  return { commitSha, blobSha };
}

// ---------------------------------------------------------------- REST v3

async function handleRest(req: IncomingMessage, res: ServerResponse, method: string, path: string, query: URLSearchParams): Promise<boolean> {
  if (!path.startsWith('/api/v3')) return false;
  const token = bearer(req);
  // The API root and meta are the only REST routes that answer without a
  // token in the suite's checks; everything else needs one.
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    if (token === null) { sendErr(res, 401, 'Requires authentication'); return true; }
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (method === 'GET' && path === '/api/v3/meta') {
    if (token === null) { sendErr(res, 401, 'Requires authentication'); return true; }
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
    return true;
  }
  if (token === null) { sendErr(res, 401, 'Requires authentication'); return true; }
  const parts = seg(path.slice('/api/v3'.length));
  const raw = await readBody(req);
  // Any route that takes a body must refuse malformed JSON with 400.
  const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH';
  let body: Json = {};
  if (needsBody && raw.length > 0) {
    const parsed = parseJsonBody(res, raw);
    if (parsed === null) return true;
    body = parsed;
  }

  // GET /user — the token's own login (MCP's resolveOwner reads this).
  if (method === 'GET' && parts.length === 1 && parts[0] === 'user') {
    sendJson(res, 200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
    return true;
  }
  // GET /user/repos — paginated list of the viewer's repositories.
  if (parts.length === 2 && parts[0] === 'user' && parts[1] === 'repos') {
    if (method === 'GET') {
      const all = store.listFor(VIEWER.login);
      const perPage = Math.max(1, Number(query.get('per_page') ?? '30') || 30);
      const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const extra: Record<string, string> = {};
      if (page * perPage < all.length) {
        const host = req.headers.host ?? 'localhost';
        extra.link = `<http://${host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}>; rel="next", <http://${host}/api/v3/user/repos?per_page=${perPage}&page=${Math.ceil(all.length / perPage)}>; rel="last"`;
      }
      sendJson(res, 200, slice.map(repoJson), extra);
      return true;
    }
    if (method === 'POST') {
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') { sendErr(res, 422, 'name is required'); return true; }
      if (store.get(VIEWER.login, name)) { sendErr(res, 422, 'Repository already exists'); return true; }
      const repo = store.create(VIEWER.login, name, body.private === true, typeof body.description === 'string' ? body.description : '');
      sendJson(res, 201, repoJson(repo));
      return true;
    }
  }
  // /repos/{owner}/{repo}...
  if (parts.length >= 3 && parts[0] === 'repos') {
    const owner = parts[1] as string;
    const name = parts[2] as string;
    const repo = store.get(owner, name);
    const rest = parts.slice(3);
    if (!repo) { sendErr(res, 404, 'Not Found'); return true; }
    if (rest.length === 0) {
      if (method === 'GET') { sendJson(res, 200, repoJson(repo)); return true; }
      if (method === 'PATCH') {
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.privateFlag = body.private;
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        store.delete(owner, name);
        sendJson(res, 204, {});
        return true;
      }
    }
    // Branches
    if (rest[0] === 'branches') {
      if (method === 'GET' && rest.length === 1) {
        sendJson(res, 200, repo.allRefs().filter((r) => r.name.startsWith('refs/heads/')).map((r) => ({ name: r.name.slice(11), commit: { sha: r.oid }, protected: false })));
        return true;
      }
      if (method === 'GET' && rest.length === 2) {
        const tip = repo.branchTip(rest[1] as string);
        if (!tip) { sendErr(res, 404, 'Branch not found'); return true; }
        sendJson(res, 200, { name: rest[1], commit: { sha: tip }, protected: false });
        return true;
      }
    }
    // Commits
    if (rest[0] === 'commits' && method === 'GET') {
      const refName = query.get('sha') ?? repo.defaultBranch;
      let tip = repo.branchTip(refName);
      if (!tip && refName.length === 40) tip = refName;
      if (!tip) { sendJson(res, 200, []); return true; }
      const list: Json[] = [];
      const seen = new Set<string>();
      const stack = [tip];
      while (stack.length > 0 && list.length < 100) {
        const oid = stack.pop() as string;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const obj = repo.objects.get(oid);
        if (!obj || obj.type !== 'commit') continue;
        const parsed = (await import('./store.ts')).parseCommit(obj.data);
        list.push({ sha: oid, commit: { message: parsed.message.trim(), author: { name: VIEWER.login, date: FIXED_DATE }, committer: { name: VIEWER.login, date: FIXED_DATE } }, author: { login: VIEWER.login, id: VIEWER.id } });
        for (const p of parsed.parents) stack.push(p);
      }
      sendJson(res, 200, list);
      return true;
    }
    // git/refs — create a branch or tag; read one ref back.
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST') {
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !repo.objects.has(sha) && !repo.objects.has(repo.peel(sha))) { sendErr(res, 422, 'Invalid ref or sha'); return true; }
        repo.setRef(ref, sha);
        sendJson(res, 201, { ref, object: { sha, type: 'commit', url: '' } });
        return true;
      }
      if (method === 'GET' && rest.length >= 3) {
        const refName = `refs/${rest.slice(2).join('/')}`;
        const oid = repo.refOid(refName);
        if (!oid) { sendErr(res, 404, 'Not Found'); return true; }
        sendJson(res, 200, { ref: refName, object: { sha: oid, type: 'commit', url: '' } });
        return true;
      }
    }
    // Contents
    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).join('/');
      const refName = query.get('ref') ?? undefined;
      if (method === 'GET') {
        const tip = refName ? (repo.branchTip(refName) ?? (refName.length === 40 ? refName : undefined)) : repo.branchTip(repo.defaultBranch);
        if (!tip) { sendErr(res, 404, 'Not Found'); return true; }
        const files = filesAt(repo, tip);
        if (filePath === '') {
          // Directory listing of the root.
          const entries: Json[] = [];
          const seenDirs = new Set<string>();
          for (const [p, f] of [...files.entries()].sort()) {
            const first = p.split('/')[0] as string;
            if (p.includes('/')) {
              if (!seenDirs.has(first)) { seenDirs.add(first); entries.push({ type: 'dir', name: first, path: first, sha: '' }); }
            } else entries.push({ type: 'file', name: p, path: p, sha: f.oid, size: 0 });
          }
          sendJson(res, 200, entries);
          return true;
        }
        const dirEntries: Json[] = [];
        let isDir = false;
        for (const [p, f] of [...files.entries()].sort()) {
          if (p.startsWith(`${filePath}/`)) {
            isDir = true;
            const restPath = p.slice(filePath.length + 1);
            if (!restPath.includes('/')) dirEntries.push({ type: 'file', name: restPath, path: p, sha: f.oid, size: 0 });
          }
        }
        if (isDir) { sendJson(res, 200, dirEntries); return true; }
        const file = files.get(filePath);
        if (!file) { sendErr(res, 404, 'Not Found'); return true; }
        const blob = repo.objects.get(file.oid);
        const content = blob ? blob.data.toString('utf8') : '';
        sendJson(res, 200, { type: 'file', encoding: 'base64', size: Buffer.byteLength(content, 'utf8'), name: filePath.split('/').pop(), path: filePath, content: b64(content), sha: file.oid });
        return true;
      }
      if (method === 'PUT') {
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const message = typeof body.message === 'string' ? body.message : 'Update file';
        const contentB64 = typeof body.content === 'string' ? body.content : '';
        const content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
        const tip = repo.branchTip(branch);
        const files = tip ? filesAt(repo, tip) : new Map();
        const existing = files.get(filePath);
        const isUpdate = existing !== undefined;
        if (isUpdate) {
          if (typeof body.sha === 'string' && body.sha !== existing.oid) { sendErr(res, 409, 'sha does not match'); return true; }
          if (typeof body.sha !== 'string') { sendErr(res, 409, 'sha is required to update'); return true; }
        }
        const made = commitFileChange(repo, branch, filePath, content, message);
        if (!made) { sendErr(res, 422, 'Could not commit'); return true; }
        sendJson(res, isUpdate ? 200 : 201, { content: { name: filePath.split('/').pop(), path: filePath, sha: made.blobSha, size: content.length, encoding: 'base64' }, commit: { sha: made.commitSha, message } });
        return true;
      }
      if (method === 'DELETE') {
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const message = typeof body.message === 'string' ? body.message : 'Delete file';
        const tip = repo.branchTip(branch);
        const files = tip ? filesAt(repo, tip) : new Map();
        if (!files.has(filePath)) { sendErr(res, 404, 'Not Found'); return true; }
        const made = commitFileChange(repo, branch, filePath, null, message);
        if (!made) { sendErr(res, 422, 'Could not commit'); return true; }
        sendJson(res, 200, { commit: { sha: made.commitSha, message } });
        return true;
      }
    }
    // Labels
    if (rest[0] === 'labels') {
      if (method === 'POST') {
        const name = typeof body.name === 'string' ? body.name : '';
        if (name === '') { sendErr(res, 422, 'name is required'); return true; }
        const color = typeof body.color === 'string' ? body.color : 'ededed';
        repo.labels.set(name, { name, color });
        sendJson(res, 201, { name, color, description: '' });
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: '' })));
        return true;
      }
    }
    // Issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const labels = Array.isArray(body.labels) ? (body.labels as unknown[]).map((l) => typeof l === 'string' ? l : (l as Json).name as string) : [];
          for (const l of labels) if (!repo.labels.has(l)) { sendErr(res, 422, `Label ${l} does not exist`); return true; }
          const issue: Issue = { number: repo.nextIssue, title: typeof body.title === 'string' ? body.title : '', body: typeof body.body === 'string' ? body.body : '', state: 'open', labels, comments: [], seq: repo.issues.length };
          repo.nextIssue += 1;
          repo.issues.push(issue);
          sendJson(res, 201, issueJson(repo, issue));
          return true;
        }
        if (method === 'GET') {
          let list = [...repo.issues];
          const state = query.get('state') ?? 'open';
          if (state !== 'all') list = list.filter((i) => i.state === state);
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          if (sort === 'created') list.sort((a, b) => direction === 'asc' ? a.seq - b.seq : b.seq - a.seq);
          const perPage = Math.max(1, Number(query.get('per_page') ?? '30') || 30);
          const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
          sendJson(res, 200, list.slice((page - 1) * perPage, page * perPage).map((i) => issueJson(repo, i)));
          return true;
        }
      }
      const num = Number(rest[1]);
      const issue = repo.issues.find((i) => i.number === num);
      if (!issue) { sendErr(res, 404, 'Not Found'); return true; }
      if (rest.length === 2) {
        if (method === 'GET') { sendJson(res, 200, issueJson(repo, issue)); return true; }
        if (method === 'PATCH') {
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          sendJson(res, 200, issueJson(repo, issue));
          return true;
        }
      }
      if (rest[2] === 'comments') {
        if (method === 'POST') {
          const comment = { id: repo.nextComment, body: typeof body.body === 'string' ? body.body : '' };
          repo.nextComment += 1;
          issue.comments.push(comment);
          sendJson(res, 201, { id: comment.id, body: comment.body, user: { login: VIEWER.login, id: VIEWER.id }, created_at: FIXED_DATE });
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: VIEWER.login, id: VIEWER.id }, created_at: FIXED_DATE })));
          return true;
        }
      }
    }
    // Pull requests
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const head = typeof body.head === 'string' ? body.head : '';
          const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
          const headSha = repo.branchTip(head);
          const baseSha = repo.branchTip(base);
          if (!headSha || !baseSha) { sendErr(res, 422, 'Head or base branch not found'); return true; }
          const pull: Pull = { number: repo.nextPull, title: typeof body.title === 'string' ? body.title : '', body: typeof body.body === 'string' ? body.body : '', state: 'open', head, base, headSha, baseSha, merged: false, mergeSha: null, mergedAt: null, seq: repo.pulls.length };
          repo.nextPull += 1;
          repo.pulls.push(pull);
          sendJson(res, 201, pullJson(repo, pull));
          return true;
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const list = repo.pulls.filter((p) => state === 'all' || p.state === state);
          sendJson(res, 200, list.map((p) => pullJson(repo, p)));
          return true;
        }
      }
      const num = Number(rest[1]);
      const pull = repo.pulls.find((p) => p.number === num);
      if (!pull) { sendErr(res, 404, 'Not Found'); return true; }
      if (rest.length === 2 && method === 'GET') { sendJson(res, 200, pullJson(repo, pull)); return true; }
      if (rest[2] === 'files' && method === 'GET') { sendJson(res, 200, pullFiles(repo, pull)); return true; }
      if (rest[2] === 'merge' && method === 'PUT') {
        const result = mergePull(repo, pull);
        if (!result.ok) { sendErr(res, result.status, result.message); return true; }
        sendJson(res, 200, { merged: true, sha: result.sha, message: result.message });
        return true;
      }
    }
  }
  sendErr(res, 404, 'Not Found');
  return true;
}

// ---------------------------------------------------------------- GraphQL v4
// A small, purpose-built executor for the documents gh and
// github-mcp-server actually send: no schema library, just a tokenizer,
// a selection-set parser, and resolvers over the same store REST uses.

interface GqlField { alias: string; name: string; args: Record<string, unknown>; selections: GqlField[]; inlineType: string | null; }
interface GqlOp { kind: 'query' | 'mutation'; name: string | null; selections: GqlField[]; }

function gqlTokens(text: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (/\s/.test(c) || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < text.length && text[i] !== '\n') i += 1; continue; }
    if (text.startsWith('...', i)) { tokens.push('...'); i += 3; continue; }
    if ('{}():![]=@$'.includes(c)) { tokens.push(c); i += 1; continue; }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < text.length && text[j] !== '"') { if (text[j] === '\\' && j + 1 < text.length) { out += text[j + 1]; j += 2; } else { out += text[j]; j += 1; } }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j] as string)) j += 1;
      tokens.push(text.slice(i, j));
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < text.length && /[0-9.eE+-]/.test(text[j] as string)) j += 1;
      tokens.push(text.slice(i, j));
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

class GqlParser {
  tokens: string[]; at = 0;
  constructor(text: string) { this.tokens = gqlTokens(text); }
  peek(): string { return this.tokens[this.at] ?? ''; }
  next(): string { return this.tokens[this.at++] ?? ''; }
  expect(t: string): void { if (this.next() !== t) throw new Error(`expected ${t}`); }
  parseValue(vars: Record<string, unknown>): unknown {
    const t = this.next();
    if (t === '$') return vars[this.next() as string];
    if (t === '[') {
      const list: unknown[] = [];
      while (this.peek() !== ']') list.push(this.parseValue(vars));
      this.expect(']');
      return list;
    }
    if (t === '{') {
      const obj: Record<string, unknown> = {};
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        obj[key] = this.parseValue(vars);
      }
      this.expect('}');
      return obj;
    }
    if (t.startsWith('"')) return JSON.parse(t) as string;
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null') return null;
    const num = Number(t);
    return Number.isNaN(num) ? t : num;
  }
  parseArgs(vars: Record<string, unknown>): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    if (this.peek() !== '(') return args;
    this.next();
    while (this.peek() !== ')') {
      const key = this.next();
      this.expect(':');
      args[key] = this.parseValue(vars);
    }
    this.expect(')');
    return args;
  }
  parseSelections(vars: Record<string, unknown>): GqlField[] {
    this.expect('{');
    const out: GqlField[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        let inlineType: string | null = null;
        if (this.peek() === 'on') { this.next(); inlineType = this.next(); }
        const inner = this.parseSelections(vars);
        for (const f of inner) out.push({ ...f, inlineType });
        continue;
      }
      let name = this.next();
      let alias = name;
      if (this.peek() === ':') { this.next(); name = this.next(); alias = alias; }
      const args = this.parseArgs(vars);
      const selections = this.peek() === '{' ? this.parseSelections(vars) : [];
      out.push({ alias, name, args, selections, inlineType: null });
    }
    this.expect('}');
    return out;
  }
  parseDocument(vars: Record<string, unknown>): GqlOp[] {
    const ops: GqlOp[] = [];
    while (this.at < this.tokens.length) {
      let kind: 'query' | 'mutation' = 'query';
      const t = this.peek();
      if (t === 'query' || t === 'mutation') { kind = this.next() as 'query' | 'mutation'; }
      let name: string | null = null;
      if (this.peek() !== '{' && this.peek() !== '(') name = this.next();
      if (this.peek() === '(') {
        // Variable definitions: skip them (values come from `variables`).
        let depth = 0;
        while (this.at < this.tokens.length) {
          const tok = this.next();
          if (tok === '(') depth += 1;
          if (tok === ')') { depth -= 1; if (depth === 0) break; }
        }
      }
      const selections = this.parseSelections(vars);
      ops.push({ kind, name, selections });
    }
    return ops;
  }
}

const ISSUE_TYPE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url', 'author', 'labels', 'comments', 'assignees'];
const PR_TYPE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'headRef', 'baseRef', 'createdAt', 'updatedAt', 'url', 'author'];
const REPO_TYPE_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'isPrivate', 'url', 'createdAt', 'updatedAt'];
const SEARCH_ENUM = ['COMMIT', 'DISCUSSION', 'ISSUE', 'LABEL', 'MILESTONE', 'REPOSITORY', 'USER'];

function findRepoByGlobalId(id: unknown): Repo | null {
  const parsed = typeof id === 'string' ? parseGlobalId(id) : null;
  if (!parsed || parsed.kind !== 'repo') return null;
  for (const r of store.repos.values()) if (r.id === parsed.repoId) return r;
  return null;
}
function findIssueByGlobalId(id: unknown): { repo: Repo; issue: Issue } | null {
  const parsed = typeof id === 'string' ? parseGlobalId(id) : null;
  if (!parsed || parsed.kind !== 'issue' || parsed.num === null) return null;
  for (const r of store.repos.values()) if (r.id === parsed.repoId) {
    const issue = r.issues.find((i) => i.number === parsed.num);
    return issue ? { repo: r, issue } : null;
  }
  return null;
}
function findPullByGlobalId(id: unknown): { repo: Repo; pull: Pull } | null {
  const parsed = typeof id === 'string' ? parseGlobalId(id) : null;
  if (!parsed || parsed.kind !== 'pull' || parsed.num === null) return null;
  for (const r of store.repos.values()) if (r.id === parsed.repoId) {
    const pull = r.pulls.find((p) => p.number === parsed.num);
    return pull ? { repo: r, pull } : null;
  }
  return null;
}

function resolveUser(sel: GqlField[], login: string, id: number): Json {
  const out: Json = {};
  for (const f of sel) {
    if (f.name === 'login') out[f.alias] = login;
    else if (f.name === 'id') out[f.alias] = globalId('user', id);
    else if (f.name === 'name') out[f.alias] = login;
    else if (f.name === 'email') out[f.alias] = `${login}@example.invalid`;
    else if (f.name === 'url') out[f.alias] = `https://example.invalid/${login}`;
  }
  return out;
}

function resolveIssue(repo: Repo, issue: Issue, sel: GqlField[], errors: string[]): Json {
  const out: Json = {};
  for (const f of sel) {
    if (!ISSUE_TYPE_FIELDS.includes(f.name)) { errors.push(`Field '${f.name}' doesn't exist on type 'Issue'`); continue; }
    if (f.name === 'id') out[f.alias] = globalId('issue', repo.id, issue.number);
    else if (f.name === 'number') out[f.alias] = issue.number;
    else if (f.name === 'title') out[f.alias] = issue.title;
    else if (f.name === 'state') out[f.alias] = issue.state.toUpperCase();
    else if (f.name === 'body') out[f.alias] = issue.body;
    else if (f.name === 'createdAt' || f.name === 'updatedAt') out[f.alias] = FIXED_DATE;
    else if (f.name === 'url') out[f.alias] = `https://example.invalid/${repo.fullName}/issues/${issue.number}`;
    else if (f.name === 'author') out[f.alias] = resolveUser(f.selections, VIEWER.login, VIEWER.id);
    else if (f.name === 'labels') out[f.alias] = { nodes: issue.labels.map((name) => ({ name })) };
    else if (f.name === 'comments') out[f.alias] = { nodes: issue.comments.map((c) => ({ id: globalId('comment', repo.id, c.id), body: c.body })) };
  }
  return out;
}

function resolvePull(repo: Repo, pull: Pull, sel: GqlField[], errors: string[]): Json {
  const out: Json = {};
  for (const f of sel) {
    if (!PR_TYPE_FIELDS.includes(f.name)) { errors.push(`Field '${f.name}' doesn't exist on type 'PullRequest'`); continue; }
    if (f.name === 'id') out[f.alias] = globalId('pull', repo.id, pull.number);
    else if (f.name === 'number') out[f.alias] = pull.number;
    else if (f.name === 'title') out[f.alias] = pull.title;
    else if (f.name === 'state') out[f.alias] = pull.state.toUpperCase();
    else if (f.name === 'body') out[f.alias] = pull.body;
    else if (f.name === 'headRefName') out[f.alias] = pull.head;
    else if (f.name === 'baseRefName') out[f.alias] = pull.base;
    else if (f.name === 'mergeable') out[f.alias] = prMergeable(repo, pull);
    else if (f.name === 'merged') out[f.alias] = pull.merged;
    else if (f.name === 'createdAt' || f.name === 'updatedAt') out[f.alias] = FIXED_DATE;
    else if (f.name === 'url') out[f.alias] = `https://example.invalid/${repo.fullName}/pull/${pull.number}`;
    else if (f.name === 'author') out[f.alias] = resolveUser(f.selections, VIEWER.login, VIEWER.id);
    else if (f.name === 'headRef') out[f.alias] = { name: pull.head };
    else if (f.name === 'baseRef') out[f.alias] = { name: pull.base };
    else if (f.name === 'files') {
      const first = typeof f.args.first === 'number' ? f.args.first : 100;
      const nodes = pullFiles(repo, pull).slice(0, first).map((file) => ({ path: file.filename, additions: file.additions, deletions: file.deletions }));
      out[f.alias] = { nodes, totalCount: pullFiles(repo, pull).length };
    }
  }
  return out;
}

function resolveRepository(repo: Repo, sel: GqlField[], errors: string[]): Json {
  const out: Json = {};
  for (const f of sel) {
    if (!REPO_TYPE_FIELDS.includes(f.name)) { errors.push(`Field '${f.name}' doesn't exist on type 'Repository'`); continue; }
    if (f.name === 'id') out[f.alias] = globalId('repo', repo.id);
    else if (f.name === 'databaseId') out[f.alias] = repo.id;
    else if (f.name === 'name') out[f.alias] = repo.name;
    else if (f.name === 'nameWithOwner') out[f.alias] = repo.fullName;
    else if (f.name === 'description') out[f.alias] = repo.description;
    else if (f.name === 'private' || f.name === 'isPrivate') out[f.alias] = repo.privateFlag;
    else if (f.name === 'url') out[f.alias] = `https://example.invalid/${repo.fullName}`;
    else if (f.name === 'createdAt' || f.name === 'updatedAt') out[f.alias] = FIXED_DATE;
    else if (f.name === 'owner') out[f.alias] = resolveUser(f.selections, repo.owner, repo.owner === VIEWER.login ? VIEWER.id : 1001);
    else if (f.name === 'defaultBranchRef') {
      const tip = repo.branchTip(repo.defaultBranch);
      out[f.alias] = tip ? { name: repo.defaultBranch, target: { oid: tip } } : null;
    } else if (f.name === 'viewerPermission') out[f.alias] = 'ADMIN';
    else if (f.name === 'hasIssuesEnabled') out[f.alias] = true;
    else if (f.name === 'issue') {
      const num = f.args.number as number;
      const issue = repo.issues.find((i) => i.number === num);
      out[f.alias] = issue ? resolveIssue(repo, issue, f.selections, errors) : null;
    } else if (f.name === 'issues') {
      let list = [...repo.issues];
      const states = f.args.states as string[] | undefined;
      if (states) list = list.filter((i) => states.includes(i.state.toUpperCase()));
      const orderBy = f.args.orderBy as { field?: string; direction?: string } | undefined;
      const dir = orderBy?.direction ?? 'DESC';
      list.sort((a, b) => dir === 'ASC' ? a.seq - b.seq : b.seq - a.seq);
      const first = typeof f.args.first === 'number' ? f.args.first : list.length;
      let start = 0;
      if (typeof f.args.after === 'string' && f.args.after !== '') {
        try {
          const raw = Buffer.from(f.args.after, 'base64').toString('utf8');
          const num = Number(raw.replace('cursor:', ''));
          const idx = list.findIndex((i) => i.number === num);
          if (idx >= 0) start = idx + 1;
        } catch { /* an unreadable cursor just starts from the top */ }
      }
      const page = list.slice(start, start + first);
      const endCursor = page.length > 0 ? Buffer.from(`cursor:${page[page.length - 1]?.number ?? 0}`, 'utf8').toString('base64') : null;
      const conn: Json = {};
      for (const sub of f.selections) {
        if (sub.name === 'nodes') conn[sub.alias] = page.map((i) => resolveIssue(repo, i, sub.selections, errors));
        else if (sub.name === 'edges') conn[sub.alias] = page.map((i) => ({ node: resolveIssue(repo, i, sub.selections.filter((s) => s.name === 'node').flatMap((s) => s.selections), errors), cursor: Buffer.from(`cursor:${i.number}`, 'utf8').toString('base64') }));
        else if (sub.name === 'pageInfo') conn[sub.alias] = { hasNextPage: start + first < list.length, endCursor, hasPreviousPage: start > 0, startCursor: page.length > 0 ? Buffer.from(`cursor:${page[0]?.number ?? 0}`, 'utf8').toString('base64') : null };
        else if (sub.name === 'totalCount') conn[sub.alias] = list.length;
      }
      out[f.alias] = conn;
    } else if (f.name === 'pullRequests') {
      const first = typeof f.args.first === 'number' ? f.args.first : 100;
      const list = repo.pulls.filter((p) => p.state === 'open');
      const page = list.slice(0, first);
      const conn: Json = {};
      for (const sub of f.selections) {
        if (sub.name === 'nodes') conn[sub.alias] = page.map((p) => resolvePull(repo, p, sub.selections, errors));
        else if (sub.name === 'edges') conn[sub.alias] = page.map((p) => ({ node: resolvePull(repo, p, sub.selections.filter((s) => s.name === 'node').flatMap((s) => s.selections), errors) }));
        else if (sub.name === 'pageInfo') conn[sub.alias] = { hasNextPage: first < list.length, endCursor: null };
        else if (sub.name === 'totalCount') conn[sub.alias] = list.length;
      }
      out[f.alias] = conn;
    } else if (f.name === 'pullRequest') {
      const num = f.args.number as number;
      const pull = repo.pulls.find((p) => p.number === num);
      out[f.alias] = pull ? resolvePull(repo, pull, f.selections, errors) : null;
    }
  }
  return out;
}

function executeOperation(op: GqlOp, variables: Record<string, unknown>): { data: Json; errors: { message: string }[] } {
  const errors: string[] = [];
  const data: Json = {};
  for (const f of op.selections) {
    if (f.name === '__type') {
      const typeName = f.args.name as string;
      const entry: Json = { name: typeName };
      for (const sub of f.selections) {
        if (sub.name === 'fields') {
          const fields = typeName === 'Issue' ? ISSUE_TYPE_FIELDS : typeName === 'PullRequest' ? PR_TYPE_FIELDS : typeName === 'Repository' ? REPO_TYPE_FIELDS : [];
          entry[sub.alias] = fields.map((name) => ({ name }));
        } else if (sub.name === 'enumValues') {
          entry[sub.alias] = typeName === 'SearchType' ? SEARCH_ENUM.map((name) => ({ name })) : [];
        } else if (sub.name === 'name') entry[sub.alias] = typeName;
      }
      data[f.alias] = entry;
      continue;
    }
    if (f.name === 'viewer') {
      const viewer: Json = {};
      for (const sub of f.selections) {
        if (sub.name === 'login') viewer[sub.alias] = VIEWER.login;
        else if (sub.name === 'id') viewer[sub.alias] = globalId('user', VIEWER.id);
        else if (sub.name === 'name') viewer[sub.alias] = VIEWER.name;
        else if (sub.name === 'email') viewer[sub.alias] = VIEWER.email;
        else errors.push(`Field '${sub.name}' doesn't exist on type 'User'`);
      }
      data[f.alias] = viewer;
      continue;
    }
    if (f.name === 'repository') {
      const repo = store.get(String(f.args.owner ?? ''), String(f.args.name ?? ''));
      data[f.alias] = repo ? resolveRepository(repo, f.selections, errors) : null;
      continue;
    }
    if (f.name === 'node') {
      const id = f.args.id;
      const repo = findRepoByGlobalId(id);
      if (repo) {
        const node: Json = { id: globalId('repo', repo.id) };
        for (const sub of f.selections) {
          if (sub.inlineType !== null && sub.inlineType !== 'Repository') continue;
          if (sub.name === 'name') node[sub.alias] = repo.name;
          else if (sub.name === 'nameWithOwner') node[sub.alias] = repo.fullName;
          else if (sub.name === 'id') node[sub.alias] = globalId('repo', repo.id);
        }
        data[f.alias] = node;
      } else data[f.alias] = null;
      continue;
    }
    if (op.kind === 'mutation' && f.name === 'createIssue') {
      const input = (f.args.input ?? {}) as Record<string, unknown>;
      const repo = findRepoByGlobalId(input.repositoryId);
      if (!repo) { errors.push('Repository not found'); data[f.alias] = { issue: null }; continue; }
      const issue: Issue = { number: repo.nextIssue, title: String(input.title ?? ''), body: typeof input.body === 'string' ? input.body : '', state: 'open', labels: [], comments: [], seq: repo.issues.length };
      repo.nextIssue += 1;
      repo.issues.push(issue);
      const issueOut: Json = {};
      for (const sub of f.selections) if (sub.name === 'issue') issueOut[sub.alias] = resolveIssue(repo, issue, sub.selections, errors);
      data[f.alias] = issueOut;
      continue;
    }
    if (op.kind === 'mutation' && f.name === 'closeIssue') {
      const input = (f.args.input ?? {}) as Record<string, unknown>;
      const found = findIssueByGlobalId(input.issueId);
      if (!found) { errors.push('Issue not found'); data[f.alias] = { issue: null }; continue; }
      found.issue.state = 'closed';
      const out: Json = {};
      for (const sub of f.selections) if (sub.name === 'issue') out[sub.alias] = resolveIssue(found.repo, found.issue, sub.selections, errors);
      data[f.alias] = out;
      continue;
    }
    if (op.kind === 'mutation' && f.name === 'createPullRequest') {
      const input = (f.args.input ?? {}) as Record<string, unknown>;
      const repo = findRepoByGlobalId(input.repositoryId);
      if (!repo) { errors.push('Repository not found'); data[f.alias] = { pullRequest: null }; continue; }
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? repo.defaultBranch);
      const headSha = repo.branchTip(head);
      const baseSha = repo.branchTip(base);
      if (!headSha || !baseSha) { errors.push('Head or base branch not found'); data[f.alias] = { pullRequest: null }; continue; }
      const pull: Pull = { number: repo.nextPull, title: String(input.title ?? ''), body: typeof input.body === 'string' ? input.body : '', state: 'open', head, base, headSha, baseSha, merged: false, mergeSha: null, mergedAt: null, seq: repo.pulls.length };
      repo.nextPull += 1;
      repo.pulls.push(pull);
      const out: Json = {};
      for (const sub of f.selections) if (sub.name === 'pullRequest') out[sub.alias] = resolvePull(repo, pull, sub.selections, errors);
      data[f.alias] = out;
      continue;
    }
    if (op.kind === 'mutation' && f.name === 'mergePullRequest') {
      const input = (f.args.input ?? {}) as Record<string, unknown>;
      const found = findPullByGlobalId(input.pullRequestId);
      if (!found) { errors.push('Pull request not found'); data[f.alias] = { pullRequest: null }; continue; }
      mergePull(found.repo, found.pull);
      const out: Json = {};
      for (const sub of f.selections) if (sub.name === 'pullRequest') out[sub.alias] = resolvePull(found.repo, found.pull, sub.selections, errors);
      data[f.alias] = out;
      continue;
    }
    if (op.kind === 'mutation' && f.name === 'addComment') {
      const input = (f.args.input ?? {}) as Record<string, unknown>;
      const found = findIssueByGlobalId(input.subjectId);
      if (!found) { errors.push('Subject not found'); data[f.alias] = { commentEdge: null }; continue; }
      const comment = { id: found.repo.nextComment, body: String(input.body ?? '') };
      found.repo.nextComment += 1;
      found.issue.comments.push(comment);
      const out: Json = {};
      for (const sub of f.selections) {
        if (sub.name === 'commentEdge') {
          const node: Json = {};
          for (const n of sub.selections) {
            if (n.name === 'node') {
              const inner: Json = {};
              for (const x of n.selections) {
                if (x.name === 'id') inner[x.alias] = globalId('comment', found.repo.id, comment.id);
                else if (x.name === 'body') inner[x.alias] = comment.body;
              }
              node[n.alias] = inner;
            }
          }
          out[sub.alias] = node;
        }
      }
      data[f.alias] = out;
      continue;
    }
    errors.push(`Field '${f.name}' doesn't exist on type '${op.kind === 'mutation' ? 'Mutation' : 'Query'}'`);
  }
  return { data, errors: errors.map((message) => ({ message })) };
}

async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (bearer(req) === null) { sendErr(res, 401, 'Requires authentication'); return true; }
  const raw = await readBody(req);
  let payload: unknown;
  try { payload = JSON.parse(raw.toString('utf8')) as unknown; } catch {
    sendJson(res, 400, { errors: [{ message: 'Invalid JSON body' }] });
    return true;
  }
  const ops = Array.isArray(payload) ? payload : [payload];
  const answers = [];
  for (const entry of ops) {
    const doc = entry as { query?: string; variables?: Record<string, unknown> };
    const query = typeof doc.query === 'string' ? doc.query : '';
    const variables = (doc.variables ?? {}) as Record<string, unknown>;
    try {
      const parsed = new GqlParser(query).parseDocument(variables);
      const results = parsed.map((op) => executeOperation(op, variables));
      // One document = one answer; merge its operations' data.
      const data: Json = {};
      const errors: { message: string }[] = [];
      for (const r of results) { Object.assign(data, r.data); errors.push(...r.errors); }
      answers.push(errors.length > 0 ? { data, errors } : { data });
    } catch (err) {
      answers.push({ data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] });
    }
  }
  sendJson(res, 200, Array.isArray(payload) ? answers : answers[0]);
  return true;
}

// ---------------------------------------------------------------- MCP
// Streamable HTTP, JSON-RPC 2.0, plain JSON answers (no SSE needed — the
// client accepts application/json). Modern era first: server/discover
// answers the 2026-07-28 revision; the 2025-11-25 initialize handshake
// is answered too, for a client that never discovers.

const MCP_TOOLS: Json[] = [
  { name: 'create_repo', description: 'Create a repository owned by the token user.', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' }, owner: { type: 'string', description: 'Owner login (defaults to the token user)' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get one repository by owner and name.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner' }, repo: { type: 'string', description: 'Repository name' }, full_name: { type: 'string', description: 'owner/repo' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Issue title' }, body: { type: 'string', description: 'Issue body' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner' }, repo: { type: 'string', description: 'Repository name' }, state: { type: 'string', description: 'open, closed or all' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Open a pull request from a head branch onto a base branch.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Pull request title' }, body: { type: 'string', description: 'Pull request body' }, head: { type: 'string', description: 'Head branch' }, base: { type: 'string', description: 'Base branch' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request by number.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner' }, repo: { type: 'string', description: 'Repository name' }, pull_number: { type: 'integer', description: 'Pull request number' } }, required: ['owner', 'repo', 'pull_number'] } },
  { name: 'list_pull_requests', description: 'List pull requests in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner' }, repo: { type: 'string', description: 'Repository name' }, state: { type: 'string', description: 'open, closed or all' } }, required: ['owner', 'repo'] } },
];

function mcpResult(res: ServerResponse, id: unknown, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, result }, { 'mcp-session-id': 'forge-1' });
}
function mcpError(res: ServerResponse, status: number, id: unknown, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } }, { 'mcp-session-id': 'forge-1' });
}
function toolText(payload: unknown): Json {
  const text = JSON.stringify(payload);
  return { content: [{ type: 'text', text }], structuredContent: payload, isError: false };
}
function toolFail(message: string): Json {
  return { content: [{ type: 'text', text: message }], isError: true };
}
function splitFullName(args: Json): { owner: string; repo: string } {
  if (typeof args.full_name === 'string' && (args.full_name as string).includes('/')) {
    const [owner, repo] = (args.full_name as string).split('/', 2);
    return { owner: owner as string, repo: repo as string };
  }
  return { owner: String(args.owner ?? VIEWER.login), repo: String(args.repo ?? args.repository ?? '') };
}
function missingArg(args: Json, keys: string[]): string | null {
  for (const k of keys) if (args[k] === undefined || args[k] === null || args[k] === '') return k;
  return null;
}

function callMcpTool(name: string, args: Json): Json {
  const norm = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const suffix = (want: string): boolean => norm === want || norm.endsWith(want);
  if (suffix('createrepo')) {
    const missing = missingArg(args, ['name']);
    if (missing) return toolFail(`Missing required argument: ${missing}`);
    const owner = typeof args.owner === 'string' && args.owner !== '' ? (args.owner as string) : VIEWER.login;
    const repoName = String(args.name);
    if (store.get(owner, repoName)) return toolFail(`Repository ${owner}/${repoName} already exists`);
    const repo = store.create(owner, repoName, args.private === true, typeof args.description === 'string' ? (args.description as string) : '');
    return toolText(repoJson(repo));
  }
  if (suffix('getrepo')) {
    const { owner, repo: repoName } = splitFullName(args);
    if (repoName === '') return toolFail('Missing required argument: repo');
    const repo = store.get(owner, repoName);
    if (!repo) return toolFail(`Repository ${owner}/${repoName} not found`);
    return toolText(repoJson(repo));
  }
  if (suffix('createissue')) {
    const missing = missingArg(args, ['title']);
    if (missing) return toolFail(`Missing required argument: ${missing}`);
    const { owner, repo: repoName } = splitFullName(args);
    const repo = store.get(owner, repoName);
    if (!repo) return toolFail(`Repository ${owner}/${repoName} not found`);
    const issue: Issue = { number: repo.nextIssue, title: String(args.title), body: typeof args.body === 'string' ? (args.body as string) : '', state: 'open', labels: [], comments: [], seq: repo.issues.length };
    repo.nextIssue += 1;
    repo.issues.push(issue);
    return toolText(issueJson(repo, issue));
  }
  if (suffix('listissues')) {
    const { owner, repo: repoName } = splitFullName(args);
    const repo = store.get(owner, repoName);
    if (!repo) return toolFail(`Repository ${owner}/${repoName} not found`);
    const state = typeof args.state === 'string' ? (args.state as string) : 'open';
    const list = state === 'all' ? repo.issues : repo.issues.filter((i) => i.state === state);
    return toolText(list.map((i) => issueJson(repo, i)));
  }
  if (suffix('createpullrequest')) {
    const missing = missingArg(args, ['title', 'head', 'base']);
    if (missing) return toolFail(`Missing required argument: ${missing}`);
    const { owner, repo: repoName } = splitFullName(args);
    const repo = store.get(owner, repoName);
    if (!repo) return toolFail(`Repository ${owner}/${repoName} not found`);
    const head = String(args.head);
    const base = String(args.base);
    const headSha = repo.branchTip(head);
    const baseSha = repo.branchTip(base);
    if (!headSha || !baseSha) return toolFail('Head or base branch not found');
    const pull: Pull = { number: repo.nextPull, title: String(args.title), body: typeof args.body === 'string' ? (args.body as string) : '', state: 'open', head, base, headSha, baseSha, merged: false, mergeSha: null, mergedAt: null, seq: repo.pulls.length };
    repo.nextPull += 1;
    repo.pulls.push(pull);
    return toolText(pullJson(repo, pull));
  }
  if (suffix('mergepullrequest')) {
    const { owner, repo: repoName } = splitFullName(args);
    const repo = store.get(owner, repoName);
    if (!repo) return toolFail(`Repository ${owner}/${repoName} not found`);
    const num = Number(args.pull_number ?? args.number);
    if (!Number.isInteger(num)) return toolFail('Missing required argument: pull_number');
    const pull = repo.pulls.find((p) => p.number === num);
    if (!pull) return toolFail(`Pull request #${num} not found`);
    const result = mergePull(repo, pull);
    if (!result.ok) return toolFail(result.message);
    return toolText(pullJson(repo, pull));
  }
  if (suffix('listpullrequests')) {
    const { owner, repo: repoName } = splitFullName(args);
    const repo = store.get(owner, repoName);
    if (!repo) return toolFail(`Repository ${owner}/${repoName} not found`);
    const state = typeof args.state === 'string' ? (args.state as string) : 'open';
    const list = state === 'all' ? repo.pulls : repo.pulls.filter((p) => p.state === state);
    return toolText(list.map((p) => pullJson(repo, p)));
  }
  return toolFail(`Unknown tool: ${name}`);
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method === 'DELETE') { sendJson(res, 200, {}); return true; }
  if (req.method !== 'POST') { sendErr(res, 405, 'Method Not Allowed'); return true; }
  const raw = await readBody(req);
  let payload: unknown;
  try { payload = JSON.parse(raw.toString('utf8')) as unknown; } catch {
    mcpError(res, 400, null, -32700, 'Parse error');
    return true;
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    mcpError(res, 400, null, -32700, 'Parse error');
    return true;
  }
  const msg = payload as { jsonrpc?: string; id?: unknown; method?: string; params?: Json };
  const id = msg.id ?? null;
  // Notifications carry no id: acknowledge and stop.
  if (msg.id === undefined) {
    sendJson(res, 202, {}, { 'mcp-session-id': 'forge-1' });
    return true;
  }
  if (bearer(req) === null) {
    mcpError(res, 401, id, -32001, 'Requires authentication');
    return true;
  }
  const method = typeof msg.method === 'string' ? msg.method : '';
  const params = (msg.params ?? {}) as Json;
  if (method === 'server/discover') {
    mcpResult(res, id, {
      protocolVersion: '2026-07-28',
      supportedVersions: ['2026-07-28', '2025-11-25'],
      capabilities: { tools: {} },
      serverInfo: { name: 'forge', version: '1.0.0' },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'forge', version: '1.0.0' } },
    });
    return true;
  }
  if (method === 'initialize') {
    const want = typeof params.protocolVersion === 'string' ? (params.protocolVersion as string) : '2025-11-25';
    const chosen = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'].includes(want) ? want : '2025-11-25';
    mcpResult(res, id, { protocolVersion: chosen, capabilities: { tools: {} }, serverInfo: { name: 'forge', version: '1.0.0' } });
    return true;
  }
  if (method === 'ping') { mcpResult(res, id, {}); return true; }
  if (method === 'tools/list') {
    mcpResult(res, id, { tools: MCP_TOOLS });
    return true;
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Json;
    const known = MCP_TOOLS.some((t) => (t as Json).name === toolName || String((t as Json).name).toLowerCase().replace(/[^a-z0-9]/g, '') === toolName.toLowerCase().replace(/[^a-z0-9]/g, ''));
    if (!known) {
      // Also accept a github__-prefixed spelling of a known tool.
      const bare = toolName.replace(/^github__/, '');
      const knownBare = MCP_TOOLS.some((t) => String((t as Json).name) === bare);
      if (!knownBare) { mcpError(res, 200, id, -32602, `Unknown tool: ${toolName}`); return true; }
      mcpResult(res, id, callMcpTool(bare, args));
      return true;
    }
    mcpResult(res, id, callMcpTool(toolName, args));
    return true;
  }
  mcpError(res, 200, id, -32601, `Method not found: ${method}`);
  return true;
}

// ---------------------------------------------------------------- server

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const { path, query } = urlOf(req);
        const method = req.method ?? 'GET';
        if (method === 'GET' && path === '/healthz') { sendJson(res, 200, { ok: true }); return; }
        if (path === '/api/graphql' && method === 'POST') { await handleGraphql(req, res); return; }
        if (path === '/mcp') { await handleMcp(req, res); return; }
        if (path.startsWith('/api/v3')) { await handleRest(req, res, method, path, query); return; }
        // Git smart HTTP: /{owner}/{repo}.git/...
        const parts = seg(path);
        if (parts.length >= 2 && (parts[1] as string).endsWith('.git')) {
          const owner = parts[0] as string;
          const repoName = (parts[1] as string).slice(0, -4);
          const repo = store.get(owner, repoName);
          const tail = parts.slice(2).join('/');
          if (!repo) { sendErr(res, 404, 'Not Found'); return; }
          const wantV2 = req.headers['git-protocol'] === 'version=2';
          if (method === 'GET' && tail === 'info/refs') {
            const service = query.get('service') as 'git-upload-pack' | 'git-receive-pack';
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') { sendErr(res, 400, 'Unknown service'); return; }
            const out = gitInfoRefs(repo, service, service === 'git-upload-pack' && wantV2);
            res.writeHead(200, { 'content-type': out.contentType, 'x-github-request-id': `forge-${(requestSeq += 1).toString(36)}`, 'content-length': String(out.body.length) });
            res.end(out.body);
            return;
          }
          if (method === 'POST' && (tail === 'git-upload-pack' || tail === 'git-receive-pack')) {
            const body = await readBody(req);
            const out = tail === 'git-upload-pack' ? gitUploadPack(repo, body, wantV2) : gitReceivePack(repo, body);
            res.writeHead(out.status, { 'content-type': out.contentType, 'x-github-request-id': `forge-${(requestSeq += 1).toString(36)}`, 'content-length': String(out.body.length) });
            res.end(out.body);
            return;
          }
          sendErr(res, 404, 'Not Found');
          return;
        }
        sendErr(res, 404, 'Not Found');
      } catch (err) {
        if (!res.headersSent) sendErr(res, 500, err instanceof Error ? err.message : 'Internal error');
        else res.end();
      }
    })();
  });
}
