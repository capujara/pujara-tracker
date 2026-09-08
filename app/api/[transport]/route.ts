// app/api/[transport]/route.ts
// ---------------------------------------------------------------------------
// Pujara & Co. Task Tracker — MCP server (Super Admin, full read/write)
//
// Lives INSIDE the existing Next.js repo, so it talks to lib/tracker.ts
// directly (loadState / saveStateMerged). No login, no token, no mobile
// number in code. Every write goes through the same locked merge the web
// app uses, so it will not clobber a staffer editing in the browser.
//
// Everything the tools report is derived the same way public/tracker.html
// derives it (status groups, display names, module status codes, "current
// period" defaults). The constants below are mirrored from that file — keep
// them in step when the tracker changes.
//
// SAFETY NET: before every write, the current state is snapshotted to a
// backup KV key. `undo_last_change` restores it. This reverts the single
// most recent write only.
//
// Endpoint after deploy:  https://www.pujaraandco.com/api/mcp
// ---------------------------------------------------------------------------

import { createMcpHandler, withMcpAuth } from 'mcp-handler'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import { z } from 'zod'
import { loadState, saveStateMerged } from '@/lib/tracker'

/* ---------- Task statuses (tracker.html: STATUSES / ACTIVE_STATUSES / CLOSED_STATUSES) ---------- */
const STATUSES = [
  'Not Started',
  'In Progress',
  'On Hold',
  'Ready for Review',
  'Ready to File',
  'Done',
  'To Be Billed',
  'Billed',
  'Not to Bill',
  'Received',
] as const
type Status = (typeof STATUSES)[number]

/* "Pending" on the dashboard = work still with staff. Done/Ready to File and every
   billing stage are closed work. Billing stages track the fee, not the work. */
const STATUS_GROUPS: Record<string, readonly Status[]> = {
  active: ['Not Started', 'In Progress', 'On Hold', 'Ready for Review'],
  closed: ['Done', 'Billed', 'Not to Bill', 'Received', 'Ready to File'],
  billing: ['To Be Billed', 'Billed', 'Not to Bill', 'Received'],
  billed_unpaid: ['Billed'],
}
const GROUP_NAMES = ['active', 'closed', 'billing', 'billed_unpaid'] as const

/* Roles that are admins in the tracker (tracker.html: ADMINS) and the default
   display names it seeds on first install. state.empNames overrides these. */
const ADMINS = ['Super Admin', 'Admin', 'Admin 2', 'Admin 3', 'Emp 10']
const DEFAULT_NAMES: Record<string, string> = {
  'Super Admin': 'Mitul',
  Admin: 'Shubh',
  'Admin 2': 'Sunil',
  'Admin 3': 'Hitakshi',
}

/* ---------- Module status codes -> labels (mirrored from tracker.html) ---------- */
const GST_G1: Record<string, string> = { NS: 'Not started', IP: 'In progress', OH: 'On hold', F: 'Filed' }
const GST_B3: Record<string, string> = {
  PEND: 'Not started', PROC: 'In process', '2B': '2B Sent', RECO: 'Reco Sent',
  CHLN: 'Challan Saved', FILED: 'Filed', NOTAX: 'No Tax',
}
const GST_B3_DONE = ['FILED', 'NOTAX']
const GST_MSEQ = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const GC_DS: Record<string, string> = { NS: 'Not started', CALL: 'Called', RECD: 'Received', NIL: 'Nil' }
const GC_RECD: Record<string, string> = { PEND: 'Pending', RECD: 'Received', NIL: 'Nil', NA: 'NA' }
const GC_CS: Record<string, string> = { NS: 'Not started', SENT: 'Sent', DONE: 'Paid', NA: 'NA' }
const GC_FL: Record<string, string> = { NF: 'Not filed', F: 'Filed' }
const GC_MONEY: [string, string][] = [
  ['cd', 'bankCashDeposit'], ['oc', 'bankOtherThanCash'], ['st', 'saleTaxable'],
  ['sz', 'saleZeroExempt'], ['pa', 'purchaseAmount'], ['p4', 'purchaseAsPer4A'], ['ca', 'challanAmount'],
]

const TDS_D: Record<string, string> = { PEND: 'Pending', RECD: 'Received', REQ: 'Data requested', QEND: 'At qtr-end', ND: 'No data' }
const TDS_P: Record<string, string> = { PEND: 'Pending', PAID: 'Paid', CP: 'Client paying', IP: 'In progress', OH: 'On hold', NA: 'NA' }
const TDS_RD: Record<string, string> = { PEND: 'Pending', RECD: 'Received', ND: 'No data' }
const TDS_RF: Record<string, string> = { PEND: 'Pending', IP: 'In progress', F: 'Filed', NA: 'NA' }
const TDS_F16: Record<string, string> = { PEND: 'Pending', REQ: 'Requested', ERR: 'Error', SENT: 'Sent to client', NA: 'NA' }
const TDS_MN = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const TDS_MCAP = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const TDS_BASE_FY = 2026

const AF_STAGES = ['Not Started', 'In Progress', 'Data Finalized', 'Financials Ready', 'Report Ready', 'Filed'] as const
const AF_CHECKS = [
  'Opening balance match', 'GST matching', 'TDS recv vs 26AS/AIS', 'Debtors/creditors scrutiny',
  'TDS compliance (194T)', 'P&L & B/S scrutiny', 'Bank/loan closing & interest',
  'Closing stock & tax provision', 'Cash >10k / receipt >2L', 'Deferred tax',
]

const BY = 'AI (Super Admin)'
const nowISO = () => new Date().toISOString()
const genId = () =>
  'ai_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)

type Task = {
  id: string
  task?: string
  client?: string
  assignee?: string
  status?: string
  remarks?: string
  holdReason?: string
  amount?: number
  mt?: number
  createdAt?: number
  deleted?: boolean
  deletedAt?: number
}

// ---------------------------------------------------------------------------
// Direct Upstash KV access — ONLY for the snapshot/undo safety net.
// Uses the same env vars and key as lib/tracker.ts. All normal reads/writes
// still go through lib/tracker.ts (loadState / saveStateMerged).
// ---------------------------------------------------------------------------
const KV_KEY = 'pujara:tracker:state'
const BACKUP_KEY = 'pujara:tracker:state:prev'

function kv(): { url: string; token: string } | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return null
  return { url: url.replace(/\/$/, ''), token }
}

async function kvCmd(cmd: any[]): Promise<any> {
  const k = kv()
  if (!k) throw new Error('KV not configured')
  const res = await fetch(k.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${k.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`KV ${res.status}: ${await res.text()}`)
  return (await res.json()).result
}

// Copy current live state -> backup key. Never blocks the actual write.
async function snapshot(): Promise<boolean> {
  try {
    if (!kv()) return false
    const cur = await kvCmd(['GET', KV_KEY])
    if (cur == null) return false
    const val = typeof cur === 'string' ? cur : JSON.stringify(cur)
    await kvCmd(['SET', BACKUP_KEY, val])
    return true
  } catch {
    return false
  }
}

// Restore the backup over the live key (raw overwrite — bypasses merge, by design).
async function restore(): Promise<boolean> {
  if (!kv()) return false
  const b = await kvCmd(['GET', BACKUP_KEY])
  if (b == null) return false
  const val = typeof b === 'string' ? b : JSON.stringify(b)
  await kvCmd(['SET', KV_KEY, val])
  return true
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function readState(): Promise<any> {
  return (await loadState()) || { tasks: [] }
}

const lc = (s: any) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
const has = (hay: any, needle?: string) => !needle || lc(hay).includes(lc(needle))
const day = (ts: any): string | null => {
  const n = typeof ts === 'string' ? Date.parse(ts) : Number(ts)
  if (!n || isNaN(n)) return null
  return new Date(n).toISOString().slice(0, 10)
}
const daysAgo = (ts: any): number | null => {
  const n = typeof ts === 'string' ? Date.parse(ts) : Number(ts)
  if (!n || isNaN(n)) return null
  return Math.floor((Date.now() - n) / 86400000)
}
const text = (obj: any) => ({
  content: [{ type: 'text' as const, text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }],
})

/* Role slot ("Emp 5", "Admin 3") -> the person's display name ("Hitakshi"). */
function nameMap(state: any): Record<string, string> {
  return { ...DEFAULT_NAMES, ...(state.empNames || {}) }
}
function makeNames(state: any) {
  const map = nameMap(state)
  const dn = (role: any) => (role ? String(map[String(role)] || role) : '')
  /* match on either the display name or the role slot, partial + case-insensitive */
  const match = (role: any, q?: string) => !q || has(dn(role), q) || has(role, q)
  return { map, dn, match }
}

function liveTasks(state: any): Task[] {
  return (state.tasks || []).filter((t: any) => t && !t.deleted)
}

/* Everyone who can hold work: named roles, roles with tasks, and the admins. */
function people(state: any) {
  const { dn } = makeNames(state)
  const roles = new Set<string>()
  for (const r of ADMINS) roles.add(r)
  for (const r of state.employees || []) roles.add(String(r))
  for (const r of Object.keys(state.empNames || {})) if (state.empNames[r]) roles.add(r)
  for (const t of liveTasks(state)) if (t.assignee) roles.add(String(t.assignee))
  return Array.from(roles).map((role) => ({
    role, name: dn(role), isAdmin: ADMINS.includes(role),
  }))
}

/* A person given by name ("Hitakshi") or by role ("Admin 3", "emp_2") -> the role slot the
   tracker stores on the task. Exact match first, then unique partial match. */
function resolveRole(state: any, who: string): string | null {
  const q = lc(who)
  if (!q) return null
  const all = people(state)
  const exact = all.find((p) => lc(p.role) === q || lc(p.name) === q)
  if (exact) return exact.role
  const part = all.filter((p) => lc(p.role).includes(q) || lc(p.name).includes(q))
  return part.length === 1 ? part[0].role : null
}

function slim(t: Task, dn: (r: any) => string) {
  const out: any = {
    id: t.id,
    task: t.task,
    client: t.client,
    assignee: dn(t.assignee),
    role: t.assignee,
    status: t.status,
    remarks: t.remarks || '',
  }
  if (t.holdReason) out.holdReason = t.holdReason
  if (t.amount != null) out.amount = t.amount
  out.created = day(t.createdAt)
  out.updated = day(t.mt)
  out.daysSinceUpdate = daysAgo(t.mt)
  return out
}

/* ---------- period helpers (same rules as the tracker's "current period" pickers) ---------- */
function gstMonthKey(m: string): number {
  const [mo, yr] = String(m).split(' ')
  return (2000 + Number(yr || 0)) * 12 + Math.max(0, GST_MSEQ.indexOf(mo))
}
function gstPeriods(state: any): string[] {
  const out = (state.gstPeriods || []).filter((p: any) => p && !p.del).map((p: any) => String(p.id))
  return (out.length ? out : ['Sep 26']).sort((a: string, b: string) => gstMonthKey(a) - gstMonthKey(b))
}
function gstDefaultPeriod(state: any): string {
  const ms = gstPeriods(state)
  const d = new Date(), p = new Date(d.getFullYear(), d.getMonth() - 1, 1)
  const want = GST_MSEQ[p.getMonth()] + ' ' + String(p.getFullYear()).slice(2)
  if (ms.includes(want)) return want
  const past = ms.filter((m) => gstMonthKey(m) <= gstMonthKey(want))
  return past.length ? past[past.length - 1] : ms[ms.length - 1]
}

function gcQParse(id: string) {
  const m = String(id).match(/^(\d{4})-(\d{2})-Q([1-4])$/)
  return m ? { start: +m[1], q: +m[3] } : null
}
function gcQKey(id: string) { const p = gcQParse(id); return p ? p.start * 4 + p.q : 0 }
function gcQuarters(state: any): string[] {
  const out = (state.gcQuarters || []).filter((p: any) => p && !p.del).map((p: any) => String(p.id))
  return (out.length ? out : ['2026-27-Q1']).sort((a: string, b: string) => gcQKey(a) - gcQKey(b))
}
function gcDefaultQuarter(state: any): string {
  const qs = gcQuarters(state)
  const d = new Date(), m = d.getMonth(), y = d.getFullYear()
  const q = m < 3 ? 4 : m < 6 ? 1 : m < 9 ? 2 : 3
  const prevQ = q === 1 ? 4 : q - 1
  let start = m < 3 ? y - 1 : y
  if (q === 1) start -= 1
  const want = start + '-' + String((start + 1) % 100).padStart(2, '0') + '-Q' + prevQ
  if (qs.includes(want)) return want
  const past = qs.filter((x) => gcQKey(x) <= gcQKey(want))
  return past.length ? past[past.length - 1] : qs[qs.length - 1]
}

function tdsParse(id: string) {
  const m = /^([a-z]{3})(\d{2})?$/.exec(String(id || ''))
  const mi = m ? TDS_MN.indexOf(m[1]) : -1
  if (!m || mi < 0) return null
  const y = m[2] ? 2000 + Number(m[2]) : mi >= 3 ? TDS_BASE_FY : TDS_BASE_FY + 1
  return { mi, y }
}
function tdsKey(id: string) { const p = tdsParse(id); return p ? p.y * 12 + p.mi : 0 }
function tdsIdFor(y: number, mi: number) {
  const inBase = (mi >= 3 && y === TDS_BASE_FY) || (mi < 3 && y === TDS_BASE_FY + 1)
  return TDS_MN[mi] + (inBase ? '' : String(y % 100))
}
function tdsMeta(id: string) {
  const p = tdsParse(id)
  if (!p) return null
  const fy = p.mi >= 3 ? p.y : p.y - 1
  const qn = Math.floor(((p.mi + 9) % 12) / 3) + 1
  const qEnd = p.mi === 5 || p.mi === 8 || p.mi === 11 || p.mi === 2
  const qEndMi = [5, 8, 11, 2][qn - 1]
  const qEndId = tdsIdFor(qEndMi < 3 ? fy + 1 : fy, qEndMi)
  const nmi = (p.mi + 1) % 12, ny = nmi === 0 ? p.y + 1 : p.y
  const payBy = p.mi === 2 ? '30 Apr ' + (p.y % 100) : '7 ' + TDS_MCAP[nmi] + ' ' + (ny % 100)
  const fMi = [6, 9, 0, 4][qn - 1]
  const fY = fMi < 3 || fMi === 4 ? fy + 1 : fy
  const fileBy = '31 ' + TDS_MCAP[fMi] + ' ' + (fY % 100)
  return {
    id, label: TDS_MCAP[p.mi] + ' ' + p.y,
    fy: fy + '-' + String((fy + 1) % 100).padStart(2, '0'),
    quarter: 'Q' + qn, qEnd, qEndId, payBy, fileBy,
  }
}
function tdsMonths(state: any): string[] {
  const dead = new Set((state.tdsPeriods || []).filter((p: any) => p && p.del).map((p: any) => String(p.id)))
  const ids = [3, 4, 5, 6, 7, 8, 9, 10, 11, 0, 1, 2]
    .map((mi) => tdsIdFor(mi >= 3 ? TDS_BASE_FY : TDS_BASE_FY + 1, mi))
    .filter((id) => !dead.has(id))
  for (const pr of state.tdsPeriods || []) {
    if (pr && !pr.del && tdsParse(String(pr.id)) && !ids.includes(String(pr.id))) ids.push(String(pr.id))
  }
  return ids.sort((a, b) => tdsKey(a) - tdsKey(b))
}
function tdsDefaultMonth(state: any): string {
  const list = tdsMonths(state)
  const now = new Date()
  const prevId = tdsIdFor(now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear(), (now.getMonth() + 11) % 12)
  if (list.includes(prevId)) return prevId
  const past = list.filter((id) => tdsKey(id) <= tdsKey(prevId))
  return past.length ? past[past.length - 1] : list[0]
}

/* ---------- module row builders ---------- */
function gstRowsFor(state: any, period: string, dn: (r: any) => string) {
  const clients: any[] = (state.gstClients || []).filter((c: any) => c && !c.deleted)
  const recs = new Map<string, any>()
  for (const r of state.gstRows || []) if (r && r.id != null) recs.set(String(r.id), r)
  return clients.map((c: any) => {
    const r = recs.get(c.k + '|' + period) || { s: 0, sd: '', g1: 'NS', pt: 0, ptd: '', b3: 'PEND', rem: '', rem1: '' }
    const g1 = r.g1 || 'NS', b3 = r.b3 || 'PEND'
    return {
      client: c.n, gstin: c.gst || '', contact: c.cp || '', mobile: c.ph || '',
      person: dn(c.p), role: c.p || '',
      filing: c.mq === 'Q' ? 'Quarterly' : 'Monthly',
      salesDataReceived: !!r.s, salesDataDate: r.sd || '',
      gstr1: GST_G1[g1] || g1,
      purchaseDataReceived: !!r.pt, purchaseDataDate: r.ptd || '',
      gstr3b: GST_B3[b3] || b3,
      settled: g1 === 'F' && GST_B3_DONE.includes(b3),
      remarks: r.rem || '', remarks2: r.rem1 || '',
    }
  })
}

function gcRowsFor(state: any, quarter: string, dn: (r: any) => string) {
  const clients: any[] = (state.gcClients || []).filter((c: any) => c && !c.deleted)
  const recs = new Map<string, any>()
  for (const r of state.gcRows || []) if (r && r.id != null && !r.deleted) recs.set(String(r.id), r)
  return clients.map((c: any) => {
    const r = recs.get(c.k + '|' + quarter) || {}
    const money: any = {}
    for (const [k, label] of GC_MONEY) money[label] = r[k] ?? ''
    return {
      client: c.n, gstin: c.gst || '', contact: c.cp || '', mobile: c.ph || '',
      person: dn(c.p), role: c.p || '',
      active: !c.act || c.act === 'A',
      data: GC_DS[r.ds] || r.ds || 'Not started', note: r.note || '',
      bankStatement: GC_RECD[r.bk] || r.bk || 'Pending',
      purchaseData: GC_RECD[r.pd] || r.pd || 'Pending',
      salesData: GC_RECD[r.sd] || r.sd || 'Pending',
      amounts: money,
      challan: GC_CS[r.cs] || r.cs || 'Not started',
      cmp08: GC_FL[r.fl] || r.fl || 'Not filed',
      remarks: r.rem || '',
    }
  })
}

function tdsRowsFor(state: any, month: string, dn: (r: any) => string) {
  const meta = tdsMeta(month)
  const clients: any[] = (state.tdsClients || []).filter((c: any) => c && !c.deleted)
  const rows = (state.tdsRows || []).filter((r: any) => r && !r.deleted)
  const rec = (k: string, m: string) => rows.find((r: any) => r.k === k && r.m === m) || {}
  return clients.map((c: any) => {
    const r = rec(c.k, month)
    const out: any = {
      client: c.n, tan: c.tan || '', form: c.form || '', mobile: c.ph || '',
      person: dn(c.p), role: c.p || '',
      data: TDS_D[r.d] || r.d || 'Pending',
      payment: TDS_P[r.p] || r.p || 'Pending',
      remarks: c.rem || '',
    }
    if (meta) {
      const q = rec(c.k, meta.qEndId)
      out.quarter = meta.quarter
      out.returnData = TDS_RD[q.rd] || q.rd || 'Pending'
      out.returnFiled = TDS_RF[q.rf] || q.rf || 'Pending'
      out.form16 = TDS_F16[q.f16] || q.f16 || 'Pending'
    }
    return out
  })
}

function afRowsFor(state: any, dn: (r: any) => string) {
  const rows: any[] = (state.afRows || []).filter((r: any) => r && !r.deleted)
  return rows.map((r: any) => {
    const checks: any = {}
    AF_CHECKS.forEach((label, i) => { checks[label] = (r.chk && r.chk[i]) || '' })
    return {
      id: r.id, sr: r.sr, client: r.client,
      accountant: dn(r.acct), accountantRole: r.acct || '',
      finaliser: dn(r.fin), finaliserRole: r.fin || '',
      complexity: r.complex || '',
      stage: r.stage || 'Not Started',
      work: { sales: r.sales || '', purchase: r.purchase || '', bank: r.bank || '', suspense: r.suspense || '' },
      documents: { bankStatement: r.dbank || '', loanStatement: r.dloan || '', drCrLedger: r.ddrcr || '' },
      audit: r.audit || '',
      target: r.target || '',
      checks,
      remarks: { accounts: r.aRem || '', final: r.fRem || '' },
      updated: day(r.mt),
    }
  })
}

// ---------------------------------------------------------------------------
const baseHandler = createMcpHandler(
  (server) => {
    // -- health check -------------------------------------------------------
    server.tool('ping', 'Health check. Returns pong.', {}, async () => text('pong'))

    // -- READ: high-level summary ------------------------------------------
    server.tool(
      'get_summary',
      'Overview of the whole tracker: task counts by status and by person (real names), what counts as pending, fee position, and the current-period position of the GST, GST Composition, TDS and Accounting & Finalisation modules. Use for "how many pending", "who has the most work", "where are we on GST this month".',
      {},
      async () => {
        const state = await readState()
        const { dn } = makeNames(state)
        const tasks = liveTasks(state)
        const byStatus: Record<string, number> = {}
        for (const s of STATUSES) byStatus[s] = 0
        const byPerson: Record<string, { total: number; pending: number; onHold: number }> = {}
        let billedUnpaidAmt = 0, toBeBilledAmt = 0
        for (const t of tasks) {
          const s = String(t.status || 'Unknown')
          byStatus[s] = (byStatus[s] || 0) + 1
          const p = dn(t.assignee) || 'Unassigned'
          byPerson[p] = byPerson[p] || { total: 0, pending: 0, onHold: 0 }
          byPerson[p].total++
          if (STATUS_GROUPS.active.includes(s as Status)) byPerson[p].pending++
          if (s === 'On Hold') byPerson[p].onHold++
          if (s === 'Billed') billedUnpaidAmt += Number(t.amount) || 0
          if (s === 'To Be Billed') toBeBilledAmt += Number(t.amount) || 0
        }
        const count = (g: string) => tasks.filter((t) => STATUS_GROUPS[g].includes(String(t.status) as Status)).length

        /* modules, at their default (last completed) period */
        const gp = gstDefaultPeriod(state), gr = gstRowsFor(state, gp, dn)
        const gq = gcDefaultQuarter(state), gc = gcRowsFor(state, gq, dn).filter((r) => r.active)
        const tm = tdsDefaultMonth(state), tr = tdsRowsFor(state, tm, dn), tmeta = tdsMeta(tm)
        const af = afRowsFor(state, dn)
        const afByStage: Record<string, number> = {}
        for (const s of AF_STAGES) afByStage[s] = 0
        for (const r of af) afByStage[r.stage] = (afByStage[r.stage] || 0) + 1
        const fees = (state.feesEntries || []).filter((e: any) => e && !e.deleted)

        return text({
          tasks: {
            total: tasks.length,
            pending: count('active'),
            pendingMeans: STATUS_GROUPS.active,
            closed: count('closed'),
            byStatus,
            byPerson,
            fees: {
              billedNotReceived: { count: byStatus['Billed'] || 0, amount: billedUnpaidAmt },
              toBeBilled: { count: byStatus['To Be Billed'] || 0, amount: toBeBilledAmt },
            },
          },
          gst: {
            period: gp, clients: gr.length,
            gstr1Filed: gr.filter((r) => r.gstr1 === 'Filed').length,
            gstr3bSettled: gr.filter((r) => r.gstr3b === 'Filed' || r.gstr3b === 'No Tax').length,
            fullySettled: gr.filter((r) => r.settled).length,
            salesDataAwaited: gr.filter((r) => !r.salesDataReceived).length,
            purchaseDataAwaited: gr.filter((r) => !r.purchaseDataReceived).length,
          },
          composition: {
            quarter: gq, activeClients: gc.length,
            cmp08Filed: gc.filter((r) => r.cmp08 === 'Filed').length,
            challanPaid: gc.filter((r) => r.challan === 'Paid').length,
          },
          tds: {
            month: tm, label: tmeta?.label, payBy: tmeta?.payBy, quarter: tmeta?.quarter, quarterEnd: !!tmeta?.qEnd,
            clients: tr.length,
            paid: tr.filter((r) => r.payment === 'Paid').length,
            paymentPending: tr.filter((r) => ['Pending', 'In progress', 'Client paying'].includes(r.payment)).length,
            dataPending: tr.filter((r) => r.data === 'Pending' || r.data === 'Data requested').length,
            ...(tmeta?.qEnd ? { returnFiled: tr.filter((r) => r.returnFiled === 'Filed').length } : {}),
          },
          accountingFinalisation: { year: state.afYear || '', rows: af.length, byStage: afByStage },
          gstAnnualFees: {
            entries: fees.length,
            byStatus: fees.reduce((m: any, e: any) => { const k = e.status || 'pending'; m[k] = (m[k] || 0) + 1; return m }, {}),
            billed: fees.reduce((s: number, e: any) => s + (Number(e.billAmount) || 0), 0),
            received: fees.reduce((s: number, e: any) => s + (Number(e.recdAmount) || 0), 0),
          },
        })
      }
    )

    // -- READ: filtered task list ------------------------------------------
    server.tool(
      'get_tasks',
      "List tasks with optional filters. Assignee matches the person's real name or role slot. `group` = active (pending work), closed, billing, billed_unpaid. Sorted newest-updated first. Returns `matched` (all) and `returned` (after limit).",
      {
        assignee: z.string().optional().describe('Person name or role, partial, case-insensitive (e.g. "Hitakshi" or "Emp 5")'),
        client: z.string().optional().describe('Client name, partial, case-insensitive'),
        status: z.enum(STATUSES).optional().describe('Exact status'),
        group: z.enum(GROUP_NAMES).optional().describe('Status group: active = Not Started/In Progress/On Hold/Ready for Review'),
        search: z.string().optional().describe('Text search across task, client, remarks, hold reason'),
        updated_within_days: z.number().int().min(1).optional().describe('Only tasks changed in the last N days'),
        include_deleted: z.boolean().optional().default(false),
        limit: z.number().int().min(1).max(500).optional().default(200),
      },
      async ({ assignee, client, status, group, search, updated_within_days, include_deleted, limit }) => {
        const state = await readState()
        const { dn, match } = makeNames(state)
        let tasks: Task[] = include_deleted ? (state.tasks || []).filter(Boolean) : liveTasks(state)
        if (assignee) tasks = tasks.filter((t) => match(t.assignee, assignee))
        if (client) tasks = tasks.filter((t) => has(t.client, client))
        if (status) tasks = tasks.filter((t) => t.status === status)
        if (group) tasks = tasks.filter((t) => STATUS_GROUPS[group].includes(String(t.status) as Status))
        if (search) {
          tasks = tasks.filter((t) => has(t.task, search) || has(t.client, search) || has(t.remarks, search) || has(t.holdReason, search))
        }
        if (updated_within_days) {
          const cutoff = Date.now() - updated_within_days * 86400000
          tasks = tasks.filter((t) => (Number(t.mt) || 0) >= cutoff)
        }
        tasks.sort((a, b) => (Number(b.mt) || 0) - (Number(a.mt) || 0))
        const out = tasks.slice(0, limit).map((t) => slim(t, dn))
        return text({ matched: tasks.length, returned: out.length, tasks: out })
      }
    )

    // -- READ: recent activity ---------------------------------------------
    server.tool(
      'get_activity',
      'Task activity log (created / status_changed / reassigned / deleted) with who did it. Use for "what happened this week", "what did X finish".',
      {
        days: z.number().int().min(1).max(365).optional().default(7),
        person: z.string().optional().describe("Filter by the person who made the change OR the task's assignee"),
        task_id: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional().default(200),
      },
      async ({ days, person, task_id, limit }) => {
        const state = await readState()
        const { dn, match } = makeNames(state)
        const byId = new Map<string, Task>((state.tasks || []).map((t: Task) => [String(t.id), t]))
        const cutoff = Date.now() - days * 86400000
        let log: any[] = (state.activityLog || []).filter((e: any) => e && Date.parse(e.ts) >= cutoff)
        if (task_id) log = log.filter((e) => String(e.taskId) === String(task_id))
        if (person) log = log.filter((e) => match(e.by, person) || match(byId.get(String(e.taskId))?.assignee, person))
        log.sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
        const out = log.slice(0, limit).map((e) => {
          const t = byId.get(String(e.taskId))
          return {
            at: e.ts, action: e.action, by: dn(e.by),
            taskId: e.taskId, task: e.taskName || t?.task, client: e.client || t?.client,
            assignee: dn(t?.assignee), from: e.from, to: e.to,
          }
        })
        return text({ matched: log.length, returned: out.length, activity: out })
      }
    )

    // -- READ: master lists / valid values ---------------------------------
    server.tool(
      'list_meta',
      'Valid people (role + real name), clients, task templates, statuses with their groups, and the periods each module knows. Call before creating/assigning so you use real names.',
      {},
      async () => {
        const state = await readState()
        return text({
          people: people(state),
          clients: state.clients || [],
          taskTemplates: state.taskTemplates || [],
          statuses: STATUSES,
          statusGroups: STATUS_GROUPS,
          periods: {
            gst: gstPeriods(state), gstDefault: gstDefaultPeriod(state),
            composition: gcQuarters(state), compositionDefault: gcDefaultQuarter(state),
            tds: tdsMonths(state), tdsDefault: tdsDefaultMonth(state),
            accountingFinalisationYear: state.afYear || '',
          },
        })
      }
    )

    // -- READ: GST monthly / quarterly filing tab ---------------------------
    server.tool(
      'get_gst_status',
      'GST tab: per client for one period — sales/purchase data received, GSTR-1/IFF stage, GSTR-3B stage, person handling it. Period label like "Aug 26"; defaults to the last completed month the tracker shows.',
      {
        period: z.string().optional().describe('e.g. "Aug 26" (see list_meta.periods.gst)'),
        client: z.string().optional(),
        person: z.string().optional().describe('Person name or role'),
        only_pending: z.boolean().optional().default(false).describe('Only clients not fully settled (GSTR-1 not filed or 3B not filed/no-tax)'),
      },
      async ({ period, client, person, only_pending }) => {
        const state = await readState()
        const { dn, match } = makeNames(state)
        const p = period && gstPeriods(state).includes(period) ? period : gstDefaultPeriod(state)
        let rows = gstRowsFor(state, p, dn)
        if (client) rows = rows.filter((r) => has(r.client, client) || has(r.gstin, client))
        if (person) rows = rows.filter((r) => match(r.role, person))
        if (only_pending) rows = rows.filter((r) => !r.settled)
        return text({
          period: p,
          ...(period && period !== p ? { note: `Period "${period}" not found; showing ${p}` } : {}),
          count: rows.length, rows,
        })
      }
    )

    // -- READ: GST Composition (quarterly CMP-08) ---------------------------
    server.tool(
      'get_composition_status',
      'GST Composition tab: per client for one quarter — data received, bank/purchase/sales, amounts, challan and CMP-08 filed. Quarter id like "2026-27-Q1"; defaults to the last completed quarter.',
      {
        quarter: z.string().optional().describe('e.g. "2026-27-Q1" (see list_meta.periods.composition)'),
        client: z.string().optional(),
        person: z.string().optional(),
        only_pending: z.boolean().optional().default(false).describe('Only active clients whose CMP-08 is not filed'),
      },
      async ({ quarter, client, person, only_pending }) => {
        const state = await readState()
        const { dn, match } = makeNames(state)
        const q = quarter && gcQuarters(state).includes(quarter) ? quarter : gcDefaultQuarter(state)
        let rows = gcRowsFor(state, q, dn)
        if (client) rows = rows.filter((r) => has(r.client, client) || has(r.gstin, client))
        if (person) rows = rows.filter((r) => match(r.role, person))
        if (only_pending) rows = rows.filter((r) => r.active && r.cmp08 !== 'Filed')
        return text({ quarter: q, count: rows.length, rows })
      }
    )

    // -- READ: TDS ----------------------------------------------------------
    server.tool(
      'get_tds_status',
      'TDS tab: per client for one month — data received, payment status, and at quarter-end the return data / return filed / Form 16 status. Month id like "aug" (FY 2026-27) or "aug27"; defaults to last month.',
      {
        month: z.string().optional().describe('e.g. "aug" (see list_meta.periods.tds)'),
        client: z.string().optional(),
        person: z.string().optional(),
        only_pending: z.boolean().optional().default(false).describe('Only clients whose payment is not Paid/NA'),
      },
      async ({ month, client, person, only_pending }) => {
        const state = await readState()
        const { dn, match } = makeNames(state)
        const m = month && tdsMonths(state).includes(month) ? month : tdsDefaultMonth(state)
        let rows = tdsRowsFor(state, m, dn)
        if (client) rows = rows.filter((r) => has(r.client, client) || has(r.tan, client))
        if (person) rows = rows.filter((r) => match(r.role, person))
        if (only_pending) rows = rows.filter((r) => r.payment !== 'Paid' && r.payment !== 'NA')
        return text({ month: m, ...tdsMeta(m), count: rows.length, rows })
      }
    )

    // -- READ: Accounting & Finalisation -----------------------------------
    server.tool(
      'get_acct_final',
      'Accounting & Finalisation tab for the current year: per client — accountant, finaliser, complexity, stage, work items (sales/purchase/bank/suspense), documents, audit, target date, review checklist, remarks.',
      {
        client: z.string().optional(),
        person: z.string().optional().describe('Accountant or finaliser, name or role'),
        stage: z.enum(AF_STAGES).optional(),
        only_pending: z.boolean().optional().default(false).describe('Only rows not yet Filed'),
      },
      async ({ client, person, stage, only_pending }) => {
        const state = await readState()
        const { dn, match } = makeNames(state)
        let rows = afRowsFor(state, dn)
        if (client) rows = rows.filter((r) => has(r.client, client))
        if (person) rows = rows.filter((r) => match(r.accountantRole, person) || match(r.finaliserRole, person))
        if (stage) rows = rows.filter((r) => r.stage === stage)
        if (only_pending) rows = rows.filter((r) => r.stage !== 'Filed')
        rows.sort((a, b) => (Number(a.sr) || 0) - (Number(b.sr) || 0))
        return text({ year: state.afYear || '', count: rows.length, rows })
      }
    )

    // -- READ: one client's fee position ------------------------------------
    server.tool(
      'get_client_fees',
      'Fee position of ONE client in one call: tasks billed but not received, tasks to be billed, received history, the GST Annual fees register entry, plus mobile and business name from the Client Master. Use for "how much does X owe", "remaining fees of X", "what have we billed X".',
      {
        client: z.string().describe('Client, trade or contact name, partial, case-insensitive'),
      },
      async ({ client }) => {
        const state = await readState()
        const { dn } = makeNames(state)
        const q = lc(client)
        if (!q) return text('Give a client name.')

        /* Client Master: names known to the tracker, with mobile + business */
        const mob = state.clientMobile || {}, biz = state.clientBusiness || {}
        const masterNames = new Set<string>([...(state.clients || []), ...Object.keys(mob), ...Object.keys(biz)].map(String))
        const clients = Array.from(masterNames)
          .filter((n) => has(n, q) || has(biz[n], q))
          .map((n) => ({ name: n, mobile: mob[n] || '', business: biz[n] || '' }))

        /* Tasks under any matching name (or a task whose client matches even if not in master) */
        const tasks = liveTasks(state).filter((t) => has(t.client, q) || has(biz[String(t.client)], q))
        const row = (t: Task) => ({ id: t.id, task: t.task, client: t.client, person: dn(t.assignee), amount: t.amount ?? null, updated: day(t.mt), remarks: t.remarks || '' })
        const sum = (arr: Task[]) => arr.reduce((s, t) => s + (Number(t.amount) || 0), 0)
        const billed = tasks.filter((t) => t.status === 'Billed')
        const toBill = tasks.filter((t) => t.status === 'To Be Billed')
        const received = tasks.filter((t) => t.status === 'Received')
        const done = tasks.filter((t) => t.status === 'Done')
        const notToBill = tasks.filter((t) => t.status === 'Not to Bill')
        const open = tasks.filter((t) => STATUS_GROUPS.active.includes(String(t.status) as Status))

        /* GST Annual fees register, matched on trade name or contact */
        const fees = (state.feesEntries || [])
          .filter((e: any) => e && !e.deleted && (has(e.tradeName, q) || has(e.contactPerson, q) || has(e.gstin, q)))
          .map((e: any) => ({
            tradeName: e.tradeName, gstin: e.gstin, contact: e.contactPerson, mobile: e.mobile,
            lastYearFees: e.lastYearFees ?? null, billAmount: e.billAmount ?? null, recdAmount: e.recdAmount ?? null,
            outstanding: (Number(e.billAmount) || 0) - (Number(e.recdAmount) || 0),
            status: e.status || 'pending', remarks: e.remarks || '',
          }))
        const feesOutstanding = fees.filter((e: any) => e.status !== 'pending' && e.status !== 'not_raised').reduce((s: number, e: any) => s + e.outstanding, 0)

        if (!clients.length && !tasks.length && !fees.length) return text(`No client, task or fees entry matches "${client}".`)

        const missingAmt = [...billed, ...toBill].filter((t) => t.amount == null).length
        return text({
          query: client,
          matchedClients: clients,
          summary: {
            remainingFromTasks: sum(billed),
            remainingFromFeesRegister: feesOutstanding,
            remainingTotal: sum(billed) + feesOutstanding,
            yetToBeBilled: sum(toBill),
            receivedSoFar: sum(received),
            openWork: open.length,
            ...(missingAmt ? { note: `${missingAmt} billed/to-be-billed task(s) have no amount entered, so the totals understate.` } : {}),
          },
          billedNotReceived: billed.map(row),
          toBeBilled: toBill.map(row),
          doneNotYetBilled: done.map(row),
          notToBill: notToBill.length,
          received: received.map(row),
          gstAnnualFees: fees,
        })
      }
    )

    // -- READ: GST Annual fees ---------------------------------------------
    server.tool(
      'get_fees',
      'GST Annual fees register (Super Admin): trade name, GSTIN, contact, last year fees, bill amount, received amount, status, remarks.',
      {
        status: z.string().optional().describe('e.g. pending, raised'),
        search: z.string().optional().describe('Trade name / GSTIN / contact'),
      },
      async ({ status, search }) => {
        const state = await readState()
        let rows: any[] = (state.feesEntries || []).filter((e: any) => e && !e.deleted)
        if (status) rows = rows.filter((e) => lc(e.status) === lc(status))
        if (search) rows = rows.filter((e) => has(e.tradeName, search) || has(e.gstin, search) || has(e.contactPerson, search))
        const out = rows.map((e) => ({
          id: e.id, tradeName: e.tradeName, gstin: e.gstin, contact: e.contactPerson, mobile: e.mobile,
          lastYearFees: e.lastYearFees, billAmount: e.billAmount, recdAmount: e.recdAmount,
          outstanding: (Number(e.billAmount) || 0) - (Number(e.recdAmount) || 0),
          status: e.status || 'pending', remarks: e.remarks || '',
        }))
        return text({
          count: out.length,
          totals: {
            billed: out.reduce((s, e) => s + (Number(e.billAmount) || 0), 0),
            received: out.reduce((s, e) => s + (Number(e.recdAmount) || 0), 0),
          },
          entries: out,
        })
      }
    )

    // -- WRITE: create a task ----------------------------------------------
    server.tool(
      'create_task',
      'Create a new task. Adds the client to the master list if new. Assignee may be a real name (resolved to the role slot) or a role.',
      {
        task: z.string().describe('The work / description'),
        client: z.string().describe('Client name'),
        assignee: z.string().describe('Person name or role (see list_meta.people)'),
        status: z.enum(STATUSES).optional().default('Not Started'),
        remarks: z.string().optional().default(''),
        holdReason: z.string().optional().describe('Required when status is On Hold'),
        amount: z.number().optional().describe('Fees, if any'),
      },
      async ({ task, client, assignee, status, remarks, holdReason, amount }) => {
        const state = await readState()
        const role = resolveRole(state, assignee)
        if (!role) return text(`Unknown person "${assignee}". Use a name or role from list_meta.people.`)
        if (status === 'On Hold' && !String(holdReason || '').trim()) return text('A hold reason is mandatory when a task is put On Hold.')
        await snapshot()
        const id = genId()
        const newTask: Task = {
          id, task, client, assignee: role, status,
          remarks: remarks || '', mt: Date.now(), createdAt: Date.now(),
        }
        if (holdReason) newTask.holdReason = holdReason
        if (amount !== undefined) newTask.amount = amount
        const activity = { ts: nowISO(), taskId: id, action: 'created', taskName: task, client, by: BY, from: null, to: status }
        await saveStateMerged({ tasks: [newTask], clients: [client], activityLog: [activity] })
        return text(`Created task ${id}: "${task}" — ${client} -> ${makeNames(state).dn(role)} [${status}]`)
      }
    )

    // -- WRITE: update one or more tasks -----------------------------------
    server.tool(
      'update_tasks',
      'Update existing tasks by id. Only the fields you pass are changed. Use for status changes (On Hold needs holdReason), reassignment (name or role), editing remarks/fees.',
      {
        updates: z
          .array(
            z.object({
              id: z.string(),
              task: z.string().optional(),
              client: z.string().optional(),
              assignee: z.string().optional(),
              status: z.enum(STATUSES).optional(),
              remarks: z.string().optional(),
              holdReason: z.string().optional(),
              amount: z.number().optional(),
            })
          )
          .min(1),
      },
      async ({ updates }) => {
        const state = await readState()
        const { dn } = makeNames(state)
        const byId = new Map<string, Task>((state.tasks || []).map((t: Task) => [String(t.id), t]))
        const toWrite: Task[] = []
        const log: any[] = []
        const problems: string[] = []
        for (const u of updates) {
          const cur = byId.get(String(u.id))
          if (!cur) { problems.push(`${u.id}: not found`); continue }
          const next: Task = { ...cur }
          if (u.task !== undefined) next.task = u.task
          if (u.client !== undefined) next.client = u.client
          if (u.remarks !== undefined) next.remarks = u.remarks
          if (u.holdReason !== undefined) next.holdReason = u.holdReason
          if (u.amount !== undefined) next.amount = u.amount
          if (u.status !== undefined && u.status !== cur.status) {
            if (u.status === 'On Hold' && !String(next.holdReason || '').trim()) {
              problems.push(`${u.id}: a hold reason is mandatory for On Hold`); continue
            }
            log.push({ ts: nowISO(), taskId: cur.id, action: 'status_changed', taskName: next.task, client: next.client, by: BY, from: cur.status, to: u.status })
            next.status = u.status
          }
          if (u.assignee !== undefined) {
            const role = resolveRole(state, u.assignee)
            if (!role) { problems.push(`${u.id}: unknown person "${u.assignee}"`); continue }
            if (role !== cur.assignee) {
              log.push({ ts: nowISO(), taskId: cur.id, action: 'reassigned', taskName: next.task, client: next.client, by: BY, from: cur.assignee, to: role })
              next.assignee = role
            }
          }
          next.mt = Date.now()
          toWrite.push(next)
        }
        if (toWrite.length) {
          await snapshot()
          await saveStateMerged({ tasks: toWrite, activityLog: log })
        }
        let msg = `Updated ${toWrite.length} task(s).`
        if (problems.length) msg += ` Skipped: ${problems.join('; ')}.`
        return text(msg)
      }
    )

    // -- WRITE: delete (tombstone) tasks -----------------------------------
    server.tool(
      'delete_tasks',
      'Delete tasks by id (soft-delete / tombstone — the tracker hides them). Reversible only via undo_last_change immediately after.',
      { ids: z.array(z.string()).min(1) },
      async ({ ids }) => {
        const state = await readState()
        const byId = new Map<string, Task>((state.tasks || []).map((t: Task) => [String(t.id), t]))
        const toWrite: Task[] = []
        const log: any[] = []
        const misses: string[] = []
        for (const id of ids) {
          const cur = byId.get(String(id))
          if (!cur) { misses.push(id); continue }
          toWrite.push({ ...cur, deleted: true, deletedAt: Date.now(), mt: Date.now() })
          log.push({ ts: nowISO(), taskId: cur.id, action: 'deleted', taskName: cur.task, client: cur.client, by: BY, from: cur.status, to: null })
        }
        if (toWrite.length) {
          await snapshot()
          await saveStateMerged({ tasks: toWrite, activityLog: log })
        }
        let msg = `Deleted ${toWrite.length} task(s).`
        if (misses.length) msg += ` Not found: ${misses.join(', ')}.`
        return text(msg)
      }
    )

    // -- WRITE: add a client / employee to masters -------------------------
    server.tool(
      'add_client',
      'Add a client to the master list.',
      { name: z.string() },
      async ({ name }) => {
        await snapshot()
        await saveStateMerged({ tasks: [], clients: [name] })
        return text(`Added client: ${name}`)
      }
    )

    server.tool(
      'add_employee',
      "Add an employee role slot to the master list (e.g. \"emp_12\"). Display names are set in the tracker's Settings, not here.",
      { name: z.string() },
      async ({ name }) => {
        await snapshot()
        await saveStateMerged({ tasks: [], employees: [name] })
        return text(`Added employee: ${name}`)
      }
    )

    // -- SAFETY: undo the most recent write --------------------------------
    server.tool(
      'undo_last_change',
      'Restore the tracker to the snapshot taken just before the most recent write (create/update/delete/add). Reverts ONE step only. Use immediately if a change was wrong.',
      {},
      async () => {
        const ok = await restore()
        return text(ok
          ? 'Reverted to the state from just before the last change.'
          : 'No backup available to restore (no write has happened yet, or KV is not configured).')
      }
    )
  },
  {},
  {
    basePath: '/api', // matches app/api/[transport]/route.ts  ->  /api/mcp
    maxDuration: 60,
    verboseLogs: true,
    redisUrl: process.env.REDIS_URL || process.env.KV_URL,
  }
)

// ---------------------------------------------------------------------------
// Optional gate: require  Authorization: Bearer <MCP_KEY>  to use the server.
// If MCP_KEY is unset, the endpoint is OPEN to anyone who finds the URL and
// they get FULL Super-Admin read/write. Set MCP_KEY in Vercel. Strongly advised.
// ---------------------------------------------------------------------------
const MCP_KEY = process.env.MCP_KEY

const handler = MCP_KEY
  ? withMcpAuth(
      baseHandler,
      async (_req, bearer): Promise<AuthInfo | undefined> => {
        if (bearer && bearer === MCP_KEY) {
          return { token: bearer, clientId: 'pujara-mcp', scopes: [] }
        }
        return undefined // -> 401
      },
      { required: true }
    )
  : baseHandler

export { handler as GET, handler as POST, handler as DELETE }
