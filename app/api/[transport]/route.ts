import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";
import { verify } from "@/lib/jwt";
import {
  commitFiles, createBranch, editFile, listBranches, listCommits, listFiles, readFile,
} from "@/lib/github";

const INSTRUCTIONS =
  "Before pushing to any repo, always clone it and inspect it first: check the existing file layout, " +
  "the files you plan to change, the current branch state and recent history, and the project's conventions " +
  "(e.g. README, CLAUDE.md, lint/build config). Base every commit on what you actually read, not on assumptions. " +
  "If you cannot clone the repo (no shell access, or it is private), inspect it with this server's read tools " +
  "instead: list_branches, list_commits, list_files and read_file. Read every file you plan to change, and its " +
  "neighbours, before committing. Verify your changes (build/typecheck/tests where available), and only then " +
  "call commit_files or edit_file. For small changes to existing files, prefer edit_file: send only the changed " +
  "snippets instead of the whole file. If you can do neither, say so and ask the user before pushing.";

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
    "edit_file",
    "Edit one existing text file in place using exact-match replacements, and commit it. Prefer this over " +
    "commit_files for small changes: send only the changed snippets. Each old_str must match exactly once " +
    "(or set replace_all).",
    {
      repo, branch: z.string(), path: z.string(), message: z.string(),
      edits: z.array(z.object({
        old_str: z.string().min(1), new_str: z.string(), replace_all: z.boolean().optional(),
      })).min(1).max(50),
    },
    async (a) => text(`Committed ${await editFile(a.repo, a.branch, a.path, a.edits, a.message)}`)
  );
  server.tool(
    "commit_files",
    "Create, overwrite and/or delete files on a branch in one commit. Clone and inspect the repo first (or use " +
    "list_files/read_file), then push. For small edits to an existing file, use edit_file instead.",
    {
      repo, branch: z.string(), message: z.string(),
      files: z.array(z.object({
        path: z.string(), content: z.string(),
        encoding: z.enum(["utf-8", "base64"]).default("utf-8"),
      })).max(100).default([]),
      delete: z.array(z.string()).max(100).default([]).describe("Paths of files to delete in this commit"),
    },
    async (a) => {
      const sha = await commitFiles(a.repo, a.branch, a.message, a.files, a.delete);
      return text(`Committed ${sha} (${a.files.length} written, ${a.delete.length} deleted)`);
    }
  );
}, { instructions: INSTRUCTIONS }, { basePath: "/api" });

const authed = withMcpAuth(handler, async (_req, token) => {
  if (!token) return undefined;
  const p = await verify(token, "access").catch(() => null);
  return p ? { token, clientId: String(p.client_id), scopes: [], extra: { sub: p.sub } } : undefined;
}, { required: true, resourceMetadataPath: "/.well-known/oauth-protected-resource" });

export { authed as GET, authed as POST };
