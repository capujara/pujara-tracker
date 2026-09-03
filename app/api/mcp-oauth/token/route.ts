export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

import crypto from 'crypto'

function verifyCode(code: string): { cid: string; cc: string; ccm: string; iat: number } | null {
  const secret = process.env.MCP_KEY || 'unset'
  const [b64, sig] = code.split('.')
  if (!b64 || !sig) return null
  const expected = crypto.createHmac('sha256', secret).update(b64).digest('base64url')
  if (expected !== sig) return null
  try {
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'))
    if (Math.floor(Date.now()/1000) - payload.iat > 600) return null // 10 min expiry
    return payload
  } catch { return null }
}

export async function POST(req: Request) {
  const mcpKey = process.env.MCP_KEY
  if (!mcpKey) return Response.json({ error: 'server_error', error_description: 'MCP_KEY not configured' }, { status: 500 })

  const ct = req.headers.get('content-type') || ''
  let form: URLSearchParams
  if (ct.includes('application/json')) {
    const j = await req.json().catch(() => ({}))
    form = new URLSearchParams(j as any)
  } else {
    const text = await req.text()
    form = new URLSearchParams(text)
  }

  const grantType = form.get('grant_type')
  const code = form.get('code') || ''
  const verifier = form.get('code_verifier') || ''

  if (grantType !== 'authorization_code') {
    return Response.json({ error: 'unsupported_grant_type' }, { status: 400 })
  }

  const payload = verifyCode(code)
  if (!payload) return Response.json({ error: 'invalid_grant' }, { status: 400 })

  // PKCE verification
  if (payload.cc) {
    let computed: string
    if (payload.ccm === 'S256') {
      computed = crypto.createHash('sha256').update(verifier).digest('base64url')
    } else {
      computed = verifier
    }
    if (computed !== payload.cc) {
      return Response.json({ error: 'invalid_grant', error_description: 'PKCE mismatch' }, { status: 400 })
    }
  }

  // Success — hand out the real MCP_KEY as the access token
  return Response.json({
    access_token: mcpKey,
    token_type: 'Bearer',
    expires_in: 60 * 60 * 24 * 365, // 1 year
    scope: 'mcp',
  })
}

export function GET() {
  return new Response('POST to exchange code for token', { status: 405 })
}
