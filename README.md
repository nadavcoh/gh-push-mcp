# gh-push-mcp

A small MCP server that lets Claude inspect, edit and push to your GitHub repos. It runs as a Next.js app on Vercel,
protects itself with OAuth 2.1, and works through a GitHub App installation token, so no long-lived personal
access token ever sits in a chat, a skill, or a config file. It can read repos, edit files in place, commit and
delete files, and hand Claude's sandbox a short-lived token for real git.

- **MCP endpoint:** `/api/mcp` (Streamable HTTP)
- **Auth:** built-in OAuth 2.1 server (PKCE + dynamic client registration), login restricted to one GitHub user ID
- **GitHub access:** GitHub App installation token, scoped to the repos you install the App on

## Tools

| Tool | What it does |
|---|---|
| `list_branches(repo)` | Lists branches with head SHAs and shows the default branch. Read-only. |
| `list_commits(repo, ref?, limit?)` | Recent commits (newest first, max 50) plus the full head SHA. Read-only. |
| `list_files(repo, ref?, path?)` | Every file at a ref with sizes, optionally under a directory (max 1000 shown). Read-only. |
| `read_file(repo, path, ref?)` | One text file at a ref, truncated at 100k characters. Binary files aren't shown. Read-only. |
| `git_credentials(repo, mode?)` | Issues a short-lived (about 1 hour) GitHub token limited to one repo and Contents read or write, for using real git from Claude's sandbox. `mode` is `read` (default) or `write`. |
| `create_branch(repo, branch, from?)` | Creates a branch from `from`, or from the repo's default branch if omitted. |
| `edit_file(repo, branch, path, edits[], message)` | Edits one existing text file in place. Each edit is `{ old_str, new_str, replace_all? }`, and `old_str` must match exactly once unless `replace_all` is set. Send only the changed snippets instead of the whole file. |
| `commit_files(repo, branch, message, files[], delete[]?)` | Writes up to 100 files and/or deletes up to 100 paths in a single commit via the Git Data API. Each file is `{ path, content, encoding }` with `encoding` of `utf-8` or `base64`. |

`repo` can be a bare name (owner defaults to `GITHUB_OWNER`) or `owner/name`.

`edit_file` and `commit_files` build the commit on the branch head they just read and update the ref with
`force: false`, so they fail instead of overwriting if the branch moved in the meantime.

The server's instructions (the `INSTRUCTIONS` constant in `app/api/[transport]/route.ts`) tell Claude to clone and
inspect a repo before pushing. The read tools cover clients that can't clone. The instructions also steer Claude to
the cheapest tool for the job:

- **Small change to an existing file:** `edit_file`, which sends only the changed snippets.
- **A few new files, or deletions:** `commit_files`.
- **Many, large or binary files, or cloning a private repo:** `git_credentials`, then real git.

### Using real git

Call `git_credentials` with `mode` set to `read` to clone and inspect, and `write` only when ready to push. Pass the
token to git through a header, never in a URL, and never print or store it:

```bash
H="Authorization: Basic $(printf 'x-access-token:%s' "$TOKEN" | base64 -w0)"
git -c credential.helper= -c http.extraheader="$H" clone https://github.com/<owner>/<repo>.git
```

The token covers one repo and Contents only, and GitHub expires it after about an hour. Use the repo's current name:
a renamed repo is rejected until you use the new name. The sandbox must be able to reach `github.com`.

Writes to `main`, `master` and the default branch are allowed. Force-pushes are not: refs are updated with
`force: false`. Paths that are absolute, contain `..`, start with `.git/`, or start with `.github/workflows` (except `deploy.yml` and `deploy-*.yml` directly in that folder)
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
- **Repository permissions:** Contents: Read and write (Metadata: Read is added automatically). Also set **Workflows: Read and write** if Claude should push `deploy*.yml` workflow files; GitHub rejects any push that touches workflow files without it, and you must accept the updated permissions on the installation
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
BASE_URL=https://example.com OAUTH_SECRET=x npm run build   # also checks route export types; run before pushing
```

For the OAuth flow to work locally, `BASE_URL` must be a public HTTPS URL (a tunnel works), and the GitHub App's
callback URL must match it.

## Security notes

- Only the GitHub account whose numeric ID is in `ALLOWED_GITHUB_ID` can sign in. IDs are used rather than
  usernames because usernames can be renamed and reclaimed.
- The App can only touch repos it is installed on. Keep the installation on "Only select repositories".
- Workflow files can run code with a repo's secrets. Only top-level `deploy.yml` and `deploy-*.yml` are writable (`DEPLOY_WORKFLOW` in `lib/github.ts`), and only if the App has Workflows: write. Every other path under `.github/workflows` is blocked. Workflow files are not covered by Contents-only tokens from `git_credentials`, so raw git can't push them either.
- Auth codes are stateless and valid for 2 minutes, so a code can be replayed within that window. PKCE makes this
  hard to exploit. Add a store (e.g. Vercel KV) if you need strict single use.
- Refresh tokens can't be revoked individually. Rotating `OAUTH_SECRET` invalidates every token.
- Anything that can make Claude call `commit_files` can change any branch of any installed repo. Use GitHub
  branch protection on repos where that matters.
- `git_credentials` issues GitHub App installation tokens limited to one repo and Contents read or write, valid for
  about an hour. A write token allows raw git, which bypasses the `force: false` guard (force-pushes and branch
  deletion). Add a GitHub branch protection rule or ruleset on important branches to block both. Issuance is logged
  (repo and mode only, never the token).
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
| `...does not exist or is not accessible to the parent installation` (from `git_credentials`) | The repo name is wrong or was renamed (use the current name), or the App isn't installed on it |
| `Not Found ... get-a-reference` | The branch doesn't exist, or the repo name is wrong or not installed |
| `Edit N: old_str not found` or `old_str matches N times` | `edit_file` needs each `old_str` to match exactly once; add surrounding context or set `replace_all` |
| `Cannot delete, not found on <branch>` | A path in `delete` doesn't exist on that branch |
| `Path is both written and deleted` | The same path is in both `files` and `delete` |
| A new tool doesn't show up in an open chat | Clients read the tool list when they connect; reconnect the connector or start a new chat |
| `Bad path: .github/workflows/...` | Only top-level `deploy.yml` and `deploy-*.yml` are allowed there; `checkPath` blocks other workflow names |
| GitHub rejects a pushed workflow file | The App lacks Workflows: Read and write, or the updated permissions weren't accepted on the installation |
| Invalid key / PEM errors | `GITHUB_APP_PRIVATE_KEY` lost its `\n` newlines when pasted |
