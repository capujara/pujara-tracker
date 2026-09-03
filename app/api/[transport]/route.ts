// app/api/[transport]/route.ts
// ---------------------------------------------------------------------------
// Pujara & Co. Task Tracker — MCP server (Super Admin, full read/write)
//
// Lives INSIDE the existing Next.js repo, so it talks to lib/tracker.ts
// directly (loadState / saveStateMerged). No login, no token, no mobile
// number in code. Every write goes through the same locked merge the web
// app uses, so it will not clobber a staffer editing in the browser.
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

// The exact status strings the tracker stores.
const STATUSES = [
  'Not Started',
  'In Progress',
  'On Hold',
  'Done',
  'Billed',
  'Received',
] as const

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
  amount?: number
  mt?: number
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

// Read the full (unfiltered = Super Admin) state.
async function readState(): Promise<any> {
  return (await loadState()) || { tasks: [] }
}

function liveTasks(state: any): Task[] {
  return (state.tasks || []).filter((t: any) => t && !t.deleted)
}

function slim(t: Task) {
  return {
    id: t.id,
    task: t.task,
    client: t.client,
    assignee: t.assignee,
    status: t.status,
    remarks: t.remarks,
    amount: t.amount,
  }
}

const baseHandler = createMcpHandler(
  (server) => {
    // -- health check -------------------------------------------------------
    server.tool('ping', 'Health check. Returns pong.', {}, async () => ({
      content: [{ type: 'text', text: 'pong' }],
    }))

    // -- READ: high-level summary ------------------------------------------
    server.tool(
      'get_summary',
      'Counts of tasks by status and by assignee, plus totals. Use for "how many pending", "who has most work", overviews.',
      {},
      async () => {
        const state = await readState()
        const tasks = liveTasks(state)
        const byStatus: Record<string, number> = {}
        const byAssignee: Record<string, number> = {}
        for (const t of tasks) {
          byStatus[t.status || 'Unknown'] = (byStatus[t.status || 'Unknown'] || 0) + 1
          byAssignee[t.assignee || 'Unassigned'] =
            (byAssignee[t.assignee || 'Unassigned'] || 0) + 1
        }
        const open = tasks.filter(
          (t) => t.status !== 'Done' && t.status !== 'Received'
        ).length
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { total: tasks.length, open, byStatus, byAssignee },
                null,
                2
              ),
            },
          ],
        }
      }
    )

    // -- READ: filtered task list ------------------------------------------
    server.tool(
      'get_tasks',
      'List tasks with optional filters. Returns concise task objects. Use this to answer questions about specific clients, assignees, or statuses.',
      {
        assignee: z.string().optional().describe('Filter by employee name (partial, case-insensitive)'),
        client: z.string().optional().describe('Filter by client name (partial, case-insensitive)'),
        status: z.enum(STATUSES).optional().describe('Filter by exact status'),
        search: z.string().optional().describe('Text search across task, client, remarks'),
        include_deleted: z.boolean().optional().default(false),
        limit: z.number().int().min(1).max(500).optional().default(200),
      },
      async ({ assignee, client, status, search, include_deleted, limit }) => {
        const state = await readState()
        let tasks: Task[] = include_deleted ? state.tasks || [] : liveTasks(state)
        const lc = (s: any) => String(s || '').toLowerCase()
        if (assignee) tasks = tasks.filter((t) => lc(t.assignee).includes(lc(assignee)))
        if (client) tasks = tasks.filter((t) => lc(t.client).includes(lc(client)))
        if (status) tasks = tasks.filter((t) => t.status === status)
        if (search) {
          const q = lc(search)
          tasks = tasks.filter(
            (t) => lc(t.task).includes(q) || lc(t.client).includes(q) || lc(t.remarks).includes(q)
          )
        }
        const out = tasks.slice(0, limit).map(slim)
        return {
          content: [
            { type: 'text', text: JSON.stringify({ count: out.length, tasks: out }, null, 2) },
          ],
        }
      }
    )

    // -- READ: master lists / valid values ---------------------------------
    server.tool(
      'list_meta',
      'Returns the valid employees, clients, task templates and status values. Call this before creating/assigning tasks so you use real names.',
      {},
      async () => {
        const state = await readState()
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  employees: state.employees || [],
                  clients: state.clients || [],
                  taskTemplates: state.taskTemplates || [],
                  statuses: STATUSES,
                },
                null,
                2
              ),
            },
          ],
        }
      }
    )

    // -- WRITE: create a task ----------------------------------------------
    server.tool(
      'create_task',
      'Create a new task. Adds the client/employee to the master lists if new.',
      {
        task: z.string().describe('The work / description'),
        client: z.string().describe('Client name'),
        assignee: z.string().describe('Employee name (see list_meta)'),
        status: z.enum(STATUSES).optional().default('Not Started'),
        remarks: z.string().optional().default(''),
        amount: z.number().optional().describe('Fees, if any'),
      },
      async ({ task, client, assignee, status, remarks, amount }) => {
        await snapshot()
        const id = genId()
        const newTask: Task = {
          id, task, client, assignee, status,
          remarks: remarks || '', mt: Date.now(),
        }
        if (amount !== undefined) newTask.amount = amount
        const activity = { ts: nowISO(), taskId: id, action: 'created', by: BY, from: null, to: status }
        await saveStateMerged({
          tasks: [newTask], clients: [client], employees: [assignee], activityLog: [activity],
        })
        return { content: [{ type: 'text', text: `Created task ${id}: "${task}" — ${client} -> ${assignee} [${status}]` }] }
      }
    )

    // -- WRITE: update one or more tasks -----------------------------------
    server.tool(
      'update_tasks',
      'Update existing tasks by id. Only the fields you pass are changed; everything else is preserved. Use for status changes, reassignment, editing remarks/fees.',
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
              amount: z.number().optional(),
            })
          )
          .min(1),
      },
      async ({ updates }) => {
        const state = await readState()
        const byId = new Map<string, Task>((state.tasks || []).map((t: Task) => [String(t.id), t]))
        const toWrite: Task[] = []
        const log: any[] = []
        const misses: string[] = []
        for (const u of updates) {
          const cur = byId.get(String(u.id))
          if (!cur) { misses.push(u.id); continue }
          const next: Task = { ...cur }
          if (u.task !== undefined) next.task = u.task
          if (u.client !== undefined) next.client = u.client
          if (u.remarks !== undefined) next.remarks = u.remarks
          if (u.amount !== undefined) next.amount = u.amount
          if (u.status !== undefined && u.status !== cur.status) {
            log.push({ ts: nowISO(), taskId: cur.id, action: 'status', by: BY, from: cur.status, to: u.status })
            next.status = u.status
          }
          if (u.assignee !== undefined && u.assignee !== cur.assignee) {
            log.push({ ts: nowISO(), taskId: cur.id, action: 'reassigned', by: BY, from: cur.assignee, to: u.assignee })
            next.assignee = u.assignee
          }
          next.mt = Date.now()
          toWrite.push(next)
        }
        if (toWrite.length) {
          await snapshot()
          await saveStateMerged({ tasks: toWrite, activityLog: log })
        }
        let msg = `Updated ${toWrite.length} task(s).`
        if (misses.length) msg += ` Not found: ${misses.join(', ')}.`
        return { content: [{ type: 'text', text: msg }] }
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
          log.push({ ts: nowISO(), taskId: cur.id, action: 'deleted', by: BY, from: cur.status, to: null })
        }
        if (toWrite.length) {
          await snapshot()
          await saveStateMerged({ tasks: toWrite, activityLog: log })
        }
        let msg = `Deleted ${toWrite.length} task(s).`
        if (misses.length) msg += ` Not found: ${misses.join(', ')}.`
        return { content: [{ type: 'text', text: msg }] }
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
        return { content: [{ type: 'text', text: `Added client: ${name}` }] }
      }
    )

    server.tool(
      'add_employee',
      'Add an employee to the master list.',
      { name: z.string() },
      async ({ name }) => {
        await snapshot()
        await saveStateMerged({ tasks: [], employees: [name] })
        return { content: [{ type: 'text', text: `Added employee: ${name}` }] }
      }
    )

    // -- SAFETY: undo the most recent write --------------------------------
    server.tool(
      'undo_last_change',
      'Restore the tracker to the snapshot taken just before the most recent write (create/update/delete/add). Reverts ONE step only. Use immediately if a change was wrong.',
      {},
      async () => {
        const ok = await restore()
        return {
          content: [
            {
              type: 'text',
              text: ok
                ? 'Reverted to the state from just before the last change.'
                : 'No backup available to restore (no write has happened yet, or KV is not configured).',
            },
          ],
        }
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
