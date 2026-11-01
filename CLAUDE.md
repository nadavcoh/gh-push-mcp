# CLAUDE.md

Guidance for working in this repo.

## What this is

`gh-push-mcp` is an MCP server (Next.js App Router, deployed on Vercel) that lets Claude create branches and
commit files to GitHub. It includes its own stateless OAuth 2.1 server. See `README.md` for setup and the
environment variables.

## Commands

```bash
npm install
npm run dev            # local dev server
npm run build          # production build
npx tsc --noEmit       # typecheck (run before every commit; set OAUTH_SECRET to any value)
```

There is no test suite yet. Typecheck is the minimum bar.

## Layout

- `app/api/[transport]/route.ts`: MCP endpoint (`/api/mcp`) and tool definitions, wrapped in `withMcpAuth`
- `app/.well-known/*`: OAuth discovery metadata (protected resource and authorization server)
- `app/register`, `app/authorize`, `app/callback/github`, `app/token`: the OAuth flow
- `lib/jwt.ts`: sign/verify helpers; every token type has its own audience
- `lib/github.ts`: Octokit via GitHub App installation auth; `createBranch` and `commitFiles`

## Conventions and invariants

- Keep the server stateless. No database; state lives in signed JWTs.
- Never weaken auth: only `ALLOWED_GITHUB_ID` (numeric ID, not username) may complete login, PKCE `S256` is
  required, and redirect URIs must stay restricted to `claude.ai` / `claude.com`.
- Keep distinct JWT audiences (`client`, `gh-state`, `code`, `access`, `refresh`). Don't reuse one for another.
- Git updates must stay `force: false`. Keep the path checks in `commitFiles`.
- Writes to default branches are intentionally allowed. Don't re-add branch or repo guards unless asked.
- Don't log tokens, codes, JWTs, private keys or env values.
- Never commit secrets. `.env*` is gitignored; `.env.example` holds names only.

## Dependency pins

`mcp-handler` is pinned to `1.1.0` and `@modelcontextprotocol/sdk` to `1.26.0`. `mcp-handler` 2.x requires
`@modelcontextprotocol/server` v2 and a different tool API, so `server.tool(...)` won't typecheck there. Upgrade
both together and update the tool registration if you do.

## Adding a tool

Register it in `app/api/[transport]/route.ts` with `server.tool(name, description, zodShape, handler)`, put the
GitHub logic in `lib/github.ts`, and return `{ content: [{ type: "text", text }] }`. Check that the GitHub App
has the permission the new call needs; Contents is the only one granted by default.
