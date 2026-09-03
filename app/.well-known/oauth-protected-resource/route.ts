// RFC 9728 - OAuth 2.0 Protected Resource Metadata
export const dynamic = 'force-dynamic'
export function GET() {
  const base = 'https://www.pujaraandco.com'
  return Response.json({
    resource: `${base}/api/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    resource_documentation: `${base}/api/mcp`,
  })
}
