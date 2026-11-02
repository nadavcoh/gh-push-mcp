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
