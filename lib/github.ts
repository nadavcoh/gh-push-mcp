import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";

const OWNER = process.env.GITHUB_OWNER!;

const octo = () => new Octokit({
  authStrategy: createAppAuth,
  auth: {
    appId: process.env.GITHUB_APP_ID!,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, "\n"),
    installationId: Number(process.env.GITHUB_INSTALLATION_ID!),
  },
});

// Accepts "name" (owner defaults to GITHUB_OWNER) or "owner/name".
function parseRepo(input: string) {
  const [a, b, extra] = input.trim().split("/");
  if (extra !== undefined || !a || b === "") throw new Error(`Bad repo: ${input}`);
  return b ? { owner: a, repo: b } : { owner: OWNER, repo: a };
}

export async function createBranch(repoArg: string, branch: string, from?: string) {
  const o = octo();
  const { owner, repo } = parseRepo(repoArg);
  const base = from ?? (await o.repos.get({ owner, repo })).data.default_branch;
  const { data } = await o.git.getRef({ owner, repo, ref: `heads/${base}` });
  await o.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: data.object.sha });
  return data.object.sha;
}

type F = { path: string; content: string; encoding: "utf-8" | "base64" };
type Edit = { old_str: string; new_str: string; replace_all?: boolean };

// Only deploy workflows (deploy.yml, deploy-*.yml, directly in .github/workflows) may be written.
const DEPLOY_WORKFLOW = /^\.github\/workflows\/deploy(-[A-Za-z0-9._-]+)?\.ya?ml$/;

function checkPath(p: string) {
  if (!p || p.startsWith("/") || p.includes("..") || p.startsWith(".git/") ||
    (p.startsWith(".github/workflows") && !DEPLOY_WORKFLOW.test(p)))
    throw new Error(`Bad path: ${p}`);
}

// Commits on top of `headSha` (or the branch's current head). The ref update is non-force, so it fails
// instead of overwriting if the branch moved in the meantime.
async function commit(
  o: Octokit, owner: string, repo: string, branch: string, message: string,
  files: F[], deletes: string[], headSha?: string,
) {
  if (!files.length && !deletes.length) throw new Error("Nothing to commit");
  [...files.map(f => f.path), ...deletes].forEach(checkPath);
  const overlap = deletes.filter(d => files.some(f => f.path === d));
  if (overlap.length) throw new Error(`Path is both written and deleted: ${overlap[0]}`);
  const parent = headSha ?? (await o.git.getRef({ owner, repo, ref: `heads/${branch}` })).data.object.sha;
  const base = await o.git.getCommit({ owner, repo, commit_sha: parent });
  const written = await Promise.all(files.map(async f => {
    const b = await o.git.createBlob({ owner, repo, content: f.content, encoding: f.encoding });
    return { path: f.path, mode: "100644" as const, type: "blob" as const, sha: b.data.sha as string | null };
  }));
  const removed = deletes.map(path => ({ path, mode: "100644" as const, type: "blob" as const, sha: null as string | null }));
  const t = await o.git.createTree({
    owner, repo, base_tree: base.data.tree.sha, tree: [...written, ...removed],
  }).catch(async (err: unknown) => {
    if (deletes.length) {
      const { data } = await o.git.getTree({ owner, repo, tree_sha: base.data.tree.sha, recursive: "1" });
      const have = new Set(data.tree.map(e => e.path));
      const missing = deletes.filter(d => !have.has(d));
      if (missing.length) throw new Error(`Cannot delete, not found on ${branch}: ${missing.join(", ")}`);
    }
    throw err;
  });
  const c = await o.git.createCommit({ owner, repo, message, tree: t.data.sha, parents: [parent] });
  await o.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: c.data.sha, force: false });
  return c.data.sha;
}

export async function commitFiles(repoArg: string, branch: string, message: string, files: F[], deletes: string[] = []) {
  const o = octo();
  const { owner, repo } = parseRepo(repoArg);
  return commit(o, owner, repo, branch, message, files, deletes);
}

export async function editFile(repoArg: string, branch: string, path: string, edits: Edit[], message: string) {
  const o = octo();
  const { owner, repo } = parseRepo(repoArg);
  checkPath(path);
  const head = (await o.git.getRef({ owner, repo, ref: `heads/${branch}` })).data.object.sha;
  const original = await fetchText(o, owner, repo, path, head);
  let text = original;
  edits.forEach((e, i) => {
    const n = text.split(e.old_str).length - 1;
    if (n === 0) throw new Error(`Edit ${i + 1}: old_str not found in ${path}`);
    if (n > 1 && !e.replace_all)
      throw new Error(`Edit ${i + 1}: old_str matches ${n} times; add surrounding context or set replace_all`);
    text = e.replace_all ? text.split(e.old_str).join(e.new_str) : text.replace(e.old_str, () => e.new_str);
  });
  if (text === original) throw new Error("Edits produced no change");
  return commit(o, owner, repo, branch, message, [{ path, content: text, encoding: "utf-8" }], [], head);
}

export async function gitCredentials(repoArg: string, mode: "read" | "write") {
  const { owner, repo } = parseRepo(repoArg);
  if (owner.toLowerCase() !== OWNER.toLowerCase()) throw new Error(`Only repos owned by ${OWNER} are supported`);
  const auth = createAppAuth({
    appId: process.env.GITHUB_APP_ID!,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, "\n"),
    installationId: Number(process.env.GITHUB_INSTALLATION_ID!),
  });
  const { token, expiresAt } = await auth({
    type: "installation", repositoryNames: [repo], permissions: { contents: mode },
  });
  console.log(`git_credentials issued: ${owner}/${repo} ${mode}`);
  return [
    `Token for ${owner}/${repo} (Contents: ${mode}, expires ${expiresAt}):`,
    token,
    "",
    "Use it without printing it:",
    `  H="Authorization: Basic $(printf 'x-access-token:%s' "$TOKEN" | base64 -w0)"`,
    `  git -c credential.helper= -c http.extraheader="$H" clone https://github.com/${owner}/${repo}.git`,
    "Never echo the token, write it to disk, or put it in a remote URL. Never force-push or delete branches.",
  ].join("\n");
}

const MAX_TEXT = 100_000;
const defaultBranch = async (o: Octokit, owner: string, repo: string) =>
  (await o.repos.get({ owner, repo })).data.default_branch;

async function fetchBytes(o: Octokit, owner: string, repo: string, path: string, ref?: string) {
  const { data } = await o.repos.getContent({ owner, repo, path, ref });
  if (Array.isArray(data) || data.type !== "file") throw new Error(`Not a file: ${path}`);
  const b64 = "content" in data && data.content
    ? data.content
    : (await o.git.getBlob({ owner, repo, file_sha: data.sha })).data.content;
  return { sha: data.sha, buf: Buffer.from(b64, "base64") };
}

async function fetchText(o: Octokit, owner: string, repo: string, path: string, ref?: string) {
  const { buf } = await fetchBytes(o, owner, repo, path, ref);
  if (buf.includes(0)) throw new Error(`${path} is a binary file; use commit_files`);
  return buf.toString("utf-8");
}

export async function listBranches(repoArg: string) {
  const o = octo();
  const { owner, repo } = parseRepo(repoArg);
  const [def, { data }] = await Promise.all([
    defaultBranch(o, owner, repo),
    o.repos.listBranches({ owner, repo, per_page: 100 }),
  ]);
  const lines = data.map(b => `${b.name}\t${b.commit.sha.slice(0, 12)}${b.protected ? "\tprotected" : ""}`);
  return `default: ${def}\n${lines.join("\n")}`;
}

export async function listCommits(repoArg: string, ref?: string, limit = 10) {
  const o = octo();
  const { owner, repo } = parseRepo(repoArg);
  const { data } = await o.repos.listCommits({
    owner, repo, sha: ref ?? (await defaultBranch(o, owner, repo)), per_page: Math.min(Math.max(limit, 1), 50),
  });
  if (!data.length) return "No commits";
  const lines = data.map(c =>
    `${c.sha.slice(0, 12)} ${c.commit.author?.date?.slice(0, 10) ?? ""} ${c.commit.author?.name ?? ""}: ${c.commit.message.split("\n")[0]}`);
  return `head: ${data[0].sha}\n${lines.join("\n")}`;
}

export async function listFiles(repoArg: string, ref?: string, prefix?: string) {
  const o = octo();
  const { owner, repo } = parseRepo(repoArg);
  const r = ref ?? (await defaultBranch(o, owner, repo));
  const { data } = await o.git.getTree({ owner, repo, tree_sha: r, recursive: "1" });
  const p = prefix?.replace(/^\/+|\/+$/g, "");
  const all = data.tree.filter(t => t.type === "blob" && (!p || t.path === p || t.path!.startsWith(`${p}/`)));
  const shown = all.slice(0, 1000);
  const note = data.truncated || all.length > shown.length
    ? `\n[truncated: showing ${shown.length} of ${all.length}${data.truncated ? "+" : ""}; narrow with path]` : "";
  return `ref: ${r} @ ${data.sha.slice(0, 12)}\npath\tbytes\n${shown.map(t => `${t.path}\t${t.size ?? 0}`).join("\n")}${note}`;
}

export async function readFile(repoArg: string, path: string, ref?: string) {
  const o = octo();
  const { owner, repo } = parseRepo(repoArg);
  const { sha, buf } = await fetchBytes(o, owner, repo, path, ref);
  const head = `${path} @ ${ref ?? "default branch"} (blob ${sha.slice(0, 12)}, ${buf.length} bytes)`;
  if (buf.includes(0)) return `${head}\n[binary file, not shown]`;
  const t = buf.toString("utf-8");
  return t.length > MAX_TEXT
    ? `${head}\n${t.slice(0, MAX_TEXT)}\n[truncated at ${MAX_TEXT} characters]`
    : `${head}\n${t}`;
}
