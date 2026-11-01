const B = process.env.BASE_URL!;
const cors = { "Access-Control-Allow-Origin": "*" };

export const GET = () => Response.json({
  issuer: B,
  authorization_endpoint: `${B}/authorize`,
  token_endpoint: `${B}/token`,
  registration_endpoint: `${B}/register`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
}, { headers: cors });

export const OPTIONS = () => new Response(null, { headers: { ...cors, "Access-Control-Allow-Headers": "*" } });
