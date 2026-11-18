// forge — a GitHub-compatible git forge (REST v3, GraphQL v4, MCP, git smart HTTP).
// Node 22 stdlib only. One process, in-memory store, no git binary, no outside services.
//
// Lifecycle: bind port 0, POST {"port": N} to $MAKEFUN_ENV_URL/register, then poll
// GET $MAKEFUN_ENV_URL/done until {"done": true}, then exit 0. Without MAKEFUN_ENV_URL
// (local practice runs) it just serves on the ephemeral port and logs it.
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';

// -------------------------------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------------------------------
const VERSION = '1.0.0';
const VIEWER = { login: 'adaiversen', id: 1000 };
const STRANGER = { login: 'olgabauer', id: 1001 };
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? 'test-token';
const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const ZERO_OID = '0000000000000000000000000000000000000000';
const DEFAULT_BRANCH = 'main';
const GIT_AUTHOR = 'adaiversen <adaiversen@users.noreply.github.com>';

// -------------------------------------------------------------------------------------------
// Small utilities
// -------------------------------------------------------------------------------------------
const nowIso = (): string => new Date().toISOString();
const sha1Hex = (data: Buffer): string => createHash('sha1').update(data).digest('hex');
const isOid = (s: string): boolean => /^[0-9a-f]{40}$/i.test(s);
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
const b64url = (s: string): string => b64(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s: string): string => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const lower = (s: unknown): string => (typeof s === 'string' ? s.toLowerCase() : '');
function jsonBody(res: ServerResponse, status: number, value: unknown, extra?: Record<string, string>): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': body.length,
    'x-github-request-id': randomUUID(),
    ...(extra ?? {}),
  });
  res.end(body);
}
function errJson(res: ServerResponse, status: number, message: string): void {
  jsonBody(res, status, { message });
}
function readBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  try {
    const raw = await readBody(req);
    if (raw.length === 0) return { ok: true, value: {} };
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false, error: 'malformed JSON body' };
  }
}
function authLogin(req: IncomingMessage): string | null {
  const h = req.headers.authorization ?? '';
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (!m) return null;
  if (m[1] !== TOKEN) return null;
  return VIEWER.login;
}

// -------------------------------------------------------------------------------------------
// Git objects
// -------------------------------------------------------------------------------------------
type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObject {
  type: ObjType;
  data: Buffer;
}
function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}
function storeObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}
interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}
function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  const message = headEnd === -1 ? '' : text.slice(headEnd + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}
interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}
function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const mode = data.subarray(i, sp).toString('ascii');
    const nul = data.indexOf(0, sp + 1);
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}
function buildTreeBytes(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}
/** git tree sort: entries sorted by name, directories as if suffixed with '/'. */
function treeSort(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
}
function parseTag(data: Buffer): { object: string; type: string; tag: string } {
  const text = data.toString('utf8');
  let object = '';
  let type = '';
  let tag = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line === '') break;
  }
  return { object, type, tag };
}
/** All objects reachable from roots (commits, tags, trees, blobs). Throws on missing object. */
function collectReachable(roots: readonly string[], lookup: (oid: string) => GitObject | undefined): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid) || oid === ZERO_OID) continue;
    const obj = lookup(oid);
    if (!obj) throw new Error(`missing-object ${oid}`);
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree, ...c.parents);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}
function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    stack.push(...parseCommit(obj.data).parents);
  }
  return false;
}
/** Peel a tag (recursively) to the commit it points at. */
function peelToCommit(repo: Repo, oid: string): string {
  let cur = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'tag') return cur;
    cur = parseTag(obj.data).object;
  }
  return cur;
}
/** Flat path -> blob oid map for the tree at a commit. */
function treeToPaths(repo: Repo, treeOid: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (oid: string, prefix: string): void => {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      const p = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') walk(e.oid, p);
      else out.set(p, e.oid);
    }
  };
  walk(treeOid, '');
  return out;
}
/** Build a full tree (nested) from a flat path -> blob map. Returns the root tree oid. */
function pathsToTree(repo: Repo, paths: Map<string, string>): string {
  interface Node {
    blobs: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const root: Node = { blobs: new Map(), dirs: new Map() };
  for (const [path, oid] of paths) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i]!;
      let next = node.dirs.get(part);
      if (!next) {
        next = { blobs: new Map(), dirs: new Map() };
        node.dirs.set(part, next);
      }
      node = next;
    }
    node.blobs.set(parts[parts.length - 1]!, oid);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of node.blobs) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return storeObject(repo, 'tree', buildTreeBytes(treeSort(entries)));
  };
  return build(root);
}
function makeCommit(repo: Repo, treeOid: string, parents: string[], message: string): string {
  const ts = Math.floor(Date.now() / 1000);
  const tz = '+0000';
  const lines = [`tree ${treeOid}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${GIT_AUTHOR} ${ts} ${tz}`);
  lines.push(`committer ${GIT_AUTHOR} ${ts} ${tz}`);
  const data = Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
  return storeObject(repo, 'commit', data);
}

// -------------------------------------------------------------------------------------------
// Pack format (PACK v2, no deltas) and pkt-lines
// -------------------------------------------------------------------------------------------
function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK'), Buffer.alloc(4), Buffer.alloc(4)];
  parts[1].writeUInt32BE(2, 0);
  parts[2].writeUInt32BE(objects.length, 0);
  const typeNum: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  for (const obj of objects) {
    const size = obj.data.length;
    const head: number[] = [];
    let s = size;
    let first = (typeNum[obj.type] << 4) | (s & 0x0f);
    s >>= 4;
    if (s) first |= 0x80;
    head.push(first);
    while (s) {
      let b = s & 0x7f;
      s >>= 7;
      if (s) b |= 0x80;
      head.push(b);
    }
    parts.push(Buffer.from(head));
    parts.push(deflateSync(obj.data, { level: 6 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}
interface ParsedPackObject {
  type: ObjType;
  data: Buffer;
  oid: string;
}
/** Pack parser that tracks exact zlib consumption via binary search on prefix length
 * (inflateSync throws on truncated input and succeeds with trailing bytes, so the
 * predicate "prefix inflates" is monotonic and the smallest successful end is the true
 * stream end). */
function parsePackStream(buf: Buffer): ParsedPackObject[] {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  if (buf.readUInt32BE(4) !== 2) throw new Error('unsupported pack version');
  const count = buf.readUInt32BE(8);
  const typeName: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
  const objects: ParsedPackObject[] = [];
  let off = 12;
  const zlibEnd = (start: number): { data: Buffer; end: number } => {
    // Fast path: inflate the first stream in one call (inflateSync stops at the stream end
    // and ignores trailing bytes), then re-deflate the result: the kit's pack writer uses
    // deflateSync defaults, so a byte-identical re-deflate proves the exact stream length.
    // Falls back to the binary search when the bytes do not reproduce (other writer settings).
    try {
      const data = inflateSync(buf.subarray(start));
      const re = deflateSync(data, { level: 6 });
      if (re.length <= buf.length - start && buf.subarray(start, start + re.length).equals(re)) {
        return { data, end: start + re.length };
      }
    } catch {
      // fall through to the binary search
    }
    // Binary-search the smallest end such that inflateSync(buf[start..end]) succeeds and the
    // stream is complete (inflateSync throws on truncated input).
    let lo = start + 1;
    let hi = buf.length;
    let found = -1;
    let foundData: Buffer | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      try {
        const d = inflateSync(buf.subarray(start, mid));
        found = mid;
        foundData = d;
        hi = mid - 1;
      } catch {
        lo = mid + 1;
      }
    }
    if (found === -1 || foundData === null) throw new Error('truncated zlib stream in pack');
    return { data: foundData, end: found };
  };
  for (let n = 0; n < count; n += 1) {
    let byte = buf[off++];
    const type = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[off++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (type === 6) {
      // ofs-delta: skip the base offset varint, then the delta stream
      let b = buf[off++];
      while (b & 0x80) b = buf[off++];
      const { data, end } = zlibEnd(off);
      void data;
      off = end;
      throw new Error('ofs-delta packs are not accepted');
    }
    if (type === 7) throw new Error('ref-delta packs are not accepted');
    const tname = typeName[type];
    if (!tname) throw new Error(`unknown pack object type ${type}`);
    const { data, end } = zlibEnd(off);
    if (data.length !== size) throw new Error('pack object size mismatch');
    off = end;
    objects.push({ type: tname, data, oid: hashObject(tname, data) });
  }
  return objects;
}
// pkt-lines
function pktLine(s: string): Buffer {
  const body = Buffer.from(s, 'utf8');
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}
function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}
function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}
type Pkt = { kind: 'data'; text: string; raw: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };
function parsePktLines(buf: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const lenHex = buf.subarray(off, off + 4).toString('ascii');
    const len = parseInt(lenHex, 16);
    if (Number.isNaN(len)) break; // not pkt-line data: the rest is the pack
    if (len === 0) {
      packets.push({ kind: 'flush' });
      off += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end' });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) break;
    const raw = buf.subarray(off + 4, off + len);
    packets.push({ kind: 'data', text: raw.toString('utf8'), raw });
    off += len;
  }
  return { packets, rest: buf.subarray(off) };
}

// -------------------------------------------------------------------------------------------
// Store
// -------------------------------------------------------------------------------------------
interface Label {
  name: string;
  color: string;
  description: string;
}
interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}
interface Issue {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  createdAt: string;
  updatedAt: string;
  seq: number;
}
interface Pull {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  createdAt: string;
  updatedAt: string;
  seq: number;
}
interface Repo {
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  databaseId: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextIssue: number;
  nextPull: number;
  nextCommentId: number;
}
const repos = new Map<string, Repo>();
let nextDatabaseId = 1;
let seqCounter = 1;
const repoKey = (owner: string, name: string): string => `${owner}/${name}`;
function gid(kind: string, key: string): string {
  return b64(`${kind}:${key}`);
}
function createRepo(owner: string, name: string, opts: { description?: string; private?: boolean } = {}): Repo {
  const repo: Repo = {
    owner,
    name,
    description: opts.description ?? '',
    private: opts.private ?? false,
    defaultBranch: DEFAULT_BRANCH,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    databaseId: nextDatabaseId++,
    refs: new Map(),
    objects: new Map(),
    labels: new Map(),
    issues: [],
    pulls: [],
    nextIssue: 1,
    nextPull: 1,
    nextCommentId: 1,
  };
  repos.set(repoKey(owner, name), repo);
  return repo;
}
function findRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}
function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.databaseId,
    node_id: gid('Repository', repoKey(repo.owner, repo.name)),
    name: repo.name,
    full_name: repoKey(repo.owner, repo.name),
    owner: { login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : STRANGER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    fork: false,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
  };
}
function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.number * 100000 + repo.databaseId,
    node_id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((n) => {
      const l = repo.labels.get(n);
      return { name: n, color: l?.color ?? 'ededed', description: l?.description ?? '' };
    }),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}
function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.number * 100000 + repo.databaseId + 50000,
    node_id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: computeMergeable(repo, pull) === 'MERGEABLE',
    mergeable_state: computeMergeable(repo, pull) === 'MERGEABLE' ? 'clean' : 'dirty',
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}`, user: { login: repo.owner, id: VIEWER.id } },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}`, user: { login: repo.owner, id: VIEWER.id } },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}
/** Merge-base of two commits: the first commit reachable from head that is also reachable from base. */
function mergeBase(repo: Repo, headOid: string, baseOid: string): string | null {
  const baseAncestors = new Set<string>();
  const stack = [baseOid];
  while (stack.length) {
    const oid = stack.pop()!;
    if (!oid || oid === ZERO_OID || baseAncestors.has(oid)) continue;
    baseAncestors.add(oid);
    const obj = repo.objects.get(oid);
    if (obj?.type === 'commit') stack.push(...parseCommit(obj.data).parents);
  }
  const seen = new Set<string>();
  const queue = [headOid];
  while (queue.length) {
    const oid = queue.shift()!;
    if (!oid || oid === ZERO_OID || seen.has(oid)) continue;
    seen.add(oid);
    if (baseAncestors.has(oid)) return oid;
    const obj = repo.objects.get(oid);
    if (obj?.type === 'commit') queue.push(...parseCommit(obj.data).parents);
  }
  return null;
}
/** The current tip of a branch ref, falling back to a stored sha when the ref is gone. */
function currentTip(repo: Repo, branch: string, fallback: string): string {
  return repo.refs.get(`refs/heads/${branch}`) ?? fallback;
}
/** 3-way merge of trees. Returns {tree, conflict}. */
function mergeTrees(repo: Repo, baseTreeOid: string, headTreeOid: string, baseBranchTreeOid: string): { tree: Map<string, string>; conflict: boolean } {
  const mb = treeToPaths(repo, baseTreeOid);
  const head = treeToPaths(repo, headTreeOid);
  const base = treeToPaths(repo, baseBranchTreeOid);
  const out = new Map<string, string>();
  let conflict = false;
  const all = new Set([...mb.keys(), ...head.keys(), ...base.keys()]);
  for (const p of all) {
    const m = mb.get(p);
    const h = head.get(p);
    const b = base.get(p);
    if (h === b) {
      if (h !== undefined) out.set(p, h);
    } else if (h === m) {
      if (b !== undefined) out.set(p, b);
    } else if (b === m) {
      if (h !== undefined) out.set(p, h);
    } else {
      conflict = true;
      if (h !== undefined) out.set(p, h);
    }
  }
  return { tree: out, conflict };
}
function computeMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  const headSha = currentTip(repo, pull.headRef, pull.headSha);
  const baseSha = currentTip(repo, pull.baseRef, pull.baseSha);
  const headObj = repo.objects.get(peelToCommit(repo, headSha));
  const baseObj = repo.objects.get(peelToCommit(repo, baseSha));
  if (!headObj || !baseObj || headObj.type !== 'commit' || baseObj.type !== 'commit') return 'UNKNOWN';
  const mb = mergeBase(repo, headSha, baseSha);
  if (mb === null) return 'UNKNOWN';
  const mbCommit = repo.objects.get(mb);
  if (!mbCommit || mbCommit.type !== 'commit') return 'UNKNOWN';
  const { conflict } = mergeTrees(repo, parseCommit(mbCommit.data).tree, parseCommit(headObj.data).tree, parseCommit(baseObj.data).tree);
  return conflict ? 'CONFLICTING' : 'MERGEABLE';
}
/** Line diff counts between two blobs (or missing). */
function diffCounts(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const oldLines = oldData === null ? [] : oldData.toString('utf8').split('\n');
  const newLines = newData === null ? [] : newData.toString('utf8').split('\n');
  if (oldData !== null && oldLines.length && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newData !== null && newLines.length && newLines[newLines.length - 1] === '') newLines.pop();
  const n = oldLines.length;
  const m = newLines.length;
  // LCS DP (files in the suite are small)
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = oldLines[i] === newLines[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const common = dp[0]![0]!;
  return { additions: m - common, deletions: n - common };
}
/** Files changed between the merge-base tree and the head tree of a pull request. */
function pullFiles(repo: Repo, pull: Pull): Record<string, unknown>[] {
  const headSha = currentTip(repo, pull.headRef, pull.headSha);
  const baseSha = currentTip(repo, pull.baseRef, pull.baseSha);
  const mb = mergeBase(repo, headSha, baseSha);
  const headCommit = repo.objects.get(peelToCommit(repo, headSha));
  if (!headCommit || headCommit.type !== 'commit') return [];
  const headPaths = treeToPaths(repo, parseCommit(headCommit.data).tree);
  const basePaths = new Map<string, string>();
  if (mb !== null) {
    const mbCommit = repo.objects.get(mb);
    if (mbCommit?.type === 'commit') {
      for (const [p, oid] of treeToPaths(repo, parseCommit(mbCommit.data).tree)) basePaths.set(p, oid);
    }
  }
  const out: Record<string, unknown>[] = [];
  const all = new Set([...basePaths.keys(), ...headPaths.keys()]);
  for (const p of [...all].sort()) {
    const b = basePaths.get(p);
    const h = headPaths.get(p);
    if (b === h) continue;
    const oldData = b === undefined ? null : repo.objects.get(b)?.data ?? null;
    const newData = h === undefined ? null : repo.objects.get(h)?.data ?? null;
    const status = b === undefined ? 'added' : h === undefined ? 'removed' : 'modified';
    const { additions, deletions } = diffCounts(oldData, newData);
    out.push({ filename: p, status, additions, deletions, changes: additions + deletions });
  }
  return out;
}
/** Commits reachable from a tip, newest first (BFS by insertion order approximates recency). */
function listCommits(repo: Repo, tip: string, limit = 100): { sha: string; commit: CommitInfo }[] {
  const out: { sha: string; commit: CommitInfo }[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length && out.length < limit) {
    const oid = queue.shift()!;
    if (!oid || oid === ZERO_OID || seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const info = parseCommit(obj.data);
    out.push({ sha: oid, commit: info });
    queue.push(...info.parents);
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// Git smart HTTP
// -------------------------------------------------------------------------------------------
function refLines(repo: Repo): { name: string; oid: string }[] {
  const out: { name: string; oid: string }[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  if (headOid) out.push({ name: 'HEAD', oid: headOid });
  for (const name of [...repo.refs.keys()].sort()) {
    out.push({ name, oid: repo.refs.get(name)! });
  }
  return out;
}
function v0Advertisement(repo: Repo, service: string): Buffer {
  const caps = [
    'multi_ack',
    'thin-pack',
    'side-band',
    'side-band-64k',
    'ofs-delta',
    'shallow',
    'no-progress',
    'report-status',
    'delete-refs',
    'agent=forge/1.0',
    'object-format=sha1',
    `symref=HEAD:refs/heads/${repo.defaultBranch}`,
  ].join(' ');
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = refLines(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((r, i) => {
      const suffix = i === 0 ? `\0${caps}` : '';
      const symref = r.name === 'HEAD' ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
      parts.push(pktLine(`${r.oid} ${r.name}${suffix}${symref}\n`));
    });
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}
function v2Advertisement(): Buffer {
  const parts: Buffer[] = [
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    pktLine('agent=forge/1.0\n'),
    pktFlush(),
  ];
  return Buffer.concat(parts);
}
function lsRefsResponse(repo: Repo, args: Map<string, string[]>): Buffer {
  const peel = args.has('peel');
  const symrefs = args.has('symrefs');
  const unborn = args.has('unborn');
  const prefixes = args.get('ref-prefix') ?? [];
  const parts: Buffer[] = [];
  const refs = refLines(repo);
  const realRefs = refs.filter((r) => r.name.startsWith('refs/'));
  if (realRefs.length === 0) {
    if (unborn) parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
  } else {
    for (const r of refs) {
      if (prefixes.length && !prefixes.some((p) => r.name.startsWith(p))) continue;
      let line = `${r.oid} ${r.name}`;
      if (r.name === 'HEAD' && symrefs) line += ` symref-target:refs/heads/${repo.defaultBranch}`;
      if (peel && r.name.startsWith('refs/tags/')) {
        const obj = repo.objects.get(r.oid);
        if (obj?.type === 'tag') line += ` peeled:${peelToCommit(repo, r.oid)}`;
      }
      parts.push(pktLine(`${line}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}
interface FetchPlan {
  objects: GitObject[];
  shallowTips: string[];
  unshallow: string[];
}
function planFetch(repo: Repo, wants: string[], haves: string[], shallowIn: string[], depth: number | null): FetchPlan {
  const shallowSet = new Set(shallowIn);
  // Objects the client already holds: everything reachable from its haves, EXCEPT that a
  // shallow boundary's ancestors are NOT held (a shallow clone has the tip, not its history).
  const held = new Set<string>();
  const hstack = [...haves, ...shallowIn];
  while (hstack.length) {
    const oid = hstack.pop()!;
    if (!oid || oid === ZERO_OID || held.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    held.add(oid);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      const tstack = [info.tree];
      while (tstack.length) {
        const t = tstack.pop()!;
        if (!t || t === ZERO_OID || held.has(t)) continue;
        const tobj = repo.objects.get(t);
        if (!tobj) continue;
        held.add(t);
        if (tobj.type === 'tree') for (const e of parseTree(tobj.data)) tstack.push(e.oid);
      }
      if (!shallowSet.has(oid)) for (const p of info.parents) hstack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) hstack.push(e.oid);
    } else if (obj.type === 'tag') {
      hstack.push(parseTag(obj.data).object);
    }
  }
  // Walk commits from the wants, tracking distance. Held commits are not sent, but the walk
  // continues through them: a shallow client's have may be a boundary whose parents are wanted.
  const sentCommits = new Set<string>();
  const boundary = new Set<string>(); // commits at the depth cutoff (their parents stay behind)
  const queue: { oid: string; dist: number }[] = wants.map((w) => ({ oid: w, dist: 0 }));
  const seen = new Set<string>();
  while (queue.length) {
    const { oid, dist } = queue.shift()!;
    if (!oid || oid === ZERO_OID || seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      if (!seen.has(target)) queue.push({ oid: target, dist });
      continue;
    }
    if (obj.type !== 'commit') continue;
    const info = parseCommit(obj.data);
    if (depth !== null && dist >= depth) {
      boundary.add(oid);
      continue;
    }
    if (!held.has(oid)) {
      sentCommits.add(oid);
      if (depth !== null && dist === depth - 1) boundary.add(oid);
    }
    for (const p of info.parents) queue.push({ oid: p, dist: dist + 1 });
  }
  // Objects to send: each sent commit plus its trees/blobs, minus anything already held.
  // (Full reachability from a sent commit would drag in its parents' history: wrong for shallow.)
  const send = new Set<string>();
  const addTree = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length) {
      const t = stack.pop()!;
      if (!t || t === ZERO_OID || send.has(t) || held.has(t)) continue;
      const tobj = repo.objects.get(t);
      if (!tobj) continue;
      send.add(t);
      if (tobj.type === 'tree') for (const e of parseTree(tobj.data)) stack.push(e.oid);
    }
  };
  for (const c of sentCommits) {
    if (!held.has(c)) send.add(c);
    const obj = repo.objects.get(c);
    if (obj?.type === 'commit') addTree(parseCommit(obj.data).tree);
  }
  for (const w of wants) {
    const obj = repo.objects.get(w);
    if (obj?.type === 'tag' && !held.has(w)) send.add(w);
  }
  const objects: GitObject[] = [];
  for (const oid of send) {
    const obj = repo.objects.get(oid);
    if (obj) objects.push(obj);
  }
  // New shallow tips: sent commits at the depth cutoff whose parents stay behind (neither
  // sent nor already held by the client).
  const shallowTips: string[] = [];
  if (depth !== null) {
    for (const oid of boundary) {
      if (!sentCommits.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (obj?.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.length && parents.some((p) => !sentCommits.has(p) && !held.has(p))) shallowTips.push(oid);
    }
  }
  // Unshallow: a previously-shallow tip whose parent is now sent.
  const unshallow: string[] = [];
  for (const s of shallowIn) {
    const obj = repo.objects.get(s);
    if (obj?.type === 'commit') {
      if (parseCommit(obj.data).parents.some((p) => sentCommits.has(p))) unshallow.push(s);
    }
  }
  return { objects, shallowTips, unshallow };
}
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65515; // 1 band byte + 65515 payload + 4 length = 65520 (pkt-line maximum)
  for (let off = 0; off < pack.length; off += CHUNK) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    const len = payload.length + 4;
    parts.push(Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), payload]));
  }
  return parts;
}
async function handleGitUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const body = await readBody(req);
  const { packets } = parsePktLines(body);
  const first = packets[0];
  const firstText = first?.kind === 'data' ? first.text : '';
  if (firstText.startsWith('command=ls-refs')) {
    const args = new Map<string, string[]>();
    for (const p of packets.slice(1)) {
      if (p.kind !== 'data') continue;
      const line = p.text.replace(/\n$/, '');
      // ls-refs arguments are space-separated ("ref-prefix refs/heads/", "peel", "unborn").
      const sp = line.indexOf(' ');
      const key = sp === -1 ? line : line.slice(0, sp);
      const val = sp === -1 ? '' : line.slice(sp + 1);
      const arr = args.get(key) ?? [];
      arr.push(val);
      args.set(key, arr);
    }
    const out = lsRefsResponse(repo, args);
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': out.length });
    res.end(out);
    return;
  }
  if (firstText.startsWith('command=fetch')) {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallowIn: string[] = [];
    let depth: number | null = null;
    for (const p of packets.slice(1)) {
      if (p.kind !== 'data') continue;
      const line = p.text.replace(/\n$/, '');
      if (line.startsWith('want ')) wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) shallowIn.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = parseInt(line.slice(7).trim(), 10) || null;
    }
    const plan = planFetch(repo, wants, haves, shallowIn, depth);
    const parts: Buffer[] = [];
    if (haves.length) {
      parts.push(pktLine('acknowledgments\n'));
      let acked = false;
      for (const h of haves) {
        if (repo.objects.has(h)) {
          parts.push(pktLine(`ACK ${h}\n`));
          acked = true;
        }
      }
      if (!acked) parts.push(pktLine('NAK\n'));
      parts.push(pktDelim());
    }
    if (plan.shallowTips.length || plan.unshallow.length) {
      parts.push(pktLine('shallow-info\n'));
      for (const s of plan.shallowTips) parts.push(pktLine(`shallow ${s}\n`));
      for (const u of plan.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
      parts.push(pktDelim());
    }
    if (plan.objects.length) {
      parts.push(pktLine('packfile\n'));
      const pack = writePack(plan.objects);
      parts.push(...sidebandPack(pack));
    }
    parts.push(pktFlush());
    const out = Buffer.concat(parts);
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': out.length });
    res.end(out);
    return;
  }
  // v0 fetch fallback: want/have/done lines without a command.
  if (firstText.startsWith('want ')) {
    const wants: string[] = [];
    const haves: string[] = [];
    for (const p of packets) {
      if (p.kind !== 'data') continue;
      const line = p.text.replace(/\n$/, '');
      if (line.startsWith('want ')) wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    }
    const plan = planFetch(repo, wants, haves, [], null);
    const parts: Buffer[] = [pktLine('NAK\n')];
    if (plan.objects.length) parts.push(...sidebandPack(writePack(plan.objects)));
    parts.push(pktFlush());
    const out = Buffer.concat(parts);
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': out.length });
    res.end(out);
    return;
  }
  res.writeHead(400, { 'content-type': 'text/plain' });
  res.end('bad request');
}
async function handleGitReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const body = await readBody(req);
  const { packets, rest } = parsePktLines(body);
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  for (const p of packets) {
    if (p.kind !== 'data') break;
    let line = p.text.replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul !== -1) line = line.slice(0, nul);
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (!m) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad command line');
      return;
    }
    commands.push({ oldOid: m[1]!, newOid: m[2]!, ref: m[3]! });
  }
  // Unpack the pack (if any). A delete-only push carries none.
  let unpackError: string | null = null;
  if (rest.length > 0) {
    try {
      const objects = parsePackStream(rest);
      for (const o of objects) {
        if (!repo.objects.has(o.oid)) repo.objects.set(o.oid, { type: o.type, data: o.data });
      }
    } catch (e) {
      unpackError = e instanceof Error ? e.message : String(e);
    }
  }
  const reportLines: string[] = [];
  if (unpackError !== null) {
    reportLines.push(`unpack ${unpackError}`);
    for (const c of commands) reportLines.push(`ng ${c.ref} unpack failed`);
  } else {
    reportLines.push('unpack ok');
    for (const c of commands) {
      const current = repo.refs.get(c.ref);
      let ok = true;
      let reason = '';
      if (c.newOid === ZERO_OID) {
        // delete
        if (current === undefined) {
          ok = false;
          reason = 'ref does not exist';
        } else if (c.oldOid !== ZERO_OID && c.oldOid !== current) {
          ok = false;
          reason = 'non-fast-forward';
        }
      } else {
        if (!repo.objects.has(c.newOid)) {
          ok = false;
          reason = 'object not found';
        } else if (current === undefined) {
          if (c.oldOid !== ZERO_OID) {
            ok = false;
            reason = 'non-fast-forward';
          }
        } else if (c.oldOid !== current) {
          ok = false;
          reason = 'non-fast-forward';
        } else if (!isAncestor(repo, current, c.newOid)) {
          ok = false;
          reason = 'non-fast-forward';
        }
      }
      if (ok) {
        if (c.newOid === ZERO_OID) repo.refs.delete(c.ref);
        else repo.refs.set(c.ref, c.newOid);
        repo.updatedAt = nowIso();
        reportLines.push(`ok ${c.ref}`);
      } else {
        reportLines.push(`ng ${c.ref} ${reason}`);
      }
    }
  }
  const report = Buffer.concat(reportLines.map((l) => pktLine(`${l}\n`)));
  const payload = Buffer.concat([Buffer.from([1]), report]);
  const len = payload.length + 4;
  const out = Buffer.concat([
    Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'),
    payload,
    pktFlush(),
  ]);
  res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': out.length });
  res.end(out);
}
function handleInfoRefs(req: IncomingMessage, res: ServerResponse, repo: Repo, service: string): void {
  const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  let out: Buffer;
  let contentType: string;
  if (service === 'git-upload-pack') {
    if (v2) {
      out = v2Advertisement();
    } else {
      out = v0Advertisement(repo, service);
    }
    contentType = 'application/x-git-upload-pack-advertisement';
  } else if (service === 'git-receive-pack') {
    out = v0Advertisement(repo, service);
    contentType = 'application/x-git-receive-pack-advertisement';
  } else {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('bad service');
    return;
  }
  res.writeHead(200, { 'content-type': contentType, 'content-length': out.length });
  res.end(out);
}

// -------------------------------------------------------------------------------------------
// REST v3
// -------------------------------------------------------------------------------------------
function repoOr404(res: ServerResponse, owner: string, name: string): Repo | null {
  const repo = findRepo(owner, name);
  if (!repo) {
    errJson(res, 404, 'Not Found');
    return null;
  }
  return repo;
}
function paginate<T>(items: T[], query: URLSearchParams): { page: T[]; total: number; pageNum: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const pageNum = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), total: items.length, pageNum, perPage };
}
function linkHeader(req: IncomingMessage, basePath: string, query: URLSearchParams, pageNum: number, perPage: number, total: number): string {
  const host = req.headers.host ?? '127.0.0.1';
  const proto = 'http';
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const mk = (p: number): string => `${proto}://${host}${basePath}?per_page=${perPage}&page=${p}`;
  const parts: string[] = [];
  if (pageNum < totalPages) parts.push(`<${mk(pageNum + 1)}>; rel="next"`);
  if (pageNum > 1) parts.push(`<${mk(pageNum - 1)}>; rel="prev"`);
  parts.push(`<${mk(1)}>; rel="first"`);
  parts.push(`<${mk(totalPages)}>; rel="last"`);
  return parts.join(', ');
}
async function handleRest(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<void> {
  const login = authLogin(req);
  if (!login) {
    errJson(res, 401, 'Requires authentication');
    return;
  }
  const seg = path.split('/').filter((s) => s.length > 0).map((s) => decodeURIComponent(s));
  // seg[0] === 'api', seg[1] === 'v3'
  const rest = seg.slice(2);
  const method = req.method ?? 'GET';
  // GET /api/v3/ (root) and /api/v3/meta
  if (rest.length === 0) {
    if (method !== 'GET') {
      errJson(res, 404, 'Not Found');
      return;
    }
    jsonBody(res, 200, {}, { 'x-oauth-scopes': 'repo, user' });
    return;
  }
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') {
      errJson(res, 404, 'Not Found');
      return;
    }
    jsonBody(res, 200, { installed_version: VERSION });
    return;
  }
  if (rest.length === 1 && rest[0] === 'user' && method === 'GET') {
    jsonBody(res, 200, { login: VIEWER.login, id: VIEWER.id, type: 'User', node_id: gid('User', VIEWER.login) });
    return;
  }
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'POST') {
      const parsed = await readJson(req);
      if (!parsed.ok) {
        errJson(res, 400, parsed.error);
        return;
      }
      const body = (parsed.value ?? {}) as Record<string, unknown>;
      const name = typeof body.name === 'string' ? body.name : '';
      if (!name) {
        errJson(res, 422, 'name is required');
        return;
      }
      if (findRepo(login, name)) {
        errJson(res, 422, 'Repository already exists');
        return;
      }
      const repo = createRepo(login, name, {
        description: typeof body.description === 'string' ? body.description : '',
        private: body.private === true,
      });
      jsonBody(res, 201, repoJson(repo));
      return;
    }
    if (method === 'GET') {
      const mine = [...repos.values()].filter((r) => r.owner === login);
      const { page, total, pageNum, perPage } = paginate(mine, query);
      const link = linkHeader(req, '/api/v3/user/repos', query, pageNum, perPage, total);
      jsonBody(res, 200, page.map(repoJson), { link });
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1]!;
    const name = rest[2]!;
    const tail = rest.slice(3);
    const repo = repoOr404(res, owner, name);
    if (!repo) return;
    // /repos/{o}/{r} itself
    if (tail.length === 0) {
      if (method === 'GET') {
        jsonBody(res, 200, repoJson(repo));
        return;
      }
      if (method === 'PATCH') {
        const parsed = await readJson(req);
        if (!parsed.ok) {
          errJson(res, 400, parsed.error);
          return;
        }
        const body = (parsed.value ?? {}) as Record<string, unknown>;
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        repo.updatedAt = nowIso();
        jsonBody(res, 200, repoJson(repo));
        return;
      }
      if (method === 'DELETE') {
        repos.delete(repoKey(owner, name));
        res.writeHead(204, { 'x-github-request-id': randomUUID() });
        res.end();
        return;
      }
      errJson(res, 404, 'Not Found');
      return;
    }
    // branches
    if (tail[0] === 'branches') {
      if (tail.length === 1 && method === 'GET') {
        const out: Record<string, unknown>[] = [];
        for (const ref of [...repo.refs.keys()].sort()) {
          if (!ref.startsWith('refs/heads/')) continue;
          out.push({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref) }, protected: false });
        }
        jsonBody(res, 200, out);
        return;
      }
      if (tail.length === 2 && method === 'GET') {
        const sha = repo.refs.get(`refs/heads/${tail[1]}`);
        if (!sha) {
          errJson(res, 404, 'Branch not found');
          return;
        }
        jsonBody(res, 200, { name: tail[1], commit: { sha, url: `/api/v3/repos/${owner}/${name}/commits/${sha}` }, protected: false });
        return;
      }
      errJson(res, 404, 'Not Found');
      return;
    }
    // commits
    if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
      const shaParam = query.get('sha');
      let tip: string | undefined;
      if (shaParam) {
        tip = repo.refs.get(`refs/heads/${shaParam}`) ?? (isOid(shaParam) ? shaParam : undefined);
      } else {
        tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      }
      if (!tip) {
        jsonBody(res, 200, []);
        return;
      }
      const list = listCommits(repo, tip).map(({ sha, commit }) => ({
        sha,
        node_id: gid('Commit', sha),
        commit: {
          message: commit.message,
          author: { name: VIEWER.login, email: 'adaiversen@users.noreply.github.com', date: nowIso() },
          committer: { name: VIEWER.login, email: 'adaiversen@users.noreply.github.com', date: nowIso() },
        },
        author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
        committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
        url: `/api/v3/repos/${owner}/${name}/commits/${sha}`,
      }));
      jsonBody(res, 200, list);
      return;
    }
    // git/refs
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const parsed = await readJson(req);
        if (!parsed.ok) {
          errJson(res, 400, parsed.error);
          return;
        }
        const body = (parsed.value ?? {}) as Record<string, unknown>;
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !isOid(sha)) {
          errJson(res, 422, 'Invalid ref or sha');
          return;
        }
        if (repo.refs.has(ref)) {
          errJson(res, 422, 'Reference already exists');
          return;
        }
        if (!repo.objects.has(sha)) {
          errJson(res, 422, 'Object does not exist');
          return;
        }
        repo.refs.set(ref, sha);
        repo.updatedAt = nowIso();
        jsonBody(res, 201, { ref, node_id: gid('Ref', `${repoKey(owner, name)}:${ref}`), object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' }, url: `/api/v3/repos/${owner}/${name}/git/refs/${ref}` });
        return;
      }
      if (method === 'GET' && tail.length >= 3) {
        const ref = tail.slice(2).join('/');
        const sha = repo.refs.get(ref);
        if (!sha) {
          errJson(res, 404, 'Reference not found');
          return;
        }
        jsonBody(res, 200, { ref, node_id: gid('Ref', `${repoKey(owner, name)}:${ref}`), object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' }, url: `/api/v3/repos/${owner}/${name}/git/refs/${ref}` });
        return;
      }
      errJson(res, 404, 'Not Found');
      return;
    }
    // contents
    if (tail[0] === 'contents') {
      const filePath = tail.slice(1).join('/');
      await handleContents(req, res, repo, filePath, query);
      return;
    }
    // labels
    if (tail[0] === 'labels') {
      if (method === 'POST' && tail.length === 1) {
        const parsed = await readJson(req);
        if (!parsed.ok) {
          errJson(res, 400, parsed.error);
          return;
        }
        const body = (parsed.value ?? {}) as Record<string, unknown>;
        const lname = typeof body.name === 'string' ? body.name : '';
        if (!lname) {
          errJson(res, 422, 'name is required');
          return;
        }
        const label: Label = {
          name: lname,
          color: typeof body.color === 'string' ? body.color : 'ededed',
          description: typeof body.description === 'string' ? body.description : '',
        };
        repo.labels.set(lname, label);
        jsonBody(res, 201, { id: lname.length * 1000 + repo.databaseId, node_id: gid('Label', `${repoKey(owner, name)}:${lname}`), name: label.name, color: label.color, description: label.description, default: false });
        return;
      }
      if (method === 'GET' && tail.length === 1) {
        jsonBody(res, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: l.description, default: false })));
        return;
      }
      errJson(res, 404, 'Not Found');
      return;
    }
    // issues
    if (tail[0] === 'issues') {
      await handleIssues(req, res, repo, tail.slice(1), query);
      return;
    }
    // pulls
    if (tail[0] === 'pulls') {
      await handlePulls(req, res, repo, tail.slice(1), query);
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }
  errJson(res, 404, 'Not Found');
}
function resolveBranchTip(repo: Repo, branch: string | undefined): string | undefined {
  if (!branch) return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return repo.refs.get(`refs/heads/${branch}`) ?? (isOid(branch) ? branch : undefined);
}
async function handleContents(req: IncomingMessage, res: ServerResponse, repo: Repo, filePath: string, query: URLSearchParams): Promise<void> {
  const method = req.method ?? 'GET';
  if (!filePath) {
    errJson(res, 404, 'Not Found');
    return;
  }
  const refParam = query.get('ref') ?? undefined;
  if (method === 'GET') {
    const tip = resolveBranchTip(repo, refParam);
    if (!tip) {
      errJson(res, 404, 'Not Found');
      return;
    }
    const tipObj = repo.objects.get(peelToCommit(repo, tip));
    if (!tipObj || tipObj.type !== 'commit') {
      errJson(res, 404, 'Not Found');
      return;
    }
    const paths = treeToPaths(repo, parseCommit(tipObj.data).tree);
    const blobOid = paths.get(filePath);
    if (blobOid !== undefined) {
      const blob = repo.objects.get(blobOid);
      if (!blob) {
        errJson(res, 404, 'Not Found');
        return;
      }
      const base = filePath.split('/').pop() ?? filePath;
      jsonBody(res, 200, {
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name: base,
        path: filePath,
        content: blob.data.toString('base64'),
        sha: blobOid,
      });
      return;
    }
    // directory?
    const prefix = `${filePath}/`;
    const entries: Record<string, unknown>[] = [];
    const seenDirs = new Set<string>();
    for (const p of [...paths.keys()].sort()) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        const oid = paths.get(p)!;
        entries.push({ type: 'file', name: rest, path: p, sha: oid, size: repo.objects.get(oid)?.data.length ?? 0 });
      } else {
        const dir = rest.slice(0, slash);
        if (!seenDirs.has(dir)) {
          seenDirs.add(dir);
          entries.push({ type: 'dir', name: dir, path: `${filePath}/${dir}`, sha: '' });
        }
      }
    }
    if (entries.length === 0) {
      errJson(res, 404, 'Not Found');
      return;
    }
    jsonBody(res, 200, entries);
    return;
  }
  if (method === 'PUT') {
    const parsed = await readJson(req);
    if (!parsed.ok) {
      errJson(res, 400, parsed.error);
      return;
    }
    const body = (parsed.value ?? {}) as Record<string, unknown>;
    const message = typeof body.message === 'string' ? body.message : 'update';
    const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    const contentB64 = typeof body.content === 'string' ? body.content : '';
    let content: Buffer;
    try {
      content = Buffer.from(contentB64, 'base64');
    } catch {
      errJson(res, 422, 'content is not valid base64');
      return;
    }
    const tip = repo.refs.get(`refs/heads/${branch}`);
    let paths = new Map<string, string>();
    let parent: string[] = [];
    if (tip) {
      const tipObj = repo.objects.get(peelToCommit(repo, tip));
      if (tipObj?.type === 'commit') {
        paths = treeToPaths(repo, parseCommit(tipObj.data).tree);
        parent = [peelToCommit(repo, tip)];
      }
    }
    const existing = paths.get(filePath);
    const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
    if (givenSha !== undefined) {
      if (existing === undefined || lower(existing) !== lower(givenSha)) {
        errJson(res, 409, 'sha does not match the current blob');
        return;
      }
    }
    const isCreate = existing === undefined;
    const blobOid = storeObject(repo, 'blob', content);
    paths.set(filePath, blobOid);
    const treeOid = pathsToTree(repo, paths);
    const commitOid = makeCommit(repo, treeOid, parent, message);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    repo.updatedAt = nowIso();
    const base = filePath.split('/').pop() ?? filePath;
    jsonBody(res, isCreate ? 201 : 200, {
      content: { name: base, path: filePath, sha: blobOid, size: content.length, type: 'file', encoding: 'base64' },
      commit: { sha: commitOid, message, node_id: gid('Commit', commitOid) },
    });
    return;
  }
  if (method === 'DELETE') {
    const parsed = await readJson(req);
    if (!parsed.ok) {
      errJson(res, 400, parsed.error);
      return;
    }
    const body = (parsed.value ?? {}) as Record<string, unknown>;
    const message = typeof body.message === 'string' ? body.message : 'delete';
    const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (!tip) {
      errJson(res, 404, 'Not Found');
      return;
    }
    const tipObj = repo.objects.get(peelToCommit(repo, tip));
    if (!tipObj || tipObj.type !== 'commit') {
      errJson(res, 404, 'Not Found');
      return;
    }
    const paths = treeToPaths(repo, parseCommit(tipObj.data).tree);
    const existing = paths.get(filePath);
    if (existing === undefined) {
      errJson(res, 404, 'Not Found');
      return;
    }
    const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
    if (givenSha !== undefined && lower(existing) !== lower(givenSha)) {
      errJson(res, 409, 'sha does not match the current blob');
      return;
    }
    paths.delete(filePath);
    const treeOid = pathsToTree(repo, paths);
    const commitOid = makeCommit(repo, treeOid, [peelToCommit(repo, tip)], message);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    repo.updatedAt = nowIso();
    jsonBody(res, 200, { commit: { sha: commitOid, message, node_id: gid('Commit', commitOid) } });
    return;
  }
  errJson(res, 404, 'Not Found');
}
function labelNamesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v === 'string') out.push(v);
    else if (v !== null && typeof v === 'object' && typeof (v as Record<string, unknown>).name === 'string') {
      out.push((v as Record<string, unknown>).name as string);
    }
  }
  return out;
}
async function handleIssues(req: IncomingMessage, res: ServerResponse, repo: Repo, tail: string[], query: URLSearchParams): Promise<void> {
  const method = req.method ?? 'GET';
  if (tail.length === 0) {
    if (method === 'POST') {
      const parsed = await readJson(req);
      if (!parsed.ok) {
        errJson(res, 400, parsed.error);
        return;
      }
      const body = (parsed.value ?? {}) as Record<string, unknown>;
      const title = typeof body.title === 'string' ? body.title : '';
      if (!title) {
        errJson(res, 422, 'title is required');
        return;
      }
      const labels = labelNamesOf(body.labels);
      for (const l of labels) {
        if (!repo.labels.has(l)) {
          errJson(res, 422, `Label does not exist: ${l}`);
          return;
        }
      }
      const number = repo.nextIssue++;
      const issue: Issue = {
        id: gid('Issue', `${repoKey(repo.owner, repo.name)}#${number}`),
        number,
        title,
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open',
        labels,
        comments: [],
        createdAt: nowIso(),
        updatedAt: nowIso(),
        seq: seqCounter++,
      };
      repo.issues.push(issue);
      jsonBody(res, 201, issueJson(repo, issue));
      return;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let list = repo.issues.filter((i) => (state === 'all' ? true : i.state === state));
      if (sort === 'created') {
        list = [...list].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      }
      jsonBody(res, 200, list.map((i) => issueJson(repo, i)));
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }
  const number = parseInt(tail[0]!, 10);
  if (!Number.isFinite(number)) {
    errJson(res, 404, 'Not Found');
    return;
  }
  const issue = repo.issues.find((i) => i.number === number);
  if (!issue) {
    errJson(res, 404, 'Not Found');
    return;
  }
  if (tail.length === 1) {
    if (method === 'GET') {
      jsonBody(res, 200, issueJson(repo, issue));
      return;
    }
    if (method === 'PATCH') {
      const parsed = await readJson(req);
      if (!parsed.ok) {
        errJson(res, 400, parsed.error);
        return;
      }
      const body = (parsed.value ?? {}) as Record<string, unknown>;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.labels !== undefined) {
        const labels = labelNamesOf(body.labels);
        for (const l of labels) {
          if (!repo.labels.has(l)) {
            errJson(res, 422, `Label does not exist: ${l}`);
            return;
          }
        }
        issue.labels = labels;
      }
      issue.updatedAt = nowIso();
      jsonBody(res, 200, issueJson(repo, issue));
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }
  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'POST') {
      const parsed = await readJson(req);
      if (!parsed.ok) {
        errJson(res, 400, parsed.error);
        return;
      }
      const body = (parsed.value ?? {}) as Record<string, unknown>;
      const commentBody = typeof body.body === 'string' ? body.body : '';
      const comment: IssueComment = {
        id: repo.nextCommentId++,
        body: commentBody,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      issue.comments.push(comment);
      issue.updatedAt = nowIso();
      jsonBody(res, 201, {
        id: comment.id,
        node_id: gid('IssueComment', `${repoKey(repo.owner, repo.name)}#${issue.number}:${comment.id}`),
        body: comment.body,
        created_at: comment.createdAt,
        updated_at: comment.updatedAt,
        user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
        url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
      });
      return;
    }
    if (method === 'GET') {
      jsonBody(res, 200, issue.comments.map((c) => ({
        id: c.id,
        node_id: gid('IssueComment', `${repoKey(repo.owner, repo.name)}#${issue.number}:${c.id}`),
        body: c.body,
        created_at: c.createdAt,
        updated_at: c.updatedAt,
        user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
      })));
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }
  errJson(res, 404, 'Not Found');
}
async function handlePulls(req: IncomingMessage, res: ServerResponse, repo: Repo, tail: string[], query: URLSearchParams): Promise<void> {
  const method = req.method ?? 'GET';
  if (tail.length === 0) {
    if (method === 'POST') {
      const parsed = await readJson(req);
      if (!parsed.ok) {
        errJson(res, 400, parsed.error);
        return;
      }
      const body = (parsed.value ?? {}) as Record<string, unknown>;
      const title = typeof body.title === 'string' ? body.title : '';
      const head = typeof body.head === 'string' ? body.head : '';
      const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
      if (!title || !head) {
        errJson(res, 422, 'title and head are required');
        return;
      }
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) {
        errJson(res, 422, 'head or base branch does not exist');
        return;
      }
      const dup = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
      if (dup) {
        errJson(res, 422, 'A pull request already exists for this head branch');
        return;
      }
      const number = repo.nextPull++;
      const pull: Pull = {
        id: gid('PullRequest', `${repoKey(repo.owner, repo.name)}#${number}`),
        number,
        title,
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open',
        merged: false,
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        mergeCommitSha: null,
        mergedAt: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        seq: seqCounter++,
      };
      repo.pulls.push(pull);
      jsonBody(res, 201, pullJson(repo, pull));
      return;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const list = repo.pulls.filter((p) => (state === 'all' ? true : p.state === state));
      jsonBody(res, 200, list.map((p) => pullJson(repo, p)));
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }
  const number = parseInt(tail[0]!, 10);
  if (!Number.isFinite(number)) {
    errJson(res, 404, 'Not Found');
    return;
  }
  const pull = repo.pulls.find((p) => p.number === number);
  if (!pull) {
    errJson(res, 404, 'Not Found');
    return;
  }
  if (tail.length === 1 && method === 'GET') {
    jsonBody(res, 200, pullJson(repo, pull));
    return;
  }
  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    jsonBody(res, 200, pullFiles(repo, pull));
    return;
  }
  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    if (pull.merged) {
      errJson(res, 409, 'Pull request already merged');
      return;
    }
    const mergeable = computeMergeable(repo, pull);
    if (mergeable === 'CONFLICTING') {
      errJson(res, 405, 'Pull request has merge conflicts');
      return;
    }
    if (mergeable === 'UNKNOWN') {
      errJson(res, 405, 'Pull request cannot be merged');
      return;
    }
    const headSha = currentTip(repo, pull.headRef, pull.headSha);
    const baseSha = currentTip(repo, pull.baseRef, pull.baseSha);
    const headCommit = repo.objects.get(peelToCommit(repo, headSha));
    const baseCommit = repo.objects.get(peelToCommit(repo, baseSha));
    if (!headCommit || !baseCommit || headCommit.type !== 'commit' || baseCommit.type !== 'commit') {
      errJson(res, 405, 'Pull request cannot be merged');
      return;
    }
    const mb = mergeBase(repo, headSha, baseSha);
    const mbTree = mb !== null ? parseCommit((repo.objects.get(mb) as GitObject).data).tree : parseCommit(baseCommit.data).tree;
    const { tree } = mergeTrees(repo, mbTree, parseCommit(headCommit.data).tree, parseCommit(baseCommit.data).tree);
    const treeOid = pathsToTree(repo, tree);
    const message = pull.title;
    const commitOid = makeCommit(repo, treeOid, [peelToCommit(repo, baseSha)], message);
    repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
    repo.updatedAt = nowIso();
    pull.merged = true;
    pull.state = 'closed';
    pull.mergeCommitSha = commitOid;
    pull.mergedAt = nowIso();
    pull.updatedAt = nowIso();
    jsonBody(res, 200, { sha: commitOid, merged: true, message });
    return;
  }
  errJson(res, 404, 'Not Found');
}

// -------------------------------------------------------------------------------------------
// GraphQL v4 (mini parser + executor for the documents gh / github-mcp-server send)
// -------------------------------------------------------------------------------------------
type GqlValueNode =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; values: GqlValueNode[] }
  | { kind: 'object'; fields: { name: string; value: GqlValueNode }[] };
interface GqlField {
  kind: 'field';
  name: string;
  alias: string | null;
  args: { name: string; value: GqlValueNode }[];
  directives: { name: string; args: { name: string; value: GqlValueNode }[] }[];
  selectionSet: GqlSelection[] | null;
}
type GqlSelection =
  | GqlField
  | { kind: 'spread'; name: string; directives: { name: string; args: { name: string; value: GqlValueNode }[] }[] }
  | { kind: 'inline'; typeCondition: string | null; directives: { name: string; args: { name: string; value: GqlValueNode }[] }[]; selectionSet: GqlSelection[] };
interface GqlOperation {
  kind: 'operation';
  operation: 'query' | 'mutation';
  name: string | null;
  variables: { name: string; type: string; defaultValue: GqlValueNode | null }[];
  selectionSet: GqlSelection[];
}
interface GqlFragment {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selectionSet: GqlSelection[];
}
class GqlParseError extends Error {}
class GqlExecError extends Error {}
function lexGql(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c) || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(c)) {
      tokens.push(c);
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') {
          const e = src[j + 1];
          if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === 'r') out += '\r';
          else if (e === '"') out += '"';
          else if (e === '\\') out += '\\';
          else if (e === '/') out += '/';
          else if (e === 'u') {
            out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += e ?? '';
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j]!)) j += 1;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j += 1;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    throw new GqlParseError(`unexpected character ${JSON.stringify(c)}`);
  }
  return tokens;
}
class GqlParser {
  private pos = 0;
  private readonly tokens: string[];
  constructor(tokens: string[]) {
    this.tokens = tokens;
  }
  private peek(): string | undefined {
    return this.tokens[this.pos];
  }
  private next(): string {
    const t = this.tokens[this.pos++];
    if (t === undefined) throw new GqlParseError('unexpected end of document');
    return t;
  }
  private expect(t: string): void {
    const got = this.next();
    if (got !== t) throw new GqlParseError(`expected ${t}, got ${got}`);
  }
  parseDocument(): (GqlOperation | GqlFragment)[] {
    const defs: (GqlOperation | GqlFragment)[] = [];
    while (this.pos < this.tokens.length) defs.push(this.parseDefinition());
    return defs;
  }
  private parseDefinition(): GqlOperation | GqlFragment {
    const t = this.peek();
    if (t === 'query' || t === 'mutation') {
      const operation = this.next() as 'query' | 'mutation';
      let name: string | null = null;
      if (this.peek() !== undefined && this.peek() !== '(' && this.peek() !== '{') name = this.next();
      const variables = this.peek() === '(' ? this.parseVariableDefinitions() : [];
      return { kind: 'operation', operation, name, variables, selectionSet: this.parseSelectionSet() };
    }
    if (t === '{') return { kind: 'operation', operation: 'query', name: null, variables: [], selectionSet: this.parseSelectionSet() };
    if (t === 'fragment') {
      this.next();
      const name = this.next();
      this.expect('on');
      const typeCondition = this.next();
      return { kind: 'fragment', name, typeCondition, selectionSet: this.parseSelectionSet() };
    }
    throw new GqlParseError(`unexpected definition ${t}`);
  }
  private parseVariableDefinitions(): { name: string; type: string; defaultValue: GqlValueNode | null }[] {
    this.expect('(');
    const out: { name: string; type: string; defaultValue: GqlValueNode | null }[] = [];
    while (this.peek() !== ')') {
      this.expect('$');
      const name = this.next();
      this.expect(':');
      const type = this.parseType();
      let defaultValue: GqlValueNode | null = null;
      if (this.peek() === '=') {
        this.next();
        defaultValue = this.parseValue();
      }
      out.push({ name, type, defaultValue });
    }
    this.expect(')');
    return out;
  }
  private parseType(): string {
    let t: string;
    if (this.peek() === '[') {
      this.next();
      t = `[${this.parseType()}]`;
    } else {
      t = this.next();
    }
    if (this.peek() === '!') {
      this.next();
      t += '!';
    }
    return t;
  }
  private parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const sels: GqlSelection[] = [];
    while (this.peek() !== '}') sels.push(this.parseSelection());
    this.expect('}');
    return sels;
  }
  private parseSelection(): GqlSelection {
    if (this.peek() === '...') {
      this.next();
      const name = this.peek();
      if (name === 'on') {
        this.next();
        const typeCondition = this.next();
        const directives = this.parseDirectives();
        return { kind: 'inline', typeCondition, directives, selectionSet: this.parseSelectionSet() };
      }
      const fragName = this.next();
      const directives = this.parseDirectives();
      return { kind: 'spread', name: fragName, directives };
    }
    let name = this.next();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args = this.peek() === '(' ? this.parseArguments() : [];
    const directives = this.parseDirectives();
    const selectionSet = this.peek() === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', name, alias, args, directives, selectionSet };
  }
  private parseArguments(): { name: string; value: GqlValueNode }[] {
    this.expect('(');
    const out: { name: string; value: GqlValueNode }[] = [];
    while (this.peek() !== ')') {
      const name = this.next();
      this.expect(':');
      out.push({ name, value: this.parseValue() });
    }
    this.expect(')');
    return out;
  }
  private parseDirectives(): { name: string; args: { name: string; value: GqlValueNode }[] }[] {
    const out: { name: string; args: { name: string; value: GqlValueNode }[] }[] = [];
    while (this.peek() === '@') {
      this.next();
      const name = this.next();
      const args = this.peek() === '(' ? this.parseArguments() : [];
      out.push({ name, args });
    }
    return out;
  }
  private parseValue(): GqlValueNode {
    const t = this.next();
    if (t === '$') return { kind: 'variable', name: this.next() };
    if (t === '[') {
      const values: GqlValueNode[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (t === '{') {
      const fields: { name: string; value: GqlValueNode }[] = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (t === 'true') return { kind: 'boolean', value: true };
    if (t === 'false') return { kind: 'boolean', value: false };
    if (t === 'null') return { kind: 'null' };
    if (t.startsWith('"')) return { kind: 'string', value: JSON.parse(t) as string };
    if (/^-?[0-9]+$/.test(t)) return { kind: 'int', value: parseInt(t, 10) };
    if (/^-?[0-9]*\.[0-9]+([eE][+-]?[0-9]+)?$/.test(t)) return { kind: 'float', value: parseFloat(t) };
    return { kind: 'enum', value: t };
  }
}
function resolveGqlValue(node: GqlValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'variable':
      return variables[node.name] ?? null;
    case 'list':
      return node.values.map((v) => resolveGqlValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveGqlValue(f.value, variables);
      return out;
    }
  }
}
function argsOf(field: GqlField, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = resolveGqlValue(a.value, variables);
  return out;
}
function directiveSkip(directives: { name: string; args: { name: string; value: GqlValueNode }[] }[], variables: Record<string, unknown>): boolean {
  for (const d of directives) {
    const ifArg = d.args.find((a) => a.name === 'if');
    const val = ifArg ? (resolveGqlValue(ifArg.value, variables) as boolean) : false;
    if (d.name === 'skip' && val === true) return true;
    if (d.name === 'include' && val === false) return true;
  }
  return false;
}
// --- schema (for __type introspection) ---
interface SchemaFieldDef {
  type: string;
}
interface SchemaTypeDef {
  kind: 'OBJECT' | 'ENUM' | 'SCALAR';
  fields?: Record<string, SchemaFieldDef>;
  enumValues?: string[];
}
const SCHEMA_TYPES: Record<string, SchemaTypeDef> = {
  Query: {
    kind: 'OBJECT',
    fields: {
      viewer: { type: 'User' },
      repository: { type: 'Repository' },
      node: { type: 'Node' },
      __type: { type: '__Type' },
      __schema: { type: '__Schema' },
    },
  },
  Mutation: {
    kind: 'OBJECT',
    fields: {
      createIssue: { type: 'CreateIssuePayload' },
      closeIssue: { type: 'CloseIssuePayload' },
      createPullRequest: { type: 'CreatePullRequestPayload' },
      mergePullRequest: { type: 'MergePullRequestPayload' },
      addComment: { type: 'AddCommentPayload' },
    },
  },
  Repository: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      databaseId: { type: 'Int' },
      name: { type: 'String!' },
      nameWithOwner: { type: 'String!' },
      owner: { type: 'User!' },
      defaultBranchRef: { type: 'Ref' },
      viewerPermission: { type: 'RepositoryPermission' },
      hasIssuesEnabled: { type: 'Boolean!' },
      issue: { type: 'Issue' },
      issues: { type: 'IssueConnection!' },
      pullRequests: { type: 'PullRequestConnection!' },
      pullRequest: { type: 'PullRequest' },
    },
  },
  Issue: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      number: { type: 'Int!' },
      title: { type: 'String!' },
      state: { type: 'IssueState!' },
      body: { type: 'String!' },
    },
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      number: { type: 'Int!' },
      state: { type: 'PullRequestState!' },
      merged: { type: 'Boolean!' },
      headRefName: { type: 'String!' },
      baseRefName: { type: 'String!' },
      mergeable: { type: 'MergeableState!' },
      files: { type: 'PullRequestChangedFileConnection' },
    },
  },
  User: { kind: 'OBJECT', fields: { id: { type: 'ID!' }, login: { type: 'String!' } } },
  Ref: { kind: 'OBJECT', fields: { name: { type: 'String!' } } },
  IssueConnection: {
    kind: 'OBJECT',
    fields: { nodes: { type: '[Issue]' }, pageInfo: { type: 'PageInfo!' }, totalCount: { type: 'Int!' } },
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: { nodes: { type: '[PullRequest]' }, pageInfo: { type: 'PageInfo!' }, totalCount: { type: 'Int!' } },
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: {
      hasNextPage: { type: 'Boolean!' },
      hasPreviousPage: { type: 'Boolean!' },
      startCursor: { type: 'String' },
      endCursor: { type: 'String' },
    },
  },
  IssueComment: { kind: 'OBJECT', fields: { id: { type: 'ID!' }, body: { type: 'String!' } } },
  IssueCommentEdge: { kind: 'OBJECT', fields: { node: { type: 'IssueComment' } } },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: { nodes: { type: '[PullRequestChangedFile]' } } },
  PullRequestChangedFile: { kind: 'OBJECT', fields: { path: { type: 'String!' } } },
  CreateIssuePayload: { kind: 'OBJECT', fields: { issue: { type: 'Issue' } } },
  CloseIssuePayload: { kind: 'OBJECT', fields: { issue: { type: 'Issue' } } },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: { pullRequest: { type: 'PullRequest' } } },
  MergePullRequestPayload: { kind: 'OBJECT', fields: { pullRequest: { type: 'PullRequest' } } },
  AddCommentPayload: { kind: 'OBJECT', fields: { commentEdge: { type: 'IssueCommentEdge' } } },
  __Type: {
    kind: 'OBJECT',
    fields: { name: { type: 'String' }, kind: { type: 'String' }, fields: { type: '[__Field]' }, enumValues: { type: '[__EnumValue]' } },
  },
  __Field: { kind: 'OBJECT', fields: { name: { type: 'String' }, type: { type: '__Type' } } },
  __EnumValue: { kind: 'OBJECT', fields: { name: { type: 'String' } } },
  __Schema: { kind: 'OBJECT', fields: { types: { type: '[__Type]' } } },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
};
function typeRefOf(typeStr: string): Record<string, unknown> {
  if (typeStr.endsWith('!')) return { kind: 'NON_NULL', name: null, ofType: typeRefOf(typeStr.slice(0, -1)) };
  if (typeStr.startsWith('[') && typeStr.endsWith(']')) return { kind: 'LIST', name: null, ofType: typeRefOf(typeStr.slice(1, -1)) };
  const def = SCHEMA_TYPES[typeStr];
  return { kind: def?.kind ?? 'OBJECT', name: typeStr, ofType: null };
}
function typeObject(name: string): Record<string, unknown> & { __typename: string } {
  const def = SCHEMA_TYPES[name];
  return {
    __typename: '__Type',
    __typeName: name,
    name,
    kind: def?.kind ?? 'OBJECT',
    fields: def?.fields
      ? Object.entries(def.fields).map(([fname, fdef]) => ({
          __typename: '__Field',
          name: fname,
          type: { __typename: '__Type', ...typeRefOf(fdef.type) },
        }))
      : null,
    enumValues: def?.enumValues ? def.enumValues.map((v) => ({ __typename: '__EnumValue', name: v })) : null,
  };
}
// --- runtime objects ---
interface GqlObj {
  __typename: string;
  [key: string]: unknown;
}
function repoObj(repo: Repo): GqlObj {
  return { __typename: 'Repository', __repo: repo };
}
function issueObj(repo: Repo, issue: Issue): GqlObj {
  return { __typename: 'Issue', __repo: repo, __issue: issue };
}
function pullObj(repo: Repo, pull: Pull): GqlObj {
  return { __typename: 'PullRequest', __repo: repo, __pull: pull };
}
function userObj(login: string, id: number): GqlObj {
  return { __typename: 'User', login, id: id };
}
function findByGlobalId(id: string): GqlObj | null {
  let decoded: string;
  try {
    decoded = unb64(id);
  } catch {
    return null;
  }
  const m = /^(Repository|Issue|PullRequest|IssueComment):(.+)$/.exec(decoded);
  if (!m) return null;
  const kind = m[1]!;
  const key = m[2]!;
  if (kind === 'Repository') {
    const [owner, name] = key.split('/');
    const repo = owner && name ? findRepo(owner, name) : undefined;
    return repo ? repoObj(repo) : null;
  }
  const hm = /^([^/]+)\/([^#]+)#(\d+)(?::(\d+))?$/.exec(key);
  if (!hm) return null;
  const repo = findRepo(hm[1]!, hm[2]!);
  if (!repo) return null;
  const num = parseInt(hm[3]!, 10);
  if (kind === 'Issue') {
    const issue = repo.issues.find((i) => i.number === num);
    return issue ? issueObj(repo, issue) : null;
  }
  if (kind === 'PullRequest') {
    const pull = repo.pulls.find((p) => p.number === num);
    return pull ? pullObj(repo, pull) : null;
  }
  return null;
}
function connectionOf<T>(items: T[], first: number | undefined, after: string | undefined, typename: string): GqlObj {
  let list = items;
  if (after) {
    try {
      const decoded = unb64(after);
      const idx = list.findIndex((it) => {
        const o = it as unknown as GqlObj;
        return String(o.__cursor ?? '') === decoded;
      });
      if (idx >= 0) list = list.slice(idx + 1);
    } catch {
      // ignore bad cursor
    }
  }
  const total = list.length;
  const take = first === undefined ? list.length : Math.max(0, first);
  const page = list.slice(0, take);
  const hasNextPage = total > take;
  const endCursor = page.length ? b64(String((page[page.length - 1] as unknown as GqlObj).__cursor ?? '')) : null;
  const startCursor = page.length ? b64(String((page[0] as unknown as GqlObj).__cursor ?? '')) : null;
  return {
    __typename: typename,
    nodes: page,
    totalCount: total,
    pageInfo: { __typename: 'PageInfo', hasNextPage, hasPreviousPage: false, startCursor, endCursor },
  };
}

// --- field resolution ---
function resolveField(obj: GqlObj, field: GqlField, variables: Record<string, unknown>): unknown {
  const typename = obj.__typename;
  const args = argsOf(field, variables);
  const name = field.name;
  if (name === '__typename') return typename;
  switch (typename) {
    case 'Query': {
      if (name === 'viewer') return userObj(VIEWER.login, VIEWER.id);
      if (name === 'repository') {
        const owner = String(args.owner ?? '');
        const repoName = String(args.name ?? '');
        const repo = findRepo(owner, repoName);
        return repo ? repoObj(repo) : null;
      }
      if (name === 'node') return findByGlobalId(String(args.id ?? ''));
      if (name === '__type') {
        const tname = String(args.name ?? '');
        if (!SCHEMA_TYPES[tname]) return null;
        return typeObject(tname);
      }
      if (name === '__schema') {
        return {
          __typename: '__Schema',
          types: Object.keys(SCHEMA_TYPES).map((t) => typeObject(t)),
        };
      }
      break;
    }
    case 'Repository': {
      const repo = obj.__repo as Repo;
      if (name === 'id') return gid('Repository', repoKey(repo.owner, repo.name));
      if (name === 'databaseId') return repo.databaseId;
      if (name === 'name') return repo.name;
      if (name === 'nameWithOwner') return repoKey(repo.owner, repo.name);
      if (name === 'owner') return userObj(repo.owner, repo.owner === VIEWER.login ? VIEWER.id : STRANGER.id);
      if (name === 'defaultBranchRef') return { __typename: 'Ref', name: repo.defaultBranch };
      if (name === 'viewerPermission') return 'ADMIN';
      if (name === 'hasIssuesEnabled') return true;
      if (name === 'issue') {
        const issue = repo.issues.find((i) => i.number === Number(args.number));
        return issue ? issueObj(repo, issue) : null;
      }
      if (name === 'issues') {
        let list = [...repo.issues];
        const states = args.states as string[] | undefined;
        if (states && states.length) list = list.filter((i) => states.includes(i.state === 'open' ? 'OPEN' : 'CLOSED'));
        const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
        const direction = String(orderBy.direction ?? 'DESC');
        list.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
        const nodes = list.map((i) => ({ ...issueObj(repo, i), __cursor: `issue:${i.seq}` }));
        return connectionOf(nodes, args.first as number | undefined, args.after as string | undefined, 'IssueConnection');
      }
      if (name === 'pullRequests') {
        const list = [...repo.pulls].sort((a, b) => b.seq - a.seq);
        const nodes = list.map((p) => ({ ...pullObj(repo, p), __cursor: `pull:${p.seq}` }));
        return connectionOf(nodes, args.first as number | undefined, args.after as string | undefined, 'PullRequestConnection');
      }
      if (name === 'pullRequest') {
        const pull = repo.pulls.find((p) => p.number === Number(args.number));
        return pull ? pullObj(repo, pull) : null;
      }
      break;
    }
    case 'Issue': {
      const issue = obj.__issue as Issue;
      if (name === 'id') return issue.id;
      if (name === 'number') return issue.number;
      if (name === 'title') return issue.title;
      if (name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      if (name === 'body') return issue.body;
      break;
    }
    case 'PullRequest': {
      const repo = obj.__repo as Repo;
      const pull = obj.__pull as Pull;
      if (name === 'id') return pull.id;
      if (name === 'number') return pull.number;
      if (name === 'state') return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      if (name === 'merged') return pull.merged;
      if (name === 'headRefName') return pull.headRef;
      if (name === 'baseRefName') return pull.baseRef;
      if (name === 'mergeable') return computeMergeable(repo, pull);
      if (name === 'files') {
        const files = pullFiles(repo, pull).map((f) => ({ __typename: 'PullRequestChangedFile', path: String(f.filename) }));
        const first = args.first as number | undefined;
        const nodes = first === undefined ? files : files.slice(0, first);
        return { __typename: 'PullRequestChangedFileConnection', nodes };
      }
      break;
    }
    case 'User': {
      if (name === 'login') return obj.login;
      if (name === 'id') return gid('User', String(obj.login));
      break;
    }
    case 'Ref': {
      if (name === 'name') return obj.name;
      break;
    }
    case 'IssueConnection':
    case 'PullRequestConnection': {
      if (name === 'nodes') return obj.nodes;
      if (name === 'pageInfo') return obj.pageInfo;
      if (name === 'totalCount') return obj.totalCount;
      break;
    }
    case 'PageInfo': {
      if (name === 'hasNextPage') return obj.hasNextPage;
      if (name === 'hasPreviousPage') return obj.hasPreviousPage;
      if (name === 'startCursor') return obj.startCursor;
      if (name === 'endCursor') return obj.endCursor;
      break;
    }
    case 'IssueComment': {
      if (name === 'id') return obj.id;
      if (name === 'body') return obj.body;
      break;
    }
    case 'IssueCommentEdge': {
      if (name === 'node') return obj.node;
      break;
    }
    case 'PullRequestChangedFileConnection': {
      if (name === 'nodes') return obj.nodes;
      break;
    }
    case 'PullRequestChangedFile': {
      if (name === 'path') return obj.path;
      break;
    }
    case '__Type': {
      if (name === 'name') return obj.name;
      if (name === 'kind') return obj.kind;
      if (name === 'fields') return (obj.fields as unknown[]) ?? null;
      if (name === 'enumValues') return (obj.enumValues as unknown[]) ?? null;
      if (name === 'description') return null;
      break;
    }
    case '__Field': {
      if (name === 'name') return obj.name;
      if (name === 'type') return obj.type;
      if (name === 'description') return null;
      break;
    }
    case '__EnumValue': {
      if (name === 'name') return obj.name;
      if (name === 'description') return null;
      break;
    }
    case '__Schema': {
      if (name === 'types') return obj.types;
      break;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
    case 'AddCommentPayload': {
      if (name === 'issue') return obj.issue ?? null;
      if (name === 'pullRequest') return obj.pullRequest ?? null;
      if (name === 'commentEdge') return obj.commentEdge ?? null;
      break;
    }
  }
  throw new GqlExecError(`Cannot query field "${name}" on type "${typename}".`);
}
function executeSelectionSet(
  obj: GqlObj,
  sels: GqlSelection[],
  fragments: Map<string, GqlFragment>,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of sels) {
    if (sel.kind === 'field') {
      if (directiveSkip(sel.directives, variables)) continue;
      const value = resolveField(obj, sel, variables);
      const key = sel.alias ?? sel.name;
      if (sel.selectionSet === null) {
        out[key] = value;
      } else if (value === null || value === undefined) {
        out[key] = null;
      } else if (Array.isArray(value)) {
        out[key] = value.map((item) => executeSelectionSet(item as GqlObj, sel.selectionSet!, fragments, variables));
      } else if (typeof value === 'object') {
        out[key] = executeSelectionSet(value as GqlObj, sel.selectionSet, fragments, variables);
      } else {
        out[key] = value;
      }
    } else if (sel.kind === 'spread') {
      if (directiveSkip(sel.directives, variables)) continue;
      const frag = fragments.get(sel.name);
      if (!frag) throw new GqlExecError(`Unknown fragment "${sel.name}".`);
      if (frag.typeCondition && frag.typeCondition !== obj.__typename) continue;
      Object.assign(out, executeSelectionSet(obj, frag.selectionSet, fragments, variables));
    } else if (sel.kind === 'inline') {
      if (directiveSkip(sel.directives, variables)) continue;
      if (sel.typeCondition && sel.typeCondition !== obj.__typename) continue;
      Object.assign(out, executeSelectionSet(obj, sel.selectionSet, fragments, variables));
    }
  }
  return out;
}
function executeMutation(op: GqlOperation, fragments: Map<string, GqlFragment>, variables: Record<string, unknown>): Record<string, unknown> {
  const root: GqlObj = { __typename: 'Mutation' };
  const out: Record<string, unknown> = {};
  for (const sel of op.selectionSet) {
    if (sel.kind !== 'field') throw new GqlExecError('mutation root must be fields');
    if (directiveSkip(sel.directives, variables)) continue;
    const args = argsOf(sel, variables);
    const input = (args.input ?? {}) as Record<string, unknown>;
    const key = sel.alias ?? sel.name;
    let payload: GqlObj;
    if (sel.name === 'createIssue') {
      const repoObj2 = findByGlobalId(String(input.repositoryId ?? ''));
      if (!repoObj2 || repoObj2.__typename !== 'Repository') throw new GqlExecError('repositoryId does not identify a repository');
      const repo = repoObj2.__repo as Repo;
      const number = repo.nextIssue++;
      const issue: Issue = {
        id: gid('Issue', `${repoKey(repo.owner, repo.name)}#${number}`),
        number,
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        comments: [],
        createdAt: nowIso(),
        updatedAt: nowIso(),
        seq: seqCounter++,
      };
      repo.issues.push(issue);
      payload = { __typename: 'CreateIssuePayload', issue: issueObj(repo, issue) };
    } else if (sel.name === 'closeIssue') {
      const found = findByGlobalId(String(input.issueId ?? ''));
      if (!found || found.__typename !== 'Issue') throw new GqlExecError('issueId does not identify an issue');
      const issue = found.__issue as Issue;
      issue.state = 'closed';
      issue.updatedAt = nowIso();
      payload = { __typename: 'CloseIssuePayload', issue: found };
    } else if (sel.name === 'createPullRequest') {
      const repoObj2 = findByGlobalId(String(input.repositoryId ?? ''));
      if (!repoObj2 || repoObj2.__typename !== 'Repository') throw new GqlExecError('repositoryId does not identify a repository');
      const repo = repoObj2.__repo as Repo;
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) throw new GqlExecError('head or base branch does not exist');
      const dup = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
      if (dup) throw new GqlExecError('A pull request already exists for this head branch');
      const number = repo.nextPull++;
      const pull: Pull = {
        id: gid('PullRequest', `${repoKey(repo.owner, repo.name)}#${number}`),
        number,
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        merged: false,
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        mergeCommitSha: null,
        mergedAt: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        seq: seqCounter++,
      };
      repo.pulls.push(pull);
      payload = { __typename: 'CreatePullRequestPayload', pullRequest: pullObj(repo, pull) };
    } else if (sel.name === 'mergePullRequest') {
      const found = findByGlobalId(String(input.pullRequestId ?? ''));
      if (!found || found.__typename !== 'PullRequest') throw new GqlExecError('pullRequestId does not identify a pull request');
      const repo = found.__repo as Repo;
      const pull = found.__pull as Pull;
      if (pull.merged) throw new GqlExecError('Pull request already merged');
      const mergeable = computeMergeable(repo, pull);
      if (mergeable !== 'MERGEABLE') throw new GqlExecError('Pull request cannot be merged');
      const headSha = currentTip(repo, pull.headRef, pull.headSha);
      const baseSha = currentTip(repo, pull.baseRef, pull.baseSha);
      const headCommit = repo.objects.get(peelToCommit(repo, headSha));
      const baseCommit = repo.objects.get(peelToCommit(repo, baseSha));
      if (!headCommit || !baseCommit || headCommit.type !== 'commit' || baseCommit.type !== 'commit') {
        throw new GqlExecError('Pull request cannot be merged');
      }
      const mb = mergeBase(repo, headSha, baseSha);
      const mbTree = mb !== null ? parseCommit((repo.objects.get(mb) as GitObject).data).tree : parseCommit(baseCommit.data).tree;
      const { tree } = mergeTrees(repo, mbTree, parseCommit(headCommit.data).tree, parseCommit(baseCommit.data).tree);
      const treeOid = pathsToTree(repo, tree);
      const commitOid = makeCommit(repo, treeOid, [peelToCommit(repo, baseSha)], pull.title);
      repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
      repo.updatedAt = nowIso();
      pull.merged = true;
      pull.state = 'closed';
      pull.mergeCommitSha = commitOid;
      pull.mergedAt = nowIso();
      pull.updatedAt = nowIso();
      payload = { __typename: 'MergePullRequestPayload', pullRequest: found };
    } else if (sel.name === 'addComment') {
      const found = findByGlobalId(String(input.subjectId ?? ''));
      if (!found || found.__typename !== 'Issue') throw new GqlExecError('subjectId does not identify an issue');
      const repo = found.__repo as Repo;
      const issue = found.__issue as Issue;
      const comment: IssueComment = {
        id: repo.nextCommentId++,
        body: String(input.body ?? ''),
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      issue.comments.push(comment);
      issue.updatedAt = nowIso();
      payload = {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: {
            __typename: 'IssueComment',
            id: gid('IssueComment', `${repoKey(repo.owner, repo.name)}#${issue.number}:${comment.id}`),
            body: comment.body,
          },
        },
      };
    } else {
      throw new GqlExecError(`Cannot query field "${sel.name}" on type "Mutation".`);
    }
    if (sel.selectionSet === null) {
      out[key] = payload;
    } else {
      out[key] = executeSelectionSet(payload, sel.selectionSet, fragments, variables);
    }
  }
  return out;
}
function executeGraphQL(query: string, variables: Record<string, unknown>, operationName: string | undefined): { data: unknown; errors?: { message: string }[] } {
  let defs: (GqlOperation | GqlFragment)[];
  try {
    defs = new GqlParser(lexGql(query)).parseDocument();
  } catch (e) {
    return { data: null, errors: [{ message: e instanceof Error ? e.message : String(e) }] };
  }
  const fragments = new Map<string, GqlFragment>();
  const operations: GqlOperation[] = [];
  for (const d of defs) {
    if (d.kind === 'fragment') fragments.set(d.name, d);
    else operations.push(d);
  }
  let op = operations[0];
  if (operationName) op = operations.find((o) => o.name === operationName) ?? operations[0]!;
  if (!op) return { data: null, errors: [{ message: 'no operation found' }] };
  const vars: Record<string, unknown> = { ...variables };
  for (const v of op.variables) {
    if (vars[v.name] === undefined && v.defaultValue !== null) vars[v.name] = resolveGqlValue(v.defaultValue, vars);
  }
  try {
    if (op.operation === 'mutation') {
      return { data: executeMutation(op, fragments, vars) };
    }
    const root: GqlObj = { __typename: 'Query' };
    return { data: executeSelectionSet(root, op.selectionSet, fragments, vars) };
  } catch (e) {
    if (e instanceof GqlExecError) return { data: null, errors: [{ message: e.message }] };
    return { data: null, errors: [{ message: e instanceof Error ? e.message : String(e) }] };
  }
}
async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const login = authLogin(req);
  if (!login) {
    errJson(res, 401, 'Requires authentication');
    return;
  }
  const parsed = await readJson(req);
  if (!parsed.ok) {
    jsonBody(res, 400, { errors: [{ message: parsed.error }] });
    return;
  }
  const runOne = (op: unknown): Record<string, unknown> => {
    if (op === null || typeof op !== 'object' || Array.isArray(op)) return { data: null, errors: [{ message: 'invalid operation' }] };
    const o = op as Record<string, unknown>;
    const query = typeof o.query === 'string' ? o.query : '';
    const variables = (o.variables ?? {}) as Record<string, unknown>;
    const operationName = typeof o.operationName === 'string' ? o.operationName : undefined;
    return executeGraphQL(query, variables, operationName);
  };
  if (Array.isArray(parsed.value)) {
    jsonBody(res, 200, parsed.value.map(runOne));
  } else {
    jsonBody(res, 200, runOne(parsed.value));
  }
}

// -------------------------------------------------------------------------------------------
// MCP (JSON-RPC 2.0 Streamable HTTP, revision 2026-07-28)
// -------------------------------------------------------------------------------------------
interface McpToolDef {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, { type: string; description: string }>; required: string[] };
}
const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
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
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];
const MCP_SERVER_INFO = { name: 'forge', version: VERSION };
function mcpResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function mcpError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}
function mcpTextResult(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}
function mcpTextError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}
function mergePullRequestNow(repo: Repo, pull: Pull): { ok: boolean; sha?: string; message: string } {
  if (pull.merged) return { ok: false, message: 'Pull request already merged' };
  const mergeable = computeMergeable(repo, pull);
  if (mergeable !== 'MERGEABLE') return { ok: false, message: 'Pull request cannot be merged' };
  const headSha = currentTip(repo, pull.headRef, pull.headSha);
  const baseSha = currentTip(repo, pull.baseRef, pull.baseSha);
  const headCommit = repo.objects.get(peelToCommit(repo, headSha));
  const baseCommit = repo.objects.get(peelToCommit(repo, baseSha));
  if (!headCommit || !baseCommit || headCommit.type !== 'commit' || baseCommit.type !== 'commit') {
    return { ok: false, message: 'Pull request cannot be merged' };
  }
  const mb = mergeBase(repo, headSha, baseSha);
  const mbTree = mb !== null ? parseCommit((repo.objects.get(mb) as GitObject).data).tree : parseCommit(baseCommit.data).tree;
  const { tree } = mergeTrees(repo, mbTree, parseCommit(headCommit.data).tree, parseCommit(baseCommit.data).tree);
  const treeOid = pathsToTree(repo, tree);
  const commitOid = makeCommit(repo, treeOid, [peelToCommit(repo, baseSha)], pull.title);
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
  repo.updatedAt = nowIso();
  pull.merged = true;
  pull.state = 'closed';
  pull.mergeCommitSha = commitOid;
  pull.mergedAt = nowIso();
  pull.updatedAt = nowIso();
  return { ok: true, sha: commitOid, message: pull.title };
}
function callMcpTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const short = name.toLowerCase();
  const def = MCP_TOOLS.find((t) => short === t.name || short.endsWith(`_${t.name}`) || short.endsWith(t.name));
  if (!def) return mcpTextError(`Unknown tool: ${name}`);
  for (const req of def.inputSchema.required) {
    if (args[req] === undefined || args[req] === null || args[req] === '') {
      return mcpTextError(`Missing required argument: ${req}`);
    }
  }
  if (def.name === 'create_repo') {
    const repoName = String(args.name);
    if (findRepo(VIEWER.login, repoName)) return mcpTextError('Repository already exists');
    const repo = createRepo(VIEWER.login, repoName, {
      description: typeof args.description === 'string' ? args.description : '',
      private: args.private === true,
    });
    return mcpTextResult(repoJson(repo));
  }
  const owner = String(args.owner ?? '');
  const repoName = String(args.repo ?? '');
  const repo = findRepo(owner, repoName);
  if (!repo) return mcpTextError('Not Found');
  if (def.name === 'get_repo') return mcpTextResult(repoJson(repo));
  if (def.name === 'create_issue') {
    const number = repo.nextIssue++;
    const issue: Issue = {
      id: gid('Issue', `${repoKey(repo.owner, repo.name)}#${number}`),
      number,
      title: String(args.title),
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      labels: [],
      comments: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
      seq: seqCounter++,
    };
    repo.issues.push(issue);
    return mcpTextResult(issueJson(repo, issue));
  }
  if (def.name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    const list = repo.issues.filter((i) => (state === 'all' ? true : i.state === state));
    return mcpTextResult({ issues: list.map((i) => issueJson(repo, i)) });
  }
  if (def.name === 'create_pull_request') {
    const head = String(args.head);
    const base = String(args.base);
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha || !baseSha) return mcpTextError('head or base branch does not exist');
    const dup = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
    if (dup) return mcpTextError('A pull request already exists for this head branch');
    const number = repo.nextPull++;
    const pull: Pull = {
      id: gid('PullRequest', `${repoKey(repo.owner, repo.name)}#${number}`),
      number,
      title: String(args.title),
      body: '',
      state: 'open',
      merged: false,
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      mergeCommitSha: null,
      mergedAt: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      seq: seqCounter++,
    };
    repo.pulls.push(pull);
    return mcpTextResult(pullJson(repo, pull));
  }
  if (def.name === 'merge_pull_request') {
    const number = Number(args.pull_number);
    const pull = repo.pulls.find((p) => p.number === number);
    if (!pull) return mcpTextError('Pull request not found');
    const merged = mergePullRequestNow(repo, pull);
    if (!merged.ok) return mcpTextError(merged.message);
    return mcpTextResult({ sha: merged.sha, merged: true, message: merged.message, number: pull.number });
  }
  return mcpTextError(`Unknown tool: ${name}`);
}
async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const login = authLogin(req);
  if (!login) {
    jsonBody(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Requires authentication' } });
    return;
  }
  if (req.method !== 'POST') {
    jsonBody(res, 405, mcpError(null, -32600, 'Method not allowed'));
    return;
  }
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    jsonBody(res, 400, mcpError(null, -32700, 'Parse error'));
    return;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    jsonBody(res, 400, mcpError(null, -32600, 'Invalid Request'));
    return;
  }
  const reqBody = body as Record<string, unknown>;
  const id = reqBody.id === undefined ? null : reqBody.id;
  const method = typeof reqBody.method === 'string' ? reqBody.method : '';
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    if (id === null || id === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }
    jsonBody(res, 200, mcpResult(id, {}));
    return;
  }
  if (!method) {
    jsonBody(res, 400, mcpError(id, -32600, 'Invalid Request'));
    return;
  }
  const params = (reqBody.params ?? {}) as Record<string, unknown>;
  if (method === 'server/discover') {
    jsonBody(res, 200, mcpResult(id, {
      protocolVersion: '2026-07-28',
      supportedVersions: ['2026-07-28', '2025-11-25'],
      serverInfo: MCP_SERVER_INFO,
      capabilities: { tools: {} },
    }));
    return;
  }
  if (method === 'initialize') {
    jsonBody(res, 200, mcpResult(id, {
      protocolVersion: '2026-07-28',
      capabilities: { tools: {} },
      serverInfo: MCP_SERVER_INFO,
    }));
    return;
  }
  if (method === 'ping') {
    jsonBody(res, 200, mcpResult(id, {}));
    return;
  }
  if (method === 'tools/list') {
    jsonBody(res, 200, mcpResult(id, { tools: MCP_TOOLS }));
    return;
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;
    if (!toolName) {
      jsonBody(res, 200, mcpError(id, -32602, 'Invalid params: tool name is required'));
      return;
    }
    const known = MCP_TOOLS.some((t) => {
      const s = toolName.toLowerCase();
      return s === t.name || s.endsWith(`_${t.name}`) || s.endsWith(t.name);
    });
    if (!known) {
      jsonBody(res, 200, mcpError(id, -32602, `Unknown tool: ${toolName}`));
      return;
    }
    const result = callMcpTool(toolName, toolArgs);
    jsonBody(res, 200, mcpResult(id, result));
    return;
  }
  jsonBody(res, 200, mcpError(id, -32601, `Method not found: ${method}`));
}

// -------------------------------------------------------------------------------------------
// Router + lifecycle
// -------------------------------------------------------------------------------------------
async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const query = url.searchParams;
    if (path === '/healthz' && req.method === 'GET') {
      jsonBody(res, 200, { ok: true });
      return;
    }
    if (path === '/api/graphql') {
      if (req.method !== 'POST') {
        errJson(res, 404, 'Not Found');
        return;
      }
      await handleGraphQL(req, res);
      return;
    }
    if (path === '/mcp') {
      await handleMcp(req, res);
      return;
    }
    if (path.startsWith('/api/v3')) {
      await handleRest(req, res, path, query);
      return;
    }
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
    if (gitMatch) {
      const owner = decodeURIComponent(gitMatch[1]!);
      const repoName = decodeURIComponent(gitMatch[2]!);
      const tail = gitMatch[3]!;
      const login = authLogin(req);
      if (!login) {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('Requires authentication');
        return;
      }
      const repo = findRepo(owner, repoName);
      if (!repo) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not Found');
        return;
      }
      if (tail === 'info/refs' && req.method === 'GET') {
        const service = query.get('service') ?? '';
        handleInfoRefs(req, res, repo, service);
        return;
      }
      if (tail === 'git-upload-pack' && req.method === 'POST') {
        await handleGitUploadPack(req, res, repo);
        return;
      }
      if (tail === 'git-receive-pack' && req.method === 'POST') {
        await handleGitReceivePack(req, res, repo);
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    errJson(res, 404, 'Not Found');
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    try {
      errJson(res, 500, message);
    } catch {
      // response already gone
    }
  }
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function registerAndWait(port: number): Promise<void> {
  const registerUrl = `${ENV_URL}/register`;
  const doneUrl = `${ENV_URL}/done`;
  let registered = false;
  for (let attempt = 0; attempt < 240 && !registered; attempt += 1) {
    try {
      const r = await fetch(registerUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(5000),
      });
      if (r.status === 200 || r.status === 201 || r.status === 409) registered = true;
      else console.error(`register: HTTP ${r.status}`);
    } catch (e) {
      console.error(`register attempt ${attempt + 1} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!registered) await sleep(500);
  }
  if (!registered) {
    console.error('register failed; exiting 1');
    process.exit(1);
  }
  for (;;) {
    try {
      const r = await fetch(doneUrl, { signal: AbortSignal.timeout(5000) });
      const body = (await r.json()) as { done?: boolean };
      if (body.done === true) return;
    } catch {
      // keep polling
    }
    await sleep(500);
  }
}
async function main(): Promise<void> {
  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });
  server.on('error', (e) => {
    console.error(`server error: ${e.message}`);
    process.exit(1);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '0.0.0.0', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  console.log(`forge listening on 0.0.0.0:${port}`);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  if (!ENV_URL) {
    console.log('no MAKEFUN_ENV_URL set; serving until killed (local mode)');
    return;
  }
  await registerAndWait(port);
  server.close();
  process.exit(0);
}
void main();
