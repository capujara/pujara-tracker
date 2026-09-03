import { NextResponse } from 'next/server'
import { loadState, normalizeMobile, normalizeMpin, signToken, isCloudConfigured, BOOTSTRAP_MOBILE } from '@/lib/tracker'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  if (!isCloudConfigured()) return NextResponse.json({ error: 'Cloud storage not configured.' }, { status: 503 })
  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Bad JSON' }, { status: 400 }) }
  /* The MPIN (4 digits) is the only credential. A mobile number is no longer accepted:
     numbers are visible to every admin in Settings, so they were a poor secret. The one
     exception is first-run bootstrap below, which is reachable only while the tracker holds
     no data at all — without it, a wiped store could never be signed into again. */
  const mpin = normalizeMpin(body?.mpin)
  const mobile = normalizeMobile(body?.mobile)
  if (!mpin) {
    return NextResponse.json({ error: 'Enter your 4-digit MPIN.' }, { status: 400 })
  }
  let state: any
  try { state = await loadState() } catch (e: any) {
    return NextResponse.json({ error: 'Storage error: ' + String(e?.message || e) }, { status: 500 })
  }
  if (!state || !state.roleMobile || Object.keys(state.roleMobile).length === 0) {
    if (mobile === BOOTSTRAP_MOBILE) {
      return NextResponse.json({ token: signToken('Super Admin'), user: 'Super Admin', bootstrap: true })
    }
    return NextResponse.json({ error: 'Tracker not yet initialised. Mitul must log in first.' }, { status: 403 })
  }
  for (const [role, p] of Object.entries(state.roleMpin || {})) {
    if (normalizeMpin(p) && normalizeMpin(p) === mpin) {
      return NextResponse.json({ token: signToken(role), user: role })
    }
  }
  return NextResponse.json({ error: 'MPIN not recognised. Ask admin to set your MPIN in Settings.' }, { status: 401 })
}
