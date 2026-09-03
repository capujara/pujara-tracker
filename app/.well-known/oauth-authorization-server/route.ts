// RFC 8414 - OAuth 2.0 Authorization Server Metadata
export const dynamic = 'force-dynamic'
export function GET() {
  const base = 'https://www.pujaraandco.com'
  return Response.json({
    issuer: base,
    authorization_endpoint: `${base}/api/mcp-oauth/authorize`,
    token_endpoint: `${base}/api/mcp-oauth/token`,
    registration_endpoint: `${base}/api/mcp-oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256', 'plain'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
  })
}
