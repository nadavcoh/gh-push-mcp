import { sign, verify } from "@/lib/jwt";

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const st = await verify(p.get("state") ?? "", "gh-state").catch(() => null);
  const nonce = req.headers.get("cookie")?.match(/gh_nonce=([^;]+)/)?.[1];
  if (!st || st.nonce !== nonce) return new Response("bad state", { status: 400 });

  const tok = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID, client_secret: process.env.GITHUB_CLIENT_SECRET,
      code: p.get("code"), redirect_uri: `${process.env.BASE_URL}/callback/github`,
    }),
  }).then(r => r.json());
  if (!tok.access_token) return new Response("github auth failed", { status: 400 });

  const user = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${tok.access_token}`, "User-Agent": "gh-push-mcp" },
  }).then(r => r.json());
  if (String(user.id) !== process.env.ALLOWED_GITHUB_ID)
    return new Response("forbidden", { status: 403 });

  const code = await sign({
    client_id: st.client_id, redirect: st.redirect, challenge: st.challenge, sub: String(user.id),
  }, "code", "2m");
  const back = new URL(st.redirect as string);
  back.searchParams.set("code", code);
  if (st.cstate) back.searchParams.set("state", st.cstate as string);
  return Response.redirect(back.toString(), 302);
}
