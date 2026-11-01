# gh-push-mcp

A small MCP server that lets Claude push commits to your GitHub repos. It runs as a Next.js app on Vercel,
protects itself with OAuth 2.1, and writes to GitHub through a GitHub App installation token, so no
long-lived personal access token ever sits in a chat, a skill, or a config file.

- **MCP endpoint:** `/api/mcp` (Streamable HTTP)
- **Auth:** built-in OAuth 2.1 server (PKCE + dynamic client registration), login restricted to one GitHub user ID
- **GitHub access:** GitHub App installation token, scoped to the repos you install the App on

## Tools

| Tool | What it does |
|---|---|
| `create_branch(repo, branch, from?)` | Creates a branch from `from`, or from the repo's default branch if omitted. |
| `commit_files(repo, branch, message, files[])` | Commits up to 100 files in a single commit via the Git Data API. Each file is `{ path, content, encoding }` with `encoding` of `utf-8` or `base64`. |

`repo` is the repository name under `GITHUB_OWNER`, not `owner/name`.

Writes to `main`, `master` and the default branch are allowed. Force-pushes are not: refs are updated with
`force: false`. Paths that are absolute, contain `..`, start with `.git/`, or start with `.github/workflows`
are rejected.

## How it works

```
Claude ──► /register            dynamic client registration (stateless, signed client_id)
       ──► /authorize           validates client + PKCE, redirects to GitHub login
GitHub ──► /callback/github     checks your numeric GitHub user ID, issues a short-lived auth code
Claude ──► /token               verifies PKCE, returns access (1h) and refresh (30d) tokens
Claude ──► /api/mcp             Bearer access token, then tools call GitHub as the App
```

The server keeps no database. Client IDs, auth codes and tokens are JWTs signed with `OAUTH_SECRET`, each with
its own audience so one kind can't be used as another. Registration only accepts redirect URIs under
`https://claude.ai/` and `https://claude.com/`.

## Setup

### 1. Create a GitHub App

GitHub > Settings > Developer settings > GitHub Apps > New GitHub App.

- **Callback URL:** `https://<your-domain>/callback/github`
- **Webhook:** uncheck "Active"
- **Repository permissions:** Contents: Read and write (Metadata: Read is added automatically)
- **Where can it be installed:** Only on this account

Then:

1. Generate a **private key** (downloads a `.pem`).
2. Generate a **client secret**.
3. Note the **App ID** and **Client ID**.
4. Install the App and choose **Only select repositories**. The installation is your repo allowlist.
5. Note the **installation ID** from the URL of the installation settings page.

Find your numeric GitHub user ID at `https://api.github.com/users/<your-username>` (the `id` field).

### 2. Deploy to Vercel

Import this repo into Vercel and set these environment variables. Mark all of them as sensitive.

| Variable | Value |
|---|---|
| `BASE_URL` | `https://<your-domain>` with no trailing slash |
| `OAUTH_SECRET` | 32+ random bytes, e.g. `openssl rand -base64 48` |
| `GITHUB_CLIENT_ID` | the App's client ID |
| `GITHUB_CLIENT_SECRET` | the App's client secret |
| `ALLOWED_GITHUB_ID` | your numeric GitHub user ID |
| `GITHUB_APP_ID` | the App's ID |
| `GITHUB_INSTALLATION_ID` | the installation ID |
| `GITHUB_APP_PRIVATE_KEY` | the PEM contents, with newlines written as `\n` |
| `GITHUB_OWNER` | the GitHub user or org that owns the repos |

`.env.example` lists the same variables.

### 3. Connect it to Claude

Add `https://<your-domain>/api/mcp` as a custom connector (Settings > Connectors). Claude registers itself,
sends you through GitHub login, and stores the resulting tokens. Custom connectors depend on your plan.

## Local development

```bash
npm install
cp .env.example .env.local   # fill in the values
npm run dev
npx tsc --noEmit             # typecheck
```

For the OAuth flow to work locally, `BASE_URL` must be a public HTTPS URL (a tunnel works), and the GitHub App's
callback URL must match it.

## Security notes

- Only the GitHub account whose numeric ID is in `ALLOWED_GITHUB_ID` can sign in. IDs are used rather than
  usernames because usernames can be renamed and reclaimed.
- The App can only touch repos it is installed on. Keep the installation on "Only select repositories".
- Auth codes are stateless and valid for 2 minutes, so a code can be replayed within that window. PKCE makes this
  hard to exploit. Add a store (e.g. Vercel KV) if you need strict single use.
- Refresh tokens can't be revoked individually. Rotating `OAUTH_SECRET` invalidates every token.
- Anything that can make Claude call `commit_files` can change any branch of any installed repo. Use GitHub
  branch protection on repos where that matters.
- `mcp-handler` and `@modelcontextprotocol/sdk` are pinned to matching versions. Newer `mcp-handler` releases
  need a different SDK package and a different tool-registration API. Test before bumping either.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `forbidden` after GitHub login | `ALLOWED_GITHUB_ID` doesn't match your account's numeric ID |
| `bad state` on callback | The `gh_nonce` cookie was blocked or expired (10 minute limit) |
| `github auth failed` | Wrong client ID/secret, or the callback URL doesn't match `BASE_URL` |
| 401 from `/api/mcp` | Missing or expired access token; reconnect the connector |
| `Resource not accessible by integration` | The App isn't installed on that repo, or lacks Contents: write |
| Invalid key / PEM errors | `GITHUB_APP_PRIVATE_KEY` lost its `\n` newlines when pasted |
