import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";
import { verify } from "@/lib/jwt";
import {
  commitFiles, createBranch, listBranches, listCommits, listFiles, readFile,
} from "@/lib/github";

const INSTRUCTIONS =
  "Before pushing to any repo, always clone it and inspect it first: check the existing file layout, " +
  "the files you plan to change, the current branch state and recent history, and the project's conventions " +
  "(e.g. README, CLAUDE.md, lint/build config). Base every commit on what you actually read, not on assumptions. " +
  "If you cannot clone the repo (no shell access, or it is private), inspect it with this server's read tools " +
  "instead: list_branches, list_commits, list_files and read_file. Read every file you plan to change, and its " +
  "neighbours, before committing. Verify your changes (build/typecheck/tests where available), and only then " +
  "call commit_files. If you can do neither, say so and ask the user before pushing.";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const ro = { readOnlyHint: true };
const repo = z.string().describe("Repository: a bare name (owner defaults to the configured owner) or owner/name");

const handler = createMcpHandler((server) => {
  server.tool(
    "list_branches", "List a repo's branches with head SHAs and the default branch",
    { repo }, ro,
    async (a) => text(await listBranches(a.repo))
  );
  server.tool(
    "list_commits", "List recent commits (newest first) on a branch or ref; also returns the full head SHA",
    { repo, ref: z.string().optional().describe("Branch, tag or SHA; defaults to the default branch"),
      limit: z.number().int().min(1).max(50).optional() },
    ro,
    async (a) => text(await listCommits(a.repo, a.ref, a.limit))
  );
  server.tool(
    "list_files", "List every file in a repo at a ref, with sizes. Use path to narrow to a directory",
    { repo, ref: z.string().optional().describe("Branch, tag or SHA; defaults to the default branch"),
      path: z.string().optional().describe("Only list files under this directory") },
    ro,
    async (a) => text(await listFiles(a.repo, a.ref, a.path))
  );
  server.tool(
    "read_file", "Read one text file from a repo at a ref (truncated at 100k characters)",
    { repo, path: z.string(), ref: z.string().optional().describe("Branch, tag or SHA; defaults to the default branch") },
    ro,
    async (a) => text(await readFile(a.repo, a.path, a.ref))
  );
  server.tool(
    "create_branch", "Create a branch from an existing one (defaults to the repo's default branch)",
    { repo, branch: z.string(), from: z.string().optional() },
    async (a) => text(`Created ${a.branch} at ${await createBranch(a.repo, a.branch, a.from)}`)
  );
  server.tool(
    "commit_files",
    "Commit files to a branch in one commit. Clone and inspect the repo first (or use list_files/read_file), then push.",
    {
      repo, branch: z.string(), message: z.string(),
      files: z.array(z.object({
        path: z.string(), content: z.string(),
        encoding: z.enum(["utf-8", "base64"]).default("utf-8"),
      })).min(1).max(100),
    },
    async (a) => text(`Committed ${await commitFiles(a.repo, a.branch, a.message, a.files)}`)
  );
}, { instructions: INSTRUCTIONS }, { basePath: "/api" });

const authed = withMcpAuth(handler, async (_req, token) => {
  if (!token) return undefined;
  const p = await verify(token, "access").catch(() => null);
  return p ? { token, clientId: String(p.client_id), scopes: [], extra: { sub: p.sub } } : undefined;
}, { required: true, resourceMetadataPath: "/.well-known/oauth-protected-resource" });

export { authed as GET, authed as POST };
