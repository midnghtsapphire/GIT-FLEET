// GitHub Discussions as the fleet's message board (GraphQL API), plus issue and
// PR conversations (REST API) so members can work like repo collaborators.
// Any agent, bot or LLM with access to the repo can read and post here;
// see BOARD_PROTOCOL.md for the message format.
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.github.com/graphql';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let repoCache = null;

function token() {
  const t = process.env.FLEET_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (t) return t;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    throw new Error('No GitHub token: set GITHUB_TOKEN or run `gh auth login`');
  }
}

export function repoSlug() {
  const slug = process.env.FLEET_REPO || process.env.GITHUB_REPOSITORY;
  if (slug) return slug;
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = url.match(/github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/);
    if (m) return m[1];
  } catch {}
  throw new Error('Set FLEET_REPO=owner/name in .env (no GitHub origin found)');
}

// The whiteboard can live in another repo (e.g. revvel-standards) than the fleet's own.
let boardOverride = null;
export function setBoardRepo(slug) {
  if (slug && slug !== boardOverride) { boardOverride = slug; repoCache = null; }
}
export const boardSlug = () => boardOverride || repoSlug();

function ownerName() {
  const [owner, name] = boardSlug().split('/');
  return { owner, name };
}

async function gql(query, variables) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (!res.ok || data.errors) throw new Error(`GitHub GraphQL: ${JSON.stringify(data.errors ?? data).slice(0, 400)}`);
  return data.data;
}

async function repoInfo() {
  if (repoCache) return repoCache;
  const d = await gql(
    `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){
      id hasDiscussionsEnabled discussionCategories(first:50){nodes{id name}}}}`,
    ownerName(),
  );
  if (!d.repository.hasDiscussionsEnabled) {
    throw new Error(`Discussions are off for ${boardSlug()} (Settings > General > Features > Discussions)`);
  }
  return (repoCache = d.repository);
}

export async function categories() {
  return (await repoInfo()).discussionCategories.nodes.map((c) => c.name);
}

export async function createDiscussion(category, title, body) {
  const r = await repoInfo();
  const cats = r.discussionCategories.nodes;
  const cat = cats.find((c) => c.name.toLowerCase() === category.toLowerCase());
  if (!cat) throw new Error(`No discussion category "${category}" (have: ${cats.map((c) => c.name).join(', ')})`);
  const d = await gql(
    `mutation($repo:ID!,$cat:ID!,$title:String!,$body:String!){
      createDiscussion(input:{repositoryId:$repo,categoryId:$cat,title:$title,body:$body}){discussion{url}}}`,
    { repo: r.id, cat: cat.id, title, body },
  );
  return d.createDiscussion.discussion.url;
}

export async function reply(number, body) {
  const found = await gql(
    `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){discussion(number:$n){id}}}`,
    { ...ownerName(), n: number },
  );
  if (!found.repository.discussion) throw new Error(`No discussion #${number}`);
  const d = await gql(
    `mutation($id:ID!,$body:String!){addDiscussionComment(input:{discussionId:$id,body:$body}){comment{url}}}`,
    { id: found.repository.discussion.id, body },
  );
  return d.addDiscussionComment.comment.url;
}

const fmt = (who, when, body, max = Infinity) => `--- ${who ?? 'ghost'} @ ${when}\n${body.trim().slice(0, max)}`;

export async function thread(number) {
  const d = await gql(
    `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){discussion(number:$n){
      number title url createdAt body category{name} author{login}
      comments(last:30){nodes{author{login} createdAt body}}}}}`,
    { ...ownerName(), n: number },
  );
  const t = d.repository.discussion;
  if (!t) throw new Error(`No discussion #${number}`);
  return [
    `#${t.number} [${t.category.name}] ${t.title} (${t.url})`,
    fmt(t.author?.login, t.createdAt, t.body),
    ...t.comments.nodes.map((c) => fmt(c.author?.login, c.createdAt, c.body)),
  ].join('\n\n');
}

// ---------- issues and pull requests (a PR's conversation is its issue thread) ----------

async function rest(method, path, body, slug = boardSlug()) {
  const res = await fetch(`https://api.github.com/repos/${slug}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    ...(body && { body: JSON.stringify(body) }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`GitHub REST ${method} ${path}: ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

export async function issueThread(number) {
  const issue = await rest('GET', `/issues/${number}`);
  const comments = await rest('GET', `/issues/${number}/comments?per_page=100`);
  const kind = issue.pull_request ? 'PR' : 'issue';
  return [
    `${kind} #${issue.number} ${issue.title} (${issue.html_url}) [${issue.state}]`,
    fmt(issue.user?.login, issue.created_at, issue.body ?? ''),
    ...comments.slice(-30).map((c) => fmt(c.user?.login, c.created_at, c.body ?? '')),
  ].join('\n\n');
}

export async function issueReply(number, body) {
  return (await rest('POST', `/issues/${number}/comments`, { body })).html_url;
}

// Opens an issue in any repo (used for WR requests in the fleet's own repo).
export async function createIssue(slug, title, body) {
  return (await rest('POST', '/issues', { title, body }, slug)).html_url;
}

// Everything posted on the whiteboard after `since` (ISO, whole seconds): new
// discussions, discussion comments, new issues/PRs and issue/PR comments, oldest first.
export async function newMessages(since) {
  const out = [];
  const d = await gql(
    `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){
      discussions(first:25,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{
        number createdAt updatedAt body comments(last:20){nodes{createdAt body}}}}}}`,
    ownerName(),
  );
  for (const t of d.repository.discussions.nodes) {
    if (t.updatedAt <= since) break;
    if (t.createdAt > since) out.push({ kind: 'discussion', number: t.number, body: t.body, at: t.createdAt });
    for (const c of t.comments.nodes) {
      if (c.createdAt > since) out.push({ kind: 'discussion', number: t.number, body: c.body, at: c.createdAt });
    }
  }
  for (const c of await rest('GET', `/issues/comments?since=${since}&per_page=100&sort=created&direction=asc`)) {
    if (c.created_at > since) out.push({ kind: 'issue', number: Number(c.issue_url.split('/').pop()), body: c.body ?? '', at: c.created_at });
  }
  for (const i of await rest('GET', `/issues?since=${since}&state=open&per_page=50&sort=created&direction=desc`)) {
    if (i.created_at > since) out.push({ kind: 'issue', number: i.number, body: i.body ?? '', at: i.created_at });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

export async function recent({ read_limit = 10, read_categories = [], context_max_chars = 8000 } = {}) {
  const wanted = read_categories.map((c) => c.toLowerCase());
  const d = await gql(
    `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){
      discussions(first:$n,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{
        number title updatedAt body category{name} author{login}
        comments(last:3){nodes{author{login} createdAt body}}}}}}`,
    { ...ownerName(), n: Math.min(read_limit * (wanted.length ? 3 : 1), 50) },
  );
  const text = d.repository.discussions.nodes
    .filter((t) => !wanted.length || wanted.includes(t.category.name.toLowerCase()))
    .slice(0, read_limit)
    .map((t) =>
      [
        `#${t.number} [${t.category.name}] ${t.title}`,
        fmt(t.author?.login, t.updatedAt, t.body, 1500),
        ...t.comments.nodes.map((c) => fmt(c.author?.login, c.createdAt, c.body, 1000)),
      ].join('\n'),
    )
    .join('\n\n');
  return text.slice(0, context_max_chars) || '(board is empty)';
}
