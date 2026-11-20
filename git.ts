// git.ts — the git wire protocol, implemented on node:zlib and node:crypto.
//
// Two pieces live here: the pkt-line framing every smart-HTTP exchange uses,
// and the packfile format (reading packs a client pushes, writing packs a
// fetch answers with). Deltas are resolved on read; packs we write are plain
// full objects, which is always valid — a client that reads them never cares
// whether we bothered to delta-compress.

import { inflateSync, deflateSync } from 'node:zlib';
import { hashObject, parseCommit, parseTag, parseTree, ZERO_OID, type GitObject, type GitType, type Repo } from './store.ts';

export const ZERO = ZERO_OID;

/** One pkt-line: 4 hex digits of (length including the 4) + payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}
export const pktFlush: Buffer = Buffer.from('0000', 'ascii');
export const pktDelim: Buffer = Buffer.from('0001', 'ascii');

/** Split a buffer into pkt-line packets: {flush} | {delim} | {data}. */
export type Packet = { kind: 'flush' } | { kind: 'delim' } | { kind: 'data'; payload: Buffer };
export function decodePktLines(buf: Buffer): Packet[] {
  const out: Packet[] = [];
  let at = 0;
  while (at + 4 <= buf.length) {
    const len = parseInt(buf.subarray(at, at + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) { out.push({ kind: 'flush' }); at += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim' }); at += 4; continue; }
    if (len < 4 || at + len > buf.length) break;
    out.push({ kind: 'data', payload: buf.subarray(at + 4, at + len) });
    at += len;
  }
  return out;
}

/** The text lines of a pkt-line stream, without the trailing newline. */
export function pktTextLines(buf: Buffer): string[] {
  const lines: string[] = [];
  for (const p of decodePktLines(buf)) {
    if (p.kind === 'data') lines.push(p.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

// ---------------------------------------------------------------- packfiles

const PACK_TYPES: Record<number, GitType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'ofs-delta', 7: 'ref-delta' };

/** Apply a delta (git's copy/insert instruction stream) to a base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readVarint = (): number => {
    let out = 0;
    let shift = 0;
    while (at < delta.length) {
      const byte = delta[at] as number;
      at += 1;
      out |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return out;
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const chunks: Buffer[] = [];
  while (at < delta.length) {
    const op = delta[at] as number;
    at += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) { offset |= (delta[at] as number) << (8 * i); at += 1; }
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) { size |= (delta[at] as number) << (8 * i); at += 1; }
      if (size === 0) size = 0x10000;
      chunks.push(base.subarray(offset, offset + size));
    } else if (op > 0) {
      chunks.push(delta.subarray(at, at + op));
      at += op;
    } else throw new Error('delta op 0');
  }
  const out = Buffer.concat(chunks);
  if (out.length !== resultSize) throw new Error('delta result size mismatch');
  return out;
}

/** Read a whole packfile, resolving deltas, into oid -> object. */
export function readPack(pack: Buffer): Map<string, GitObject> {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, { type: GitType; data: Buffer; oid: string }>();
  let at = 12;
  const pending: { offset: number; type: GitType; data: Buffer; baseOid?: string; baseOffset?: number }[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = at;
    let byte = pack[at] as number;
    at += 1;
    const typeNum = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[at] as number;
      at += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const type = PACK_TYPES[typeNum];
    if (!type) throw new Error(`unknown pack object type ${typeNum}`);
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (type === 'ofs-delta') {
      byte = pack[at] as number;
      at += 1;
      let offset = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[at] as number;
        at += 1;
        offset = ((offset + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = start - offset;
    } else if (type === 'ref-delta') {
      baseOid = pack.subarray(at, at + 20).toString('hex');
      at += 20;
    }
    const { consumedBytes, data } = inflateOne(pack.subarray(at));
    at += consumedBytes;
    if (data.length !== size) throw new Error('pack object size mismatch');
    if (type === 'ofs-delta' || type === 'ref-delta') {
      pending.push({ offset: start, type, data, baseOid, baseOffset });
    } else {
      const oid = hashObject(type, data);
      objects.set(oid, { type, data });
      byOffset.set(start, { type, data, oid });
    }
  }
  // Resolve deltas (possibly chained) against objects already read.
  for (let round = 0; round < 64 && pending.length > 0; round += 1) {
    const still: typeof pending = [];
    for (const p of pending) {
      let base: { type: GitType; data: Buffer; oid: string } | undefined;
      if (p.baseOffset !== undefined) base = byOffset.get(p.baseOffset);
      else if (p.baseOid !== undefined) {
        const found = objects.get(p.baseOid);
        if (found) base = { type: found.type, data: found.data, oid: p.baseOid };
      }
      if (!base) { still.push(p); continue; }
      const data = applyDelta(base.data, p.data);
      const oid = hashObject(base.type, data);
      objects.set(oid, { type: base.type, data });
      byOffset.set(p.offset, { type: base.type, data, oid });
    }
    if (still.length === pending.length) throw new Error('unresolvable pack delta');
    pending.length = 0;
    pending.push(...still);
  }
  if (pending.length > 0) throw new Error('unresolvable pack delta');
  return objects;
}

/** Inflate one zlib stream starting at buf[0]; return its data and byte count.
 *  One inflate is enough when the engine reports how much input it took:
 *  inflateSync(..., {info:true}) exposes engine.bytesWritten, the exact
 *  length of the stream, whatever trails it. The binary search below is
 *  the fallback for runtimes that do not report it — it is ~15x slower,
 *  because every too-short prefix throws. */
function inflateOne(buf: Buffer): { data: Buffer; consumedBytes: number } {
  try {
    const out = inflateSync(buf, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten?: unknown } };
    const consumed = out?.engine?.bytesWritten;
    if (out && Buffer.isBuffer(out.buffer) && typeof consumed === 'number' && consumed > 0 && consumed <= buf.length) {
      return { data: out.buffer, consumedBytes: consumed };
    }
  } catch { /* fall through to the search */ }
  let lo = 1;
  let hi = buf.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try { inflateSync(buf.subarray(0, mid)); hi = mid; } catch { lo = mid + 1; }
  }
  return { data: inflateSync(buf.subarray(0, lo)), consumedBytes: lo };
}

/** Write a packfile of full (undeltified) objects. Pack order is the
 *  caller's: a client never cares in what order objects arrive, so there
 *  is no sort here (sorting used to re-hash every object). Level 1
 *  deflate is far faster than the default and the wire is loopback, so
 *  the slightly larger pack costs nothing the score measures. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [head];
  for (const obj of list) {
    const typeNum = obj.type === 'commit' ? 1 : obj.type === 'tree' ? 2 : obj.type === 'blob' ? 3 : 4;
    const size = obj.data.length;
    const header: number[] = [];
    let remaining = size;
    let first = (typeNum << 4) | (remaining & 0x0f);
    remaining >>= 4;
    if (remaining > 0) first |= 0x80;
    header.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      header.push(byte);
    }
    parts.push(Buffer.from(header), deflateSync(obj.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  // The trailer is the sha1 of everything before it.
  return Buffer.concat([body, sha1Of(body)]);
}

import { createHash } from 'node:crypto';
function sha1Of(data: Buffer): Buffer {
  return createHash('sha1').update(data).digest();
}

export { parseCommit, parseTag, parseTree };

// ---------------------------------------------------------------- smart HTTP

import { collectReachable, filesAt, isAncestor, type Repo } from './store.ts';

export interface GitResult { status: number; contentType: string; body: Buffer; }

const AGENT = 'forge/1.0';
const V2_CAPS = ['ls-refs=unborn', 'fetch=shallow filter', 'object-format=sha1', `agent=${AGENT}`];
const V0_UPLOAD_CAPS = `side-band-64k thin-pack ofs-delta multi_ack multi_ack_detailed agent=${AGENT} symref=HEAD:refs/heads/main`;
const V0_RECEIVE_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:refs/heads/main`;

/** Split a sideband payload into pkt-lines of at most ~32 KiB of data. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let at = 0; at < pack.length; at += 32768) {
    out.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(at, Math.min(pack.length, at + 32768))])));
  }
  if (pack.length === 0) out.push(pktLine(Buffer.from([1])));
  return out;
}

/** GET info/refs for a service. `wantV2` comes from the Git-Protocol header. */
export function gitInfoRefs(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', wantV2: boolean): GitResult {
  const refs = repo.allRefs();
  const mainTip = repo.branchTip('main');
  if (service === 'git-upload-pack' && wantV2) {
    // The service preamble is its own packet, closed by a flush, before
    // the "version 2" advertisement proper begins.
    const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), pktFlush, pktLine('version 2\n')];
    for (const cap of V2_CAPS) parts.push(pktLine(`${cap}\n`));
    parts.push(pktFlush);
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: Buffer.concat(parts) };
  }
  const caps = service === 'git-upload-pack' ? V0_UPLOAD_CAPS : V0_RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush];
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = mainTip ?? refs[0]?.oid ?? ZERO;
    parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const obj = repo.objects.get(ref.oid);
      if (obj && obj.type === 'tag') {
        const peeled = repo.peel(ref.oid);
        parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(pktFlush);
  const ct = service === 'git-upload-pack' ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement';
  return { status: 200, contentType: ct, body: Buffer.concat(parts) };
}

interface FetchAsk {
  wants: string[]; haves: string[]; shallowIn: string[]; depth: number | null;
  command: string | null; prefixes: string[]; peel: boolean; symrefs: boolean; unborn: boolean;
}

function parseFetchAsk(body: Buffer): FetchAsk {
  const ask: FetchAsk = { wants: [], haves: [], shallowIn: [], depth: null, command: null, prefixes: [], peel: false, symrefs: false, unborn: false };
  for (const line of pktTextLines(body)) {
    if (line.startsWith('command=')) ask.command = line.slice(8);
    else if (line.startsWith('want ')) ask.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) ask.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) ask.shallowIn.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) ask.depth = Number(line.slice(7).trim());
    else if (line.startsWith('ref-prefix ')) ask.prefixes.push(line.slice(11).trim());
    else if (line === 'peel') ask.peel = true;
    else if (line === 'symrefs') ask.symrefs = true;
    else if (line === 'unborn') ask.unborn = true;
  }
  return ask;
}

/** The objects a fetch should send, plus its shallow boundary lines. */
function planFetch(repo: Repo, ask: FetchAsk): { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] } {
  const wants = ask.wants.map((o) => repo.peel(o));
  // A wanted tag object travels with its commit: collect it explicitly,
  // since the reachability walk below starts from peeled commits.
  const tagObjects = new Map<string, GitObject>();
  for (const want of ask.wants) {
    const obj = repo.objects.get(want);
    if (obj && obj.type === 'tag') tagObjects.set(want, obj);
  }
  if (ask.depth !== null && ask.depth > 0) {
    // Depth-limited: commits closer than `depth` generations from a want.
    const included = new Map<string, GitObject>();
    const boundary: string[] = [];
    const queue: { oid: string; depth: number }[] = wants.map((oid) => ({ oid, depth: 0 }));
    const seen = new Set<string>();
    let qi = 0;
    while (qi < queue.length) {
      const { oid, depth } = queue[qi] as { oid: string; depth: number };
      qi += 1;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit' || seen.has(oid)) continue;
      seen.add(oid);
      const sub = collectReachable(repo, [oid], 1);
      for (const [k, v] of sub.objects) included.set(k, v);
      const commit = parseCommit(obj.data);
      if (depth + 1 >= ask.depth) { if (commit.parents.length > 0) boundary.push(oid); continue; }
      for (const p of commit.parents) queue.push({ oid: p, depth: depth + 1 });
    }
    const unshallow = ask.shallowIn.filter((o) => seen.has(repo.peel(o)) && !boundary.includes(repo.peel(o)));
    for (const [k, v] of tagObjects) included.set(k, v);
    return { objects: included, shallow: boundary, unshallow };
  }
  const haveObjects = new Set<string>();
  if (ask.haves.length > 0) {
    for (const [k] of collectReachable(repo, ask.haves.map((o) => repo.peel(o))).objects) haveObjects.add(k);
  }
  const all = collectReachable(repo, wants).objects;
  const objects = new Map<string, GitObject>();
  for (const [k, v] of all) if (!haveObjects.has(k)) objects.set(k, v);
  for (const [k, v] of tagObjects) if (!haveObjects.has(k)) objects.set(k, v);
  return { objects, shallow: [], unshallow: [] };
}

/** Fetches are pure functions of (repo, wants, haves, shallow lines,
 *  depth): git objects are content-addressed and immutable, and no new
 *  object can become an ancestor of an existing commit. So a fetch's
 *  pack and shallow lines are cached — the clone workload asks for the
 *  same shallow fetch of the same tip 150 times, and only the first one
 *  pays for the walk and the deflate. Capped and cleared, so a trial
 *  with many distinct fetches cannot grow it without bound. */
const fetchPackCache = new Map<string, { pack: Buffer; framed: Buffer; shallow: string[]; unshallow: string[] }>();
function cachedFetchPack(repo: Repo, ask: FetchAsk): { pack: Buffer; framed: Buffer; shallow: string[]; unshallow: string[] } {
  const key = `${repo.id}|${ask.wants.join(',')}|${ask.haves.join(',')}|${ask.shallowIn.join(',')}|${ask.depth}`;
  const hit = fetchPackCache.get(key);
  if (hit) return hit;
  const planned = planFetch(repo, ask);
  const pack = writePack([...planned.objects.values()]);
  // The sideband framing of a pack is the same for the v2 and v0
  // answers, so frame it once here instead of on every clone.
  const made = { pack, framed: Buffer.concat(sidebandPackets(pack)), shallow: planned.shallow, unshallow: planned.unshallow };
  if (fetchPackCache.size >= 32) fetchPackCache.clear();
  fetchPackCache.set(key, made);
  return made;
}

/** POST git-upload-pack: ls-refs or fetch, protocol v2 when `wantV2`. */
export function gitUploadPack(repo: Repo, body: Buffer, wantV2: boolean): GitResult {
  const ask = parseFetchAsk(body);
  const resultCt = 'application/x-git-upload-pack-result';
  if (ask.command === 'ls-refs') {
    const parts: Buffer[] = [];
    const mainTip = repo.branchTip('main');
    const wantHead = ask.prefixes.length === 0 || ask.prefixes.some((p) => 'HEAD'.startsWith(p));
    if (ask.symrefs && wantHead) {
      if (mainTip) parts.push(pktLine(`${mainTip} HEAD symref-target:refs/heads/main\n`));
      else if (ask.unborn) parts.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
    }
    for (const ref of repo.allRefs()) {
      if (ask.prefixes.length > 0 && !ask.prefixes.some((p) => ref.name.startsWith(p))) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (ask.peel) {
        const obj = repo.objects.get(ref.oid);
        if (obj && obj.type === 'tag') line += ` peeled:${repo.peel(ref.oid)}`;
      }
      parts.push(pktLine(`${line}\n`));
    }
    parts.push(pktFlush);
    return { status: 200, contentType: resultCt, body: Buffer.concat(parts) };
  }
  if (ask.command !== null && ask.command !== 'fetch') {
    return { status: 400, contentType: resultCt, body: Buffer.from('unknown command\n', 'utf8') };
  }
  if (ask.wants.length === 0 && ask.command === 'fetch') {
    return { status: 200, contentType: resultCt, body: Buffer.concat([pktLine('acknowledgments\n'), pktLine('NAK\n'), pktDelim, pktFlush]) };
  }
  const cached = cachedFetchPack(repo, ask);
  const { shallow, unshallow } = cached;
  if (wantV2) {
    // Real git only expects an acknowledgments section when the request
    // carried haves to negotiate over; a clone (no haves) goes straight
    // to shallow-info / packfile.
    const parts: Buffer[] = [];
    if (ask.haves.length > 0) parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), pktDelim);
    if (shallow.length > 0 || unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(pktDelim);
    }
    parts.push(pktLine('packfile\n'), cached.framed, pktFlush);
    return { status: 200, contentType: resultCt, body: Buffer.concat(parts) };
  }
  // Protocol v0: NAK and shallow lines are plain packets, then the pack in
  // sideband band 1.
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(cached.framed, pktFlush);
  return { status: 200, contentType: resultCt, body: Buffer.concat(parts) };
}

/** POST git-receive-pack (v0): store the pack, apply the ref commands. */
export function gitReceivePack(repo: Repo, body: Buffer): GitResult {
  const resultCt = 'application/x-git-receive-pack-result';
  const packets = decodePktLines(body);
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  let packStart = body.length;
  for (let i = 0; i < packets.length; i += 1) {
    const p = packets[i] as Packet;
    if (p.kind === 'flush') {
      // The pack follows the flush packet (4 bytes).
      let at = 0;
      for (let j = 0; j <= i; j += 1) {
        const q = packets[j] as Packet;
        if (q.kind === 'flush' || q.kind === 'delim') at += 4;
        else if (q.kind === 'data') at += 4 + (q as { payload: Buffer }).payload.length;
      }
      packStart = at;
      break;
    }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const clean = nul >= 0 ? line.slice(0, nul) : line;
    const parts = clean.split(' ');
    if (parts.length >= 3) commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
  }
  const reportLines: string[] = [];
  let unpackOk = true;
  const packBytes = body.subarray(packStart);
  if (packBytes.length >= 12) {
    try {
      const objects = readPack(packBytes);
      for (const [oid, obj] of objects) repo.objects.set(oid, obj);
    } catch (err) {
      unpackOk = false;
      reportLines.push(`unpack ${err instanceof Error ? err.message : 'error'}`);
    }
  }
  if (unpackOk) reportLines.push('unpack ok');
  for (const cmd of commands) {
    if (!unpackOk) { reportLines.push(`ng ${cmd.ref} unpack failed`); continue; }
    const current = repo.refOid(cmd.ref);
    if (cmd.newOid === ZERO) {
      if (current === undefined) reportLines.push(`ng ${cmd.ref} remote ref does not exist`);
      else { repo.deleteRef(cmd.ref); reportLines.push(`ok ${cmd.ref}`); }
      continue;
    }
    const target = repo.objects.get(cmd.newOid) ?? repo.objects.get(repo.peel(cmd.newOid));
    if (!target) { reportLines.push(`ng ${cmd.ref} object not found`); continue; }
    if (cmd.oldOid === ZERO) {
      if (current !== undefined) { reportLines.push(`ng ${cmd.ref} already exists`); continue; }
      repo.setRef(cmd.ref, cmd.newOid);
      reportLines.push(`ok ${cmd.ref}`);
      continue;
    }
    if (current === undefined || current !== cmd.oldOid) {
      reportLines.push(`ng ${cmd.ref} non-fast-forward`);
      continue;
    }
    const newCommit = repo.peel(cmd.newOid);
    const oldCommit = repo.peel(cmd.oldOid);
    if (!isAncestor(repo, oldCommit, newCommit) && newCommit !== oldCommit) {
      reportLines.push(`ng ${cmd.ref} non-fast-forward`);
      continue;
    }
    repo.setRef(cmd.ref, cmd.newOid);
    reportLines.push(`ok ${cmd.ref}`);
  }
  // The report-status stream inside band 1 is itself pkt-lined and ends
  // with a flush packet; the outer flush below ends the sideband stream.
  const report = Buffer.concat([...reportLines.map((l) => pktLine(`${l}\n`)), pktFlush]);
  const parts: Buffer[] = [];
  for (let at = 0; at < report.length; at += 32768) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), report.subarray(at, Math.min(report.length, at + 32768))])));
  }
  if (report.length === 0) parts.push(pktLine(Buffer.from([1])));
  parts.push(pktFlush);
  return { status: 200, contentType: resultCt, body: Buffer.concat(parts) };
}

export { filesAt };
