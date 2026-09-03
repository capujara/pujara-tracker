import { put, head } from '@vercel/blob'
import crypto from 'crypto'
import fs from 'fs/promises'
import path from 'path'

export const BOOTSTRAP_MOBILE = '9016875077'
export const TRACKER_VERSION = '2026-08-15-v117'
const STATE_PATH = 'pujara-tracker-state.json'
const KV_KEY = 'pujara:tracker:state'
const LOCK_KEY = 'pujara:tracker:lock'
/* Local dev scratch file — see isLocalDev(). Never exists on Vercel; git-ignored. */
const LOCAL_FILE = path.join(process.cwd(), '.tracker-local.json')

function secret(): string {
  return process.env.AUTH_SECRET || 'pujara-tracker-default-secret-change-via-env-AUTH_SECRET'
}
function getKv(): { url: string; token: string } | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return null
  return { url: url.replace(/\/$/, ''), token }
}
/* Local-development storage.

   Active ONLY when every one of these holds:
     - no Upstash/KV credentials, AND
     - no Blob token, AND
     - NODE_ENV is not production, AND
     - we are not running on Vercel at all (VERCEL is set on every Vercel build/runtime).

   On Vercel the KV credentials are always present, so 'kv' wins long before this is
   consulted — and the !process.env.VERCEL guard means that even a misconfigured Vercel
   environment can never silently fall back to a throwaway file. This exists so the tracker
   is usable on a laptop (own data, in .tracker-local.json) without touching live storage. */
function isLocalDev(): boolean {
  return (
    !getKv() &&
    !process.env.BLOB_READ_WRITE_TOKEN &&
    process.env.NODE_ENV !== 'production' &&
    !process.env.VERCEL
  )
}
export function isCloudConfigured(): boolean {
  return !!process.env.BLOB_READ_WRITE_TOKEN || !!getKv() || isLocalDev()
}
export function storageBackend(): 'kv' | 'blob' | 'file' | 'none' {
  if (getKv()) return 'kv'
  if (process.env.BLOB_READ_WRITE_TOKEN) return 'blob'
  if (isLocalDev()) return 'file'
  return 'none'
}

/* ---------- Upstash REST: command-array form ---------- */
async function kvCmd(cmd: any[]): Promise<any> {
  const k = getKv()!
  const res = await fetch(k.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${k.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`KV ${res.status}: ${await res.text()}`)
  const data: any = await res.json()
  return data.result
}
async function kvGetState(): Promise<any | null> {
  const v = await kvCmd(['GET', KV_KEY])
  if (v == null) return null
  if (typeof v === 'string') { try { return JSON.parse(v) } catch { return null } }
  return v
}
async function kvSetState(state: any): Promise<void> {
  await kvCmd(['SET', KV_KEY, JSON.stringify(state)])
}
async function kvLock(maxWaitMs = 4000): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    const r = await kvCmd(['SET', LOCK_KEY, '1', 'NX', 'EX', 5])
    if (r === 'OK') return true
    await new Promise(res => setTimeout(res, 120))
  }
  return false
}
async function kvUnlock(): Promise<void> {
  try { await kvCmd(['DEL', LOCK_KEY]) } catch {}
}

/* ---------- Blob fallback ---------- */
async function blobGet(): Promise<any | null> {
  let info: any
  try { info = await head(STATE_PATH) } catch { return null }
  try {
    const res = await fetch(info.url + '?_=' + Date.now(), { cache: 'no-store' })
    if (!res.ok) return null
    return await res.json()
  } catch { return null }
}
async function blobSet(state: any): Promise<void> {
  await put(STATE_PATH, JSON.stringify(state), {
    access: 'public', contentType: 'application/json',
    allowOverwrite: true, addRandomSuffix: false, cacheControlMaxAge: 0,
  })
}

/* ---------- Local dev file (laptop only) ---------- */
async function fileGet(): Promise<any | null> {
  try { return JSON.parse(await fs.readFile(LOCAL_FILE, 'utf8')) } catch { return null }
}
async function fileSet(state: any): Promise<void> {
  await fs.writeFile(LOCAL_FILE, JSON.stringify(state, null, 2), 'utf8')
}

/* ---------- MERGE: combine two states without losing anyone's changes ---------- */
/* Client-master renames of 2026-09-02 (aligned to the office client master).
   The clients list merges as a union and the mobile/business maps as key-unions, so a tab
   opened before the rename would resurrect the old spellings on its next sync. Both sides
   of every merge pass through this map instead; the entries can be dropped once no tab
   from before the rename can still be alive. */
const CLIENT_RENAMES: Record<string, string> = {
  ",aj e com llp": "Ajecomm Llp",
  ",desai llp": "Desai Opulence Consultants Llp",
  "AAYUSHI MAULIN PATEL": "Aayushi Maulin Patel",
  "AMAR DESAI": "Amarben Ramjibhai Desai",
  "AMD SOLAR PVT LTD": "Amd Solar Private Limited",
  "ARJUN KUMAR": "Arjun Kumar",
  "Akshay Patel": "Akshaykumar Ishvarbhai Patel",
  "Akshay Soni": "Soni Akshaykumar Kishorkumar",
  "Amit Patel": "Amitbhai Pravinchandra Patel",
  "Anand Khatri": "Anand Tagaram Khatri",
  "Arvind kumar": "Arvind Kumar",
  "BINABEN DAXINI": "Bina Rajeshkumar Daxini",
  "CLEMENTIUS LLP": "Clementius Llp",
  "Carise Pharma": "Carise Pharmaceuticals",
  "Chandresh Chudasma": "Chudasma Chandreshkumar Mansinghbhai",
  "Chandresh Thakkar": "Thakkar Chandresh",
  "Chandreshekhar Wife": "Chandra Shekhar Ramkishor Singh Pal",
  "DEV BUILCON": "Dev Buildcon",
  "Dhiren Shah": "Dhiren Chandrakant Shah",
  "Dinesh Singh Kushwah HUF": "Dineshsingh R Kushwah Huf",
  "Dipak Mahajan": "Dipak Anil Mahajan",
  "GAURAV VYAS ( SHREE SHAILJA)": "Gaurav Shatanandbhai Vyas",
  "Harshida Priyakant Son": "Harshida Priyakant Soni",
  "Heena Shah": "Heena Dhiren Shah",
  "Hemant Jain": "Hemant Pramod Jain",
  "JAGDISH AMRAJANI": "Jagdish Shewakram Amarnani",
  "JAIKISHAN KUMAR": "Jaikishan Kumar",
  "Jairaj Chavda": "Jayrajsinh Kiritsinh Chavda",
  "Jatin Trivedi": "Jatinkumar Madhusudan Trivedi",
  "Jaydeep Sejpal HUF": "Jaydeep Ashokbhai Sejpal Huf",
  "Jitendrakumar Raval": "Jitendra Ratilal Raval",
  "KOMAL PUJARA": "Komal Dixitkumar Pujara",
  "KRISH MEHTA": "Krish Bhavin Mehta",
  "Kantilal Suthar": "Kantilal Shakubhai Suthar",
  "Karankumar Jaggar": "Karankumar Kapurbhai Gajjar",
  "MINA JOSHI": "Meena Sanjay Joshi",
  "MOMIN AZAZAHMAD D": "Azazahmad Daudbhai Momin",
  "Mahendra choudhary": "Mahendra Ramjibhai Choudhary",
  "Mala Bhatiya": "Mala Dilip Bhatia",
  "Marshell Buildcon": "Marshall Buildcon",
  "NATWAR RAJPUROHIT": "Rajpurohit Natraj",
  "NEXSO ECOPLAST PVT LTD": "Nexso Ecoplast Private Limited",
  "Nilsan Reality LLP": "Nilsan Realty Llp",
  "Nirmal choudhary": "Nirmal Ramjibhai Chaudhary",
  "Nitinbhai Suthar": "Nitinbhai Samarbhai Suthar",
  "PALAK CHAUHAN": "Palak Chauhan",
  "Parimal Raval HUF": "Parimal R Raval Huf",
  "RITU AGARWAL": "Ritu Agarwal",
  "RUDRA EDUCATION": "Het Jimit Vakil",
  "RUPAL DER": "Rupal Pratap Der",
  "Ranajit Gajjar": "Ranajitkumar Gopalbhai Gajjar",
  "Rhythm Suthar": "Rhythm D Suthar",
  "S N VYAS HUF ( SHREE SHAILJA)": "Shatanand Narmadashankar Vyas Huf",
  "SANDEEP SOMPURA": "Sandipkumar Gunvantbhai Sompura",
  "SHILPA GUJARATI": "Shilpaben Hasmukhbhai Gujarati",
  "SHOBHANABEN PUJARA": "Shobhanaben Pujara",
  "SHREE SAHILJA DEVLOPERS": "Shree Shailaja Developers",
  "SHREE SHAILJA DEVELOPERS ( FIRM)": "Shree Shailaja Developers",
  "SONALBEN GUJARATI": "Sonalben Rajubhai Gujarati",
  "Sachin Devalia": "Sachin Nanalal Devaliya",
  "Shree Shaileja Developers": "Shree Shailaja Developers",
  "Smuggle LLP": "Snuggle Business Solutions Llp",
  "Sweety Desai": "Sweety Bhavesh Desai",
  "Tejas Vaidya": "Tejas Bhaskarrai Vaidya",
  "UJWAL S SHARMA": "Ujwal S Sharma",
  "VRAJVALLABH SADHU": "Vrajvallabhdas Dharmvallabhdas Sadhu",
  "Vanita choudhary": "Vanita Moolaram Chaudhary",
  "amarben desai": "Amarben Ramjibhai Desai",
  "amita shukla": "Amitaben Manojbhai Shukla",
  "ashish bhaudoriya": "Ashish Ramsevaksing Bhadouria",
  "ashvin dave": "Ashvinkumar Gunvantray Dave",
  "dhavan soni": "Dhaval Vipulkumar Soni",
  "dhavan soni group": "Dhaval Vipulkumar Soni",
  "global multi mineral": "Global Multi Minerals",
  "hansa dave": "Hansaben Gunvantray Dave",
  "harsha pandya": "Harshaben Prakashbhai Pandya",
  "hirabhai desai": "Hirabhai Thobhanbhai Desai",
  "hitesh kumar mkd": "Hitesh Kumar",
  "jalabhai kharagia": "Zalabhai Rukhadbhai Kharagiya",
  "jayesh desai": "Jayeshbhai Thobhanbhai Desai",
  "jimmy parmar": "Jimmy Jivanbhai Parmar",
  "kalavati patel": "Kalavatiben Jagdishbhai Patel",
  "kamlesh raval": "Kamlesh Dalji Nath Rawal",
  "kanika bhoudariya": "Kanta Ashish Bhadouria",
  "lilabhai desai": "Lilabhai Thobhanbhai Desai",
  "mahesh patel(huf)": "Mahesh Devrajbhai Patel (huf)",
  "maju sirvi": "Sirvi Manju",
  "milan gauswami": "Milangiri Ghanshyamgiri Gauswami",
  "neena anad": "Narinder Paul Kaur Anand",
  "nidhi savsani": "Savsani Nidhiben Gopalbhai",
  "nitin sarma": "Nitin Sureshchandra Sharma",
  "ramesh g patel": "Rameshkumar Gopalbhai Patel",
  "riddhi dave": "Riddhiben Ashvinbhai Dave",
  "rikin thakkar": "Rikinkumar Maheshkumar Thakkar",
  "sagar doshi": "Sagar Bipinbhai Doshi",
  "sandeep thakkar": "Sandeep Ghanshyambhai Thakkar",
  "satyesh ghetia": "Ghetiya Satyeshkumar Girdharbhai",
  "shital subhash patel": "Shitalben Subhashchandra Patel",
  "subhash patel": "Subhashchandra Shamalbhai Patel",
  "suryapratap": "Suryapratapsingh Dineshsingh Kushwah",
  "vinod sirvi": "Vinodkumar Sirvi"
}
function fixClientNames(s: any) {
  if (!s) return
  if (Array.isArray(s.clients)) {
    const seen = new Set<string>(); const out: any[] = []
    for (const n of s.clients) {
      const t = CLIENT_RENAMES[String(n)] || n
      const k = String(t); if (!seen.has(k)) { seen.add(k); out.push(t) }
    }
    s.clients = out
  }
  for (const key of ['clientMobile', 'clientBusiness']) {
    const m = s[key]
    if (!m || typeof m !== 'object') continue
    for (const old of Object.keys(m)) {
      const t = CLIENT_RENAMES[old]
      if (!t) continue
      const v = m[old]; delete m[old]
      if (v && !m[t]) m[t] = v
    }
  }
  for (const key of ['tasks', 'afRows']) {
    for (const r of (s[key] || [])) {
      if (r && r.client && CLIENT_RENAMES[String(r.client)]) r.client = CLIENT_RENAMES[String(r.client)]
    }
  }
}

export function mergeStates(cloud: any, incoming: any): any {
  fixClientNames(cloud)
  fixClientNames(incoming)
  if (!cloud) return incoming
  if (!incoming) return cloud
  const merged: any = { ...incoming }   /* incoming wins for client-only scalars (activeTab etc.) */
  delete merged.session

  /* tasks: merge by id; deletion (tombstone) wins; otherwise newer mt wins.
     CRITICAL: all ids coerced to String â€” old clients send numeric ids, new clients send string ids;
     without coercion the same task (id 33 vs "33") becomes two map keys â†’ duplicates. */
  const map = new Map<any, any>()
  for (const t of (cloud.tasks || [])) {
    if (!t || t.id == null) continue
    t.id = String(t.id)
    const ex = map.get(t.id)
    if (!ex || (t.mt || 0) >= (ex.mt || 0)) map.set(t.id, t)
  }
  let _rescueN = 0
  for (const t of (incoming.tasks || [])) {
    if (!t) continue
    /* Rescue tasks with a missing/NaN id (stale buggy client) so they survive instead of vanishing. */
    if (t.id == null || (typeof t.id === 'number' && isNaN(t.id)) || t.id === '' || t.id === 'NaN') {
      t.id = 'trsc' + Date.now().toString(36) + (_rescueN++).toString(36) + Math.random().toString(36).slice(2, 8)
    } else {
      t.id = String(t.id)
    }
    const ex = map.get(t.id)
    if (!ex) { map.set(t.id, t); continue }
    if (ex.deleted || t.deleted) {
      const base = ex.deleted ? ex : t
      map.set(t.id, { ...base, deleted: true, deletedAt: ex.deletedAt || t.deletedAt || Date.now() })
    } else {
      map.set(t.id, ((t.mt || 0) >= (ex.mt || 0)) ? t : ex)
    }
  }
  merged.tasks = Array.from(map.values())

  /* string arrays: union, sorted */
  const uni = (a: any[], b: any[]) => {
    const s = new Set<string>(); const out: any[] = []
    for (const x of [...(a || []), ...(b || [])]) {
      const k = String(x); if (!s.has(k)) { s.add(k); out.push(x) }
    }
    return out.sort((x, y) => String(x).localeCompare(String(y)))
  }
  merged.clients = uni(cloud.clients, incoming.clients)
  merged.taskTemplates = uni(cloud.taskTemplates, incoming.taskTemplates)

  /* employees: union preserving insertion order */
  {
    const s = new Set<string>(); const out: string[] = []
    for (const e of [...(cloud.employees || []), ...(incoming.employees || [])]) {
      if (!s.has(e)) { s.add(e); out.push(e) }
    }
    merged.employees = out
  }

  /* objects: merge keys, incoming wins on conflict */
  const mo = (a: any, b: any) => ({ ...(a || {}), ...(b || {}) })
  /* superTodos: Mitul's personal list. Only his client sends it; preserve cloud copy otherwise. */
  merged.superTodos = (incoming.superTodos !== undefined) ? incoming.superTodos : (cloud.superTodos || [])
  /* feesEntries: Super Admin only; preserve cloud copy if incoming didn't send it.
     Merge PER ENTRY by id — tombstone wins, else newer mt wins — exactly like tasks.
     Wholesale replacement let any tab holding a stale copy wipe another tab's edits
     (the "marked Received, later shows outstanding again" bug). */
  if (incoming.feesEntries === undefined) {
    merged.feesEntries = cloud.feesEntries || []
  } else {
    const fmap = new Map<string, any>()
    for (const e of (cloud.feesEntries || [])) {
      if (!e || e.id == null) continue
      e.id = String(e.id)
      const ex = fmap.get(e.id)
      if (!ex || (e.mt || 0) >= (ex.mt || 0)) fmap.set(e.id, e)
    }
    for (const e of (incoming.feesEntries || [])) {
      if (!e || e.id == null) continue
      e.id = String(e.id)
      const ex = fmap.get(e.id)
      if (!ex) { fmap.set(e.id, e); continue }
      if (ex.deleted || e.deleted) {
        const base = ex.deleted ? ex : e
        fmap.set(e.id, { ...base, deleted: true, deletedAt: ex.deletedAt || e.deletedAt || Date.now() })
      } else {
        fmap.set(e.id, ((e.mt || 0) >= (ex.mt || 0)) ? e : ex)
      }
    }
    merged.feesEntries = Array.from(fmap.values())
  }
  merged.empNames = mo(cloud.empNames, incoming.empNames)
  merged.roleMobile = mo(cloud.roleMobile, incoming.roleMobile)
  /* roleMpin: only Super Admin's client ever sends this (stripped from everyone else's
     GET and POST). A cleared PIN is stored as '' — never a deleted key — so the clear
     survives this key-union merge instead of being resurrected from the cloud copy. */
  merged.roleMpin = mo(cloud.roleMpin, incoming.roleMpin)
  merged.clientMobile = mo(cloud.clientMobile, incoming.clientMobile)
  merged.clientBusiness = mo(cloud.clientBusiness, incoming.clientBusiness)

  /* Accounting & Finalisation module rows: same id/tombstone/mt semantics as tasks.
     Old clients that don't send afRows keep the cloud copy intact (map is seeded from cloud). */
  {
    const afMap = new Map<string, any>()
    for (const r of (cloud.afRows || [])) {
      if (!r || r.id == null) continue
      r.id = String(r.id)
      const ex = afMap.get(r.id)
      if (!ex || (r.mt || 0) >= (ex.mt || 0)) afMap.set(r.id, r)
    }
    for (const r of (incoming.afRows || [])) {
      if (!r || r.id == null) continue
      r.id = String(r.id)
      const ex = afMap.get(r.id)
      if (!ex) { afMap.set(r.id, r); continue }
      if (ex.deleted || r.deleted) {
        const base = ex.deleted ? ex : r
        afMap.set(r.id, { ...base, deleted: true, deletedAt: ex.deletedAt || r.deletedAt || Date.now() })
      } else {
        afMap.set(r.id, ((r.mt || 0) >= (ex.mt || 0)) ? r : ex)
      }
    }
    merged.afRows = Array.from(afMap.values())
  }
  merged.afYear = (incoming.afYear !== undefined) ? incoming.afYear : (cloud.afYear ?? '')

  /* GST module: clients and per-period records merge by id with the same
     newer-mt-wins / tombstone rules as tasks, so two people working different
     clients in the same period never overwrite each other. */
  const byId = (cloudArr: any[], incArr: any[]) => {
    const m = new Map<string, any>()
    for (const x of (cloudArr || [])) {
      if (!x || x.id == null) continue
      x.id = String(x.id)
      const ex = m.get(x.id)
      if (!ex || (x.mt || 0) >= (ex.mt || 0)) m.set(x.id, x)
    }
    for (const x of (incArr || [])) {
      if (!x || x.id == null) continue
      x.id = String(x.id)
      const ex = m.get(x.id)
      if (!ex) { m.set(x.id, x); continue }
      if (ex.deleted || x.deleted) {
        const base = ex.deleted ? ex : x
        m.set(x.id, { ...base, deleted: true, deletedAt: ex.deletedAt || x.deletedAt || Date.now() })
      } else {
        m.set(x.id, ((x.mt || 0) >= (ex.mt || 0)) ? x : ex)
      }
    }
    return Array.from(m.values())
  }
  /* Clients merge by newest change, NOT byId: there a deleted flag is a tombstone that wins
     for good, so one mis-click on the delete button in the detail row could never be undone
     and that GSTIN could never come back. A stale tab cannot resurrect one either — the
     delete stamps mt, so the older copy loses. */
  merged.gstClients = (() => {
    const m = new Map<string, any>()
    for (const x of [...(cloud.gstClients || []), ...(incoming.gstClients || [])]) {
      if (!x || x.id == null) continue
      const id = String(x.id), ex = m.get(id)
      if (!ex || (x.mt || 0) >= (ex.mt || 0)) m.set(id, { ...x, id })
    }
    return Array.from(m.values())
  })()
  /* Monthly records merge by newer mt, NOT byId: there a `deleted` flag is a tombstone that
     always wins, which poisoned the id for good. Nothing deletes these rows any more —
     removing a period keeps its records — so an id must stay writable. With the tombstone
     sticky, every later edit to that client and month was handed straight back undone. */
  merged.gstRows = (() => {
    const m = new Map<string, any>()
    for (const x of [...(cloud.gstRows || []), ...(incoming.gstRows || [])]) {
      if (!x || x.id == null) continue
      const id = String(x.id), ex = m.get(id)
      if (!ex || (x.mt || 0) >= (ex.mt || 0)) m.set(id, { ...x, id })
    }
    return Array.from(m.values())
  })()
  merged.gstMonths = uni(cloud.gstMonths, incoming.gstMonths)
  merged.gstMonthsDel = uni(cloud.gstMonthsDel, incoming.gstMonthsDel)
  /* GST Composition: clients, quarterly records and the quarter list all merge by id with
     the newer change winning. Same reasoning as the GST tab above - a tombstone that always
     wins would make a mis-click permanent and retire that id for good. */
  {
    const newest = (a: any[], b: any[]) => {
      const m = new Map<string, any>()
      for (const x of [...(a || []), ...(b || [])]) {
        if (!x || x.id == null) continue
        const id = String(x.id), ex = m.get(id)
        if (!ex || (x.mt || 0) >= (ex.mt || 0)) m.set(id, { ...x, id })
      }
      return Array.from(m.values())
    }
    merged.gcClients = newest(cloud.gcClients, incoming.gcClients)
    merged.gcRows = newest(cloud.gcRows, incoming.gcRows)
    merged.gcQuarters = newest(cloud.gcQuarters, incoming.gcQuarters)
    merged.tdsClients = newest(cloud.tdsClients, incoming.tdsClients)
    merged.tdsRows = newest(cloud.tdsRows, incoming.tdsRows)
    merged.tdsPeriods = newest(cloud.tdsPeriods, incoming.tdsPeriods)
  }
  /* Periods merge by id with the newer mt winning. Deliberately NOT byId(): there the
     deleted flag is a tombstone that always wins, so a period removed once could never be
     put back — here removing and re-adding are both just edits. */
  merged.gstPeriods = (() => {
    const m = new Map<string, any>()
    for (const x of [...(cloud.gstPeriods || []), ...(incoming.gstPeriods || [])]) {
      if (!x || x.id == null) continue
      const id = String(x.id), ex = m.get(id)
      if (!ex || (x.mt || 0) >= (ex.mt || 0)) m.set(id, { ...x, id, del: x.del ? 1 : 0 })
    }
    return Array.from(m.values())
  })()

  /* Acct & Final activity log: concat + dedup, keep last 600 chronologically (same
     semantics as activityLog, but a separate stream so the two feeds stay uncluttered) */
  {
    const seen = new Set<string>(); const all: any[] = []
    for (const a of [...(cloud.afLog || []), ...(incoming.afLog || [])]) {
      if (!a) continue
      const k = (a.ts || '') + '|' + (a.rowId || '') + '|' + (a.action || '') + '|' + (a.by || '') + '|' + (a.field || '') + '|' + (a.from || '') + '|' + (a.to || '')
      if (!seen.has(k)) { seen.add(k); all.push(a) }
    }
    all.sort((x, y) => String(x.ts || '').localeCompare(String(y.ts || '')))
    merged.afLog = all.slice(-600)
  }

  /* activity log: concat + dedup, keep last 800 chronologically */
  {
    const seen = new Set<string>(); const all: any[] = []
    for (const a of [...(cloud.activityLog || []), ...(incoming.activityLog || [])]) {
      if (!a) continue
      const k = (a.ts || '') + '|' + (a.taskId || '') + '|' + (a.action || '') + '|' + (a.by || '') + '|' + (a.from || '') + '|' + (a.to || '')
      if (!seen.has(k)) { seen.add(k); all.push(a) }
    }
    all.sort((x, y) => String(x.ts || '').localeCompare(String(y.ts || '')))
    merged.activityLog = all.slice(-800)
  }

  /* nextId is vestigial (task ids are unique strings now). Keep it a safe positive number;
     NEVER derive it from string ids or it becomes NaN and poisons every client. */
  merged.nextId = Math.max(Number(cloud.nextId) || 1, Number(incoming.nextId) || 1) || 1

  /* flags: sticky-true (once migrated, stays migrated) */
  merged.migratedSunilHitakshi = !!(cloud.migratedSunilHitakshi || incoming.migratedSunilHitakshi)
  merged.purgedOthersTemplates = !!(cloud.purgedOthersTemplates || incoming.purgedOthersTemplates)

  return merged
}

/* ---------- Public API ---------- */
export async function loadState(): Promise<any | null> {
  const b = storageBackend()
  if (b === 'kv') return await kvGetState()
  if (b === 'blob') return await blobGet()
  if (b === 'file') return await fileGet()
  return null
}

/* Merge incoming into current cloud state atomically; returns the merged result. */
export async function saveStateMerged(incoming: any): Promise<any> {
  const b = storageBackend()
  if (b === 'kv') {
    const locked = await kvLock()
    try {
      const current = await kvGetState()
      const merged = mergeStates(current, incoming)
      await kvSetState(merged)
      return merged
    } finally {
      if (locked) await kvUnlock()
    }
  }
  if (b === 'blob') {
    const current = await blobGet()
    const merged = mergeStates(current, incoming)
    await blobSet(merged)
    return merged
  }
  if (b === 'file') {
    const current = await fileGet()
    const merged = mergeStates(current, incoming)
    await fileSet(merged)
    return merged
  }
  throw new Error('No storage backend configured')
}

/* Cheap content revision for conditional polling. 16 hex chars of a sha1 over the exact
   (already user-filtered) payload — changes iff the bytes the client would receive change.
   Lets an idle poll be answered with a ~70-byte "unchanged" instead of the whole state,
   which is what keeps Fast Origin Transfer flat no matter how often the office tabs poll. */
export function etagOf(payload: any): string {
  return crypto.createHash('sha1').update(JSON.stringify(payload ?? null)).digest('hex').slice(0, 16)
}

/* ---------- Auth ---------- */
export function normalizeMobile(s: any): string {
  return String(s ?? '').replace(/\D/g, '')
}
/* MPIN: exactly 4 digits (e.g. the person's DDMM birthday). '' = not a valid MPIN. */
export function normalizeMpin(s: any): string {
  const v = String(s ?? '').trim()
  return /^[0-9]{4}$/.test(v) ? v : ''
}
export function signToken(user: string): string {
  const payload = { user, exp: Date.now() + 30 * 24 * 60 * 60 * 1000 }
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto.createHmac('sha256', secret()).update(payloadB64).digest('base64url')
  return `${payloadB64}.${sig}`
}
export function verifyToken(token: string | null | undefined): { user: string } | null {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [payloadB64, sig] = parts
  const expected = crypto.createHmac('sha256', secret()).update(payloadB64).digest('base64url')
  if (expected !== sig) return null
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString())
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null
    return { user: String(payload.user) }
  } catch { return null }
}
export function authFromRequest(req: Request): { user: string } | null {
  const auth = req.headers.get('authorization') || ''
  const m = auth.match(/^Bearer\s+(.+)$/)
  return verifyToken(m ? m[1] : null)
}
