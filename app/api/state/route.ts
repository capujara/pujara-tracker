import { NextResponse } from 'next/server'
import { loadState, saveStateMerged, isCloudConfigured, authFromRequest, TRACKER_VERSION, etagOf } from '@/lib/tracker'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/* Server-side privacy: Super Admin's tasks are stripped from the payload for everyone else.
   Safe because saveStateMerged() merges by task id — a non-super user POSTing back their
   (filtered) task list never drops Super Admin's tasks: the merge keeps cloud-only tasks. */
function filterStateForUser(state: any, user: string): any {
  if (!state || user === 'Super Admin') return state
  const out: any = { ...state }
  const superTaskIds = new Set(
    (state.tasks || []).filter((t: any) => t && t.assignee === 'Super Admin').map((t: any) => t.id)
  )
  /* Drop Super Admin's tasks entirely */
  out.tasks = (state.tasks || []).filter((t: any) => t && t.assignee !== 'Super Admin')
  /* Drop activity-log entries that reference Super Admin's tasks */
  out.activityLog = (state.activityLog || []).filter((a: any) => a && !superTaskIds.has(a.taskId))
  /* Mitul's personal to-do list is private — never send it to anyone else */
  delete out.superTodos
  /* Fees management data is Super Admin only */
  delete out.feesEntries
  /* Login MPINs are managed by Super Admin only — never sent to anyone else */
  delete out.roleMpin
  return out
}

export async function GET(req: Request) {
  if (!isCloudConfigured()) return NextResponse.json({ error: 'Cloud storage not configured.' }, { status: 503 })
  const sess = authFromRequest(req)
  if (!sess) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const state = await loadState()
    const safe = state ? filterStateForUser(state, sess.user) : null
    const rev = etagOf(safe)
    /* Conditional poll: if the client already holds this exact revision, answer with a tiny
       body instead of re-sending the whole state. Idle office tabs poll constantly, so this
       is what keeps Fast Origin Transfer flat regardless of poll frequency. */
    const inm = req.headers.get('if-none-match')
    if (inm && inm === rev) {
      return NextResponse.json({ unchanged: true, user: sess.user, version: TRACKER_VERSION, rev })
    }
    return NextResponse.json({ state: safe, user: sess.user, version: TRACKER_VERSION, rev })
  } catch (e: any) {
    return NextResponse.json({ error: 'Storage error', details: String(e?.message || e) }, { status: 500 })
  }
}

export async function POST(req: Request) {
  if (!isCloudConfigured()) return NextResponse.json({ error: 'Cloud storage not configured.' }, { status: 503 })
  const sess = authFromRequest(req)
  if (!sess) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Bad JSON' }, { status: 400 }) }
  if (!body?.state || !Array.isArray(body.state.tasks)) {
    return NextResponse.json({ error: 'Invalid state' }, { status: 400 })
  }
  try {
    /* Server-side privacy: only Super Admin may write superTodos. Everyone else's
       POST will have superTodos stripped before merge, so the cloud's copy survives. */
    if (sess.user !== 'Super Admin') {
      delete body.state.superTodos
      delete body.state.feesEntries
      delete body.state.roleMpin
    }
    const merged = await saveStateMerged(body.state)
    /* Echo back a filtered view so a non-super client never receives Super Admin tasks */
    const safe = filterStateForUser(merged, sess.user)
    return NextResponse.json({ ok: true, state: safe, version: TRACKER_VERSION, rev: etagOf(safe) })
  } catch (e: any) {
    return NextResponse.json({ error: 'Storage error', details: String(e?.message || e) }, { status: 500 })
  }
}
