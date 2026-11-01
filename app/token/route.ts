import { createHash } from "crypto";
import { sign, verify } from "@/lib/jwt";

const bad = (e = "invalid_grant") => Response.json({ error: e }, { status: 400 });
const issue = async (sub: string, client_id: string) => Response.json({
  access_token: await sign({ sub, client_id }, "access", "1h"),
  refresh_token: await sign({ sub, client_id }, "refresh", "30d"),
  token_type: "Bearer", expires_in: 3600,
});

export async function POST(req: Request) {
  const f = await req.formData();
  const grant = f.get("grant_type");

  if (grant === "authorization_code") {
    const c = await verify(String(f.get("code")), "code").catch(() => null);
    if (!c || c.client_id !== f.get("client_id") || c.redirect !== f.get("redirect_uri")) return bad();
    const hash = createHash("sha256").update(String(f.get("code_verifier"))).digest("base64url");
    if (hash !== c.challenge) return bad();
    return issue(String(c.sub), String(c.client_id));
  }
  if (grant === "refresh_token") {
    const r = await verify(String(f.get("refresh_token")), "refresh").catch(() => null);
    if (!r) return bad();
    return issue(String(r.sub), String(r.client_id));
  }
  return bad("unsupported_grant_type");
}
