export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

import crypto from 'crypto'

// Sign codes so token endpoint can verify without needing shared state.
function signCode(payload: any): string {
  const secret = process.env.MCP_KEY || 'unset'
  const json = JSON.stringify(payload)
  const b64 = Buffer.from(json).toString('base64url')
  const sig = crypto.createHmac('sha256', secret).update(b64).digest('base64url')
  return `${b64}.${sig}`
}

// Show a tiny approval page. User clicks Approve, we redirect back with code.
export function GET(req: Request) {
  const url = new URL(req.url)
  const params = url.searchParams
  const clientId = params.get('client_id') || ''
  const redirectUri = params.get('redirect_uri') || ''
  const state = params.get('state') || ''
  const cc = params.get('code_challenge') || ''
  const ccm = params.get('code_challenge_method') || 'plain'

  if (!redirectUri) return new Response('missing redirect_uri', { status: 400 })

  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, state, code_challenge: cc, code_challenge_method: ccm })

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Authorize — Pujara Tracker MCP</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0e1e33;color:#fff;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center}
  .card{background:#fff;color:#222;border-radius:8px;padding:32px;max-width:420px;box-shadow:0 8px 40px rgba(0,0,0,.3)}
  h1{margin:0 0 12px;font-size:18px}
  p{color:#555;line-height:1.5;font-size:14px}
  .btn{display:inline-block;padding:10px 24px;border:0;border-radius:5px;background:#185FA5;color:#fff;font-size:14px;cursor:pointer;text-decoration:none}
  .btn.gray{background:#666;margin-left:8px}
  .who{font-size:12px;color:#888;margin-top:16px}
</style></head><body>
<div class="card">
  <h1>Authorize Claude to access Pujara Tracker</h1>
  <p>You are about to grant Claude <b>Super Admin</b> access to your task tracker — full read and write, including creating, updating, and deleting tasks.</p>
  <p>Only approve if you initiated this connection request from Claude.</p>
  <form method="POST" action="/api/mcp-oauth/authorize?${q.toString()}" style="margin:16px 0 0">
    <button class="btn" type="submit">Approve</button>
    <a class="btn gray" href="about:blank">Cancel</a>
  </form>
  <div class="who">Client ID: ${clientId.slice(0,16)}…</div>
</div>
</body></html>`

  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
}

export function POST(req: Request) {
  const url = new URL(req.url)
  const clientId = url.searchParams.get('client_id') || ''
  const redirectUri = url.searchParams.get('redirect_uri') || ''
  const state = url.searchParams.get('state') || ''
  const cc = url.searchParams.get('code_challenge') || ''
  const ccm = url.searchParams.get('code_challenge_method') || 'plain'

  if (!redirectUri) return new Response('missing redirect_uri', { status: 400 })

  const code = signCode({ cid: clientId, cc, ccm, iat: Math.floor(Date.now()/1000) })

  const redir = new URL(redirectUri)
  redir.searchParams.set('code', code)
  if (state) redir.searchParams.set('state', state)

  return Response.redirect(redir.toString(), 302)
}
