import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";
import { verify } from "@/lib/jwt";
import { commitFiles, createBranch } from "@/lib/github";

const INSTRUCTIONS =
  "Before pushing to any repo, always clone it and inspect it first: check the existing file layout, " +
  "the files you plan to change, the current branch state and recent history, and the project's conventions " +
  "(e.g. README, CLAUDE.md, lint/build config). Base every commit on what you actually read, not on assumptions. " +
  "Build your changes against that clone, verify them (build/typecheck/tests where available), and only then " +
  "call commit_files. If you cannot clone the repo (no shell access, or it is private), say so and ask the user " +
  "before pushing.";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

const handler = createMcpHandler((server) => {
  server.tool(
    "create_branch", "Create a branch from an existing one (defaults to the repo's default branch)",
    { repo: z.string(), branch: z.string(), from: z.string().optional() },
    async ({ repo, branch, from }) => text(`Created ${branch} at ${await createBranch(repo, branch, from)}`)
  );
  server.tool(
    "commit_files", "Commit files to a branch in one commit. Clone and inspect the repo first, then push.",
    {
      repo: z.string(), branch: z.string(), message: z.string(),
      files: z.array(z.object({
        path: z.string(), content: z.string(),
        encoding: z.enum(["utf-8", "base64"]).default("utf-8"),
      })).min(1).max(100),
    },
    async ({ repo, branch, message, files }) => text(`Committed ${await commitFiles(repo, branch, message, files)}`)
  );
}, { instructions: INSTRUCTIONS }, { basePath: "/api" });

const authed = withMcpAuth(handler, async (_req, token) => {
  if (!token) return undefined;
  const p = await verify(token, "access").catch(() => null);
  return p ? { token, clientId: String(p.client_id), scopes: [], extra: { sub: p.sub } } : undefined;
}, { required: true, resourceMetadataPath: "/.well-known/oauth-protected-resource" });

export { authed as GET, authed as POST };
