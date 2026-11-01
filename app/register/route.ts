import { sign } from "@/lib/jwt";

const okUri = (u: string) => u.startsWith("https://claude.ai/") || u.startsWith("https://claude.com/");

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const uris: string[] = body.redirect_uris ?? [];
  if (!uris.length || !uris.every(okUri))
    return Response.json({ error: "invalid_redirect_uri" }, { status: 400 });
  const client_id = await sign({ redirect_uris: uris }, "client", "365d");
  return Response.json({
    client_id, redirect_uris: uris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  }, { status: 201 });
}
