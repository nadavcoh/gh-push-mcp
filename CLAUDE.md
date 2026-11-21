# CLAUDE.md

Guidance for working in this repo.

## What this is

`gh-push-mcp` is an MCP server (Next.js App Router, deployed on Vercel) that lets Claude read repos, edit files in
place, create branches, commit and delete files, and get a short-lived token for real git. It includes its own
stateless OAuth 2.1 server. See `README.md` for the tools, setup and the environment variables.

## Commands

```bash
npm install
npm run dev            # local dev server
npm run build          # production build
npx tsc --noEmit       # typecheck (run before every commit; set OAUTH_SECRET to any value)
```

There is no test suite yet. `npm run build` is the minimum bar before pushing: it also checks route export types,
which `tsc --noEmit` misses. Set `BASE_URL` and `OAUTH_SECRET` to any values for a local build.

## Layout

- `app/api/[transport]/route.ts`: MCP endpoint (`/api/mcp`) and tool definitions, wrapped in `withMcpAuth`
- `app/.well-known/*`: OAuth discovery metadata (protected resource and authorization server)
- `app/register`, `app/authorize`, `app/callback/github`, `app/token`: the OAuth flow
- `lib/jwt.ts`: sign/verify helpers; every token type has its own audience
- `lib/github.ts`: Octokit via GitHub App installation auth. `parseRepo` (bare name or `owner/name`), `checkPath` (the path guard, including the `DEPLOY_WORKFLOW` exception), the shared `commit` helper behind `commitFiles` and `editFile`, `createBranch`, `gitCredentials`, and the read helpers (`listBranches`, `listCommits`, `listFiles`, `readFile`)

## Conventions and invariants

- Keep the server stateless. No database; state lives in signed JWTs.
- Never weaken auth: only `ALLOWED_GITHUB_ID` (numeric ID, not username) may complete login, PKCE `S256` is
  required, and redirect URIs must stay restricted to `claude.ai` / `claude.com`.
- Keep distinct JWT audiences (`client`, `gh-state`, `code`, `access`, `refresh`). Don't reuse one for another.
- Git updates must stay `force: false`. Keep the path checks (`checkPath`) in the shared `commit` helper that both
  `commit_files` and `edit_file` use. `edit_file` must read and commit against the same head SHA, so a branch that
  moved fails the update instead of being overwritten.
- `repo` arguments accept a bare name or `owner/name` (`parseRepo`). GitHub's token API needs the repo's current
  name, so a renamed repo breaks `git_credentials` until the new name is used.
- The `INSTRUCTIONS` string in `route.ts` is part of the product (it tells Claude to clone and inspect first, and
  which tool to pick). Keep it in sync with the tool set.
- `checkPath` blocks `.github/workflows` except top-level `deploy.yml` and `deploy-*.yml` (the `DEPLOY_WORKFLOW`
  regex, added at the owner's request). Don't widen that exception without being asked. GitHub also only accepts
  such pushes if the App has Workflows: Read and write and the installation accepted it; `git_credentials` tokens
  stay Contents-only, so raw git can't push workflow files.
- Writes to default branches are intentionally allowed. Don't re-add branch or repo guards unless asked.
- Don't log tokens, codes, JWTs, private keys or env values.
- `git_credentials` tokens must stay single-repo, Contents-only and short-lived. Never log or persist them; they
  only appear in the tool result. Log the repo and mode only.
- Never commit secrets. `.env*` is gitignored; `.env.example` holds names only.

## Dependency pins

`mcp-handler` is pinned to `1.1.0` and `@modelcontextprotocol/sdk` to `1.26.0`. `mcp-handler` 2.x requires
`@modelcontextprotocol/server` v2 and a different tool API, so `server.tool(...)` won't typecheck there. Upgrade
both together and update the tool registration if you do.

## Adding a tool

Register it in `app/api/[transport]/route.ts` with `server.tool(name, description, zodShape, handler)` (pass
`{ readOnlyHint: true }` before the handler for read-only tools), put the GitHub logic in `lib/github.ts`, and
return `{ content: [{ type: "text", text }] }`. Update `INSTRUCTIONS` if the tool changes how Claude should work,
and add it to the README Tools table in the same commit. Check that the GitHub App
has the permission the new call needs; Contents is the only one required by default (Workflows is optional, only for deploy workflow files).

## When you change something

- Keep `README.md` and this file in sync with the code in the same commit: a new tool, guard, env var or error
  message belongs in the docs (Tools table, Security notes, Troubleshooting).
- Run the local build (see Commands) before pushing. Vercel redeploys on every push to `main`.
- Clients read the tool list when they connect, so a new or changed tool only appears in an open chat after the
  connector is reconnected (or in a new chat). Wait for the deployment to be `READY` before testing it live.

## Delivering

- Small changes to existing files: `edit_file` through this connector, sending only the changed snippets.
- Multi-file, large or binary changes: real git with `git_credentials` (write mode). Pass the token through
  `http.extraheader`; never print or store it, never force-push, and only delete branches the owner names.
- Push to `main` directly (the owner allows it). Don't deliver code as an archive.
- Commit messages: one line saying what changed and why.
