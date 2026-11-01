# gh-push-mcp

MCP connector (Next.js on Vercel) that lets Claude push commits to GitHub.
Self-contained OAuth 2.1 (PKCE + dynamic client registration), GitHub login restricted to one user ID,
pushes made with a GitHub App installation token. MCP endpoint: `/api/mcp`.
See `.env.example` for required environment variables.
