import { sign, verify } from "@/lib/jwt";

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const client = await verify(p.get("client_id") ?? "", "client").catch(() => null);
  const redirect = p.get("redirect_uri") ?? "";
  if (!client || !(client.redirect_uris as string[]).includes(redirect) ||
      p.get("response_type") !== "code" || p.get("code_challenge_method") !== "S256" ||
      !p.get("code_challenge"))
    return new Response("bad request", { status: 400 });

  const nonce = crypto.randomUUID();
  const state = await sign({
    client_id: p.get("client_id"), redirect, nonce,
    challenge: p.get("code_challenge"), cstate: p.get("state"),
  }, "gh-state", "10m");

  const gh = new URL("https://github.com/login/oauth/authorize");
  gh.searchParams.set("client_id", process.env.GITHUB_CLIENT_ID!);
  gh.searchParams.set("redirect_uri", `${process.env.BASE_URL}/callback/github`);
  gh.searchParams.set("state", state);
  return new Response(null, {
    status: 302,
    headers: { Location: gh.toString(), "Set-Cookie": `gh_nonce=${nonce}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600` },
  });
}
