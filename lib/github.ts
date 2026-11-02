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

export async function commitFiles(repoArg: string, branch: string, message: string, files: F[]) {
  const o = octo();
  const { owner, repo } = parseRepo(repoArg);
  for (const f of files) {
    if (f.path.startsWith("/") || f.path.includes("..") ||
        f.path.startsWith(".git/") || f.path.startsWith(".github/workflows"))
      throw new Error(`Bad path: ${f.path}`);
  }
  const ref = await o.git.getRef({ owner, repo, ref: `heads/${branch}` });
  const base = await o.git.getCommit({ owner, repo, commit_sha: ref.data.object.sha });
  const tree = await Promise.all(files.map(async f => {
    const b = await o.git.createBlob({ owner, repo, content: f.content, encoding: f.encoding });
    return { path: f.path, mode: "100644" as const, type: "blob" as const, sha: b.data.sha };
  }));
  const t = await o.git.createTree({ owner, repo, base_tree: base.data.tree.sha, tree });
  const c = await o.git.createCommit({
    owner, repo, message, tree: t.data.sha, parents: [ref.data.object.sha],
  });
  await o.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: c.data.sha, force: false });
  return c.data.sha;
}

const MAX_TEXT = 100_000;
const defaultBranch = async (o: Octokit, owner: string, repo: string) =>
  (await o.repos.get({ owner, repo })).data.default_branch;

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
  return `ref: ${r} (tree ${data.sha.slice(0, 12)})\npath\tbytes\n${shown.map(t => `${t.path}\t${t.size ?? 0}`).join("\n")}${note}`;
}

export async function readFile(repoArg: string, path: string, ref?: string) {
  const o = octo();
  const { owner, repo } = parseRepo(repoArg);
  const { data } = await o.repos.getContent({ owner, repo, path, ref });
  if (Array.isArray(data) || data.type !== "file") throw new Error(`Not a file: ${path}`);
  const b64 = "content" in data && data.content
    ? data.content
    : (await o.git.getBlob({ owner, repo, file_sha: data.sha })).data.content;
  const buf = Buffer.from(b64, "base64");
  const head = `${path} @ ${ref ?? "default branch"} (blob ${data.sha.slice(0, 12)}, ${buf.length} bytes)`;
  if (buf.includes(0)) return `${head}\n[binary file, not shown]`;
  const t = buf.toString("utf-8");
  return t.length > MAX_TEXT
    ? `${head}\n${t.slice(0, MAX_TEXT)}\n[truncated at ${MAX_TEXT} characters]`
    : `${head}\n${t}`;
}
