import { NextResponse } from 'next/server'
import { head, put } from '@vercel/blob'
import { authFromRequest } from '@/lib/tracker'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STATE_PATH = 'pujara-tracker-state.json'
const KV_KEY = 'pujara:tracker:state'

export async function POST(req: Request) {
  /* Super Admin only */
  const sess = authFromRequest(req)
  if (!sess || sess.user !== 'Super Admin') {
    return NextResponse.json({ error: 'Forbidden — Super Admin only' }, { status: 403 })
  }
  /* Read state from Blob */
  let blobState: any = null
  try {
    const info = await head(STATE_PATH)
    const res = await fetch(info.url + '?_=' + Date.now(), { cache: 'no-store' })
    if (res.ok) blobState = await res.json()
  } catch (e: any) {
    return NextResponse.json({ error: 'Blob read failed: ' + String(e?.message || e) }, { status: 500 })
  }
  if (!blobState) return NextResponse.json({ error: 'No state in Blob to migrate' }, { status: 404 })
  /* Write to KV */
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return NextResponse.json({ error: 'KV not configured' }, { status: 503 })
  try {
    const res = await fetch(`${url.replace(/\/$/,'')}/set/${encodeURIComponent(KV_KEY)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(blobState),
    })
    if (!res.ok) {
      return NextResponse.json({ error: 'KV write failed: ' + (await res.text()) }, { status: 500 })
    }
    return NextResponse.json({
      ok: true,
      migrated: {
        tasks: (blobState.tasks || []).length,
        clients: (blobState.clients || []).length,
        employees: (blobState.employees || []).length,
        activityLogEntries: (blobState.activityLog || []).length,
        roleMobiles: Object.keys(blobState.roleMobile || {}).length,
      },
    })
  } catch (e: any) {
    return NextResponse.json({ error: 'KV write error: ' + String(e?.message || e) }, { status: 500 })
  }
}
