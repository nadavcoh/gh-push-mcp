import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";
import { verify } from "@/lib/jwt";
import { commitFiles, createBranch } from "@/lib/github";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

const handler = createMcpHandler((server) => {
  server.tool(
    "create_branch", "Create a branch from an existing one (defaults to the repo's default branch)",
    { repo: z.string(), branch: z.string(), from: z.string().optional() },
    async ({ repo, branch, from }) => text(`Created ${branch} at ${await createBranch(repo, branch, from)}`)
  );
  server.tool(
    "commit_files", "Commit files to a branch in one commit",
    {
      repo: z.string(), branch: z.string(), message: z.string(),
      files: z.array(z.object({
        path: z.string(), content: z.string(),
        encoding: z.enum(["utf-8", "base64"]).default("utf-8"),
      })).min(1).max(100),
    },
    async ({ repo, branch, message, files }) => text(`Committed ${await commitFiles(repo, branch, message, files)}`)
  );
}, {}, { basePath: "/api" });

const authed = withMcpAuth(handler, async (_req, token) => {
  if (!token) return undefined;
  const p = await verify(token, "access").catch(() => null);
  return p ? { token, clientId: String(p.client_id), scopes: [], extra: { sub: p.sub } } : undefined;
}, { required: true, resourceMetadataPath: "/.well-known/oauth-protected-resource" });

export { authed as GET, authed as POST };
