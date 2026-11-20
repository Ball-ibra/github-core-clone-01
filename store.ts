// store.ts — the forge's whole memory: repositories, issues, pull requests,
// labels, comments, and the git object database behind them.
//
// Everything lives in Maps in this one process. Nothing is written to disk,
// so a trial's state is exactly what the API calls built, in order. Object
// ids are real git ids (sha1 of "<type> <len>\0<body>"), so a client that
// hashes what it cloned back gets the same ids we advertise.

import { createHash } from 'node:crypto';

export const VIEWER = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };
export const OTHER_USERS = [
  { id: 1001, login: 'quinnkeller', name: 'quinn keller', email: 'quinnkeller@example.invalid' },
  { id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid' },
];
export const ZERO_OID = '0'.repeat(40);
export const FIXED_TS = 1735689600; // 2025-01-01T00:00:00Z, fixed so ids are deterministic
export const AUTHOR_LINE = `adaiversen <adaiversen@example.invalid> ${FIXED_TS} +0000`;

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The git id of an object: sha1("<type> <byte length>\0" + body). */
export function hashObject(type: string, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([head, data]));
}

export interface TreeEntry { mode: string; name: string; oid: string; }
export type GitType = 'blob' | 'tree' | 'commit' | 'tag';
export interface GitObject { type: GitType; data: Buffer; }

/** Parse a tree object's entries (mode SP name NUL 20-byte oid, in order). */
export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const sp = data.indexOf(0x20, at);
    const nul = data.indexOf(0, sp);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) break;
    out.push({ mode: data.subarray(at, sp).toString('utf8'), name: data.subarray(sp + 1, nul).toString('utf8'), oid: data.subarray(nul + 1, nul + 21).toString('hex') });
    at = nul + 21;
  }
  return out;
}

/** Parse a commit's tree, parents and message out of its raw bytes. */
export function parseCommit(data: Buffer): { tree: string; parents: string[]; message: string } {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd < 0 ? text : text.slice(0, headEnd);
  const message = headEnd < 0 ? '' : text.slice(headEnd + 2);
  const parents: string[] = [];
  let tree = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

/** Parse a tag object: what it points at and its type. */
export function parseTag(data: Buffer): { object: string; type: string } {
  const text = data.toString('utf8');
  let object = '';
  let type = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
  }
  return { object, type };
}

export interface Issue {
  number: number; title: string; body: string; state: 'open' | 'closed';
  labels: string[]; comments: { id: number; body: string }[]; seq: number;
}
export interface Pull {
  number: number; title: string; body: string; state: 'open' | 'closed';
  head: string; base: string; headSha: string; baseSha: string;
  merged: boolean; mergeSha: string | null; mergedAt: string | null; seq: number;
}

export class Repo {
  id: number;
  owner: string;
  name: string;
  privateFlag: boolean;
  description: string;
  defaultBranch = 'main';
  branches = new Map<string, string>(); // branch name -> commit sha
  tags = new Map<string, string>(); // tag name -> object sha (tag or commit)
  objects = new Map<string, GitObject>();
  labels = new Map<string, { name: string; color: string }>();
  issues: Issue[] = [];
  pulls: Pull[] = [];
  nextIssue = 1;
  nextPull = 1;
  nextComment = 1;
  seq = 0; // creation order, for stable sorting
  constructor(id: number, owner: string, name: string, priv: boolean, description: string) {
    this.id = id; this.owner = owner; this.name = name;
    this.privateFlag = priv; this.description = description;
  }
  get fullName(): string { return `${this.owner}/${this.name}`; }
  branchTip(branch: string): string | undefined { return this.branches.get(branch); }
  /** The commit a ref name points at, peeling an annotated tag to its commit. */
  peel(oid: string): string {
    let cur = oid;
    for (let i = 0; i < 8; i += 1) {
      const obj = this.objects.get(cur);
      if (!obj || obj.type !== 'tag') return cur;
      cur = parseTag(obj.data).object;
    }
    return cur;
  }
  refOid(ref: string): string | undefined {
    if (ref.startsWith('refs/heads/')) return this.branches.get(ref.slice(11));
    if (ref.startsWith('refs/tags/')) return this.tags.get(ref.slice(10));
    return undefined;
  }
  setRef(ref: string, oid: string): void {
    if (ref.startsWith('refs/heads/')) this.branches.set(ref.slice(11), oid);
    else if (ref.startsWith('refs/tags/')) this.tags.set(ref.slice(10), oid);
  }
  deleteRef(ref: string): void {
    if (ref.startsWith('refs/heads/')) this.branches.delete(ref.slice(11));
    else if (ref.startsWith('refs/tags/')) this.tags.delete(ref.slice(10));
  }
  allRefs(): { name: string; oid: string }[] {
    const out: { name: string; oid: string }[] = [];
    for (const [name, oid] of [...this.branches.entries()].sort()) out.push({ name: `refs/heads/${name}`, oid });
    for (const [name, oid] of [...this.tags.entries()].sort()) out.push({ name: `refs/tags/${name}`, oid });
    return out;
  }
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 5000;
  repoSeq = 0;
  key(owner: string, name: string): string { return `${owner}/${name}`; }
  get(owner: string, name: string): Repo | undefined { return this.repos.get(this.key(owner, name)); }
  create(owner: string, name: string, priv: boolean, description: string): Repo {
    const repo = new Repo(this.nextRepoId, owner, name, priv, description);
    this.nextRepoId += 1;
    repo.seq = this.repoSeq;
    this.repoSeq += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }
  delete(owner: string, name: string): boolean { return this.repos.delete(this.key(owner, name)); }
  listFor(owner: string): Repo[] {
    return [...this.repos.values()].filter((r) => r.owner === owner).sort((a, b) => a.seq - b.seq);
  }
}

// ---------------------------------------------------------------- git objects

/** Build a tree object from sorted entries, returning its bytes. */
export function buildTreeBytes(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Store a tree built from a flat path -> blob map, returning the root tree id. */
export function storeTree(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  // Group paths by their first segment, recursing into subdirectories.
  const build = (paths: Map<string, { oid: string; mode: string }>, prefix: string): string => {
    const entries: TreeEntry[] = [];
    const dirs = new Map<string, Map<string, { oid: string; mode: string }>>();
    for (const [path, file] of paths) {
      const rest = prefix === '' ? path : path.slice(prefix.length + 1);
      const slash = rest.indexOf('/');
      if (slash < 0) entries.push({ mode: file.mode, name: rest, oid: file.oid });
      else {
        const dir = rest.slice(0, slash);
        let sub = dirs.get(dir);
        if (!sub) { sub = new Map(); dirs.set(dir, sub); }
        sub.set(path, file);
      }
    }
    for (const [dir, sub] of [...dirs.entries()].sort()) {
      entries.push({ mode: '40000', name: dir, oid: build(sub, prefix === '' ? dir : `${prefix}/${dir}`) });
    }
    const bytes = buildTreeBytes(entries);
    const oid = hashObject('tree', bytes);
    repo.objects.set(oid, { type: 'tree', data: bytes });
    return oid;
  };
  return build(files, '');
}

/** Flatten a tree into path -> {oid, mode}, walking subdirectories. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') {
      for (const [p, f] of flattenTree(repo, e.oid, path)) out.set(p, f);
    } else out.set(path, { oid: e.oid, mode: e.mode });
  }
  return out;
}

/** Store a blob, returning its id. */
export function storeBlob(repo: Repo, data: Buffer): string {
  const oid = hashObject('blob', data);
  repo.objects.set(oid, { type: 'blob', data });
  return oid;
}

/** Make a commit over a full file snapshot; parents may be empty (root). */
export function makeCommit(repo: Repo, files: Map<string, { oid: string; mode: string }>, parents: string[], message: string): string {
  const treeOid = storeTree(repo, files);
  const lines = [`tree ${treeOid}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${AUTHOR_LINE}`, `committer ${AUTHOR_LINE}`, '', message.endsWith('\n') ? message : `${message}\n`);
  const data = Buffer.from(lines.join('\n'), 'utf8');
  const oid = hashObject('commit', data);
  repo.objects.set(oid, { type: 'commit', data });
  return oid;
}

/** The files at a commit (empty map when the commit is unknown). */
export function filesAt(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return new Map();
  return flattenTree(repo, parseCommit(obj.data).tree);
}

/** True when `anc` is an ancestor of `desc` (or the same commit). */
export function isAncestor(repo: Repo, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const seen = new Set<string>();
  const stack = [desc];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (p === anc) return true;
      stack.push(p);
    }
  }
  return false;
}

/**
 * Collect the objects reachable from `roots`. With `maxDepth`, only commits
 * closer than that many generations are followed (depth 1 = the tips only);
 * their trees and blobs are always included in full.
 */
export function collectReachable(repo: Repo, roots: string[], maxDepth?: number): { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] } {
  const objects = new Map<string, GitObject>();
  const shallow: string[] = [];
  const queue: { oid: string; depth: number }[] = roots.filter((o) => o !== ZERO_OID).map((oid) => ({ oid, depth: 0 }));
  const seenCommits = new Set<string>();
  const addTree = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      const obj = repo.objects.get(cur);
      if (!obj || objects.has(cur)) continue;
      objects.set(cur, obj);
      if (obj.type !== 'tree') continue;
      for (const e of parseTree(obj.data)) {
        const child = repo.objects.get(e.oid);
        if (!child) continue;
        if (e.mode === '40000') stack.push(e.oid);
        else objects.set(e.oid, child);
      }
    }
  };
  while (queue.length > 0) {
    const { oid, depth } = queue.shift() as { oid: string; depth: number };
    // A tag object itself travels with its commit: keep it in the pack.
    const raw = repo.objects.get(oid);
    if (raw && raw.type === 'tag') objects.set(oid, raw);
    const peeled = repo.peel(oid);
    const obj = repo.objects.get(peeled);
    if (!obj) continue;
    if (obj.type !== 'commit') { objects.set(peeled, obj); continue; }
    if (seenCommits.has(peeled)) continue;
    seenCommits.add(peeled);
    objects.set(peeled, obj);
    const commit = parseCommit(obj.data);
    addTree(commit.tree);
    const atBoundary = maxDepth !== undefined && depth + 1 >= maxDepth;
    if (atBoundary) { shallow.push(peeled); continue; }
    for (const p of commit.parents) queue.push({ oid: p, depth: depth + 1 });
  }
  return { objects, shallow, unshallow: [] };
}

/** Opaque, stable global ids (base64url of a typed key — never the bare number). */
export function globalId(kind: string, repoId: number, num?: number): string {
  const raw = num === undefined ? `${kind}:${repoId}` : `${kind}:${repoId}:${num}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}
export function parseGlobalId(id: string): { kind: string; repoId: number; num: number | null } | null {
  try {
    const raw = Buffer.from(id, 'base64url').toString('utf8');
    const parts = raw.split(':');
    if (parts.length < 2) return null;
    return { kind: parts[0] as string, repoId: Number(parts[1]), num: parts.length > 2 ? Number(parts[2]) : null };
  } catch { return null; }
}
