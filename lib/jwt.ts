import { SignJWT, jwtVerify } from "jose";

const key = new TextEncoder().encode(process.env.OAUTH_SECRET!);

export const sign = (payload: Record<string, unknown>, aud: string, ttl: string) =>
  new SignJWT(payload).setProtectedHeader({ alg: "HS256" })
    .setAudience(aud).setIssuedAt().setExpirationTime(ttl).sign(key);

export const verify = async (token: string, aud: string) =>
  (await jwtVerify(token, key, { audience: aud })).payload;
