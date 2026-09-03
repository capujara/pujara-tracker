export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

import crypto from 'crypto'

export async function POST(req: Request) {
  let body: any = {}
  try { body = await req.json() } catch {}
  const clientId = 'mcp_' + crypto.randomBytes(12).toString('hex')
  return Response.json({
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: body.redirect_uris || [],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: 'mcp',
  })
}

export function GET() {
  return new Response('POST to register a client', { status: 405 })
}
