import { NextResponse } from 'next/server'
import { authFromRequest } from '@/lib/tracker'
import { inflateRawSync } from 'zlib'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/* Reads the firm's master index (Category | Task | Sheet Link) out of Google Sheets so the
   tracker's Office Sheets panel mirrors it — add or remove a row there and the panel follows,
   with no code change.

   Fetched here on the server rather than in the browser for two reasons: docs.google.com
   sends no CORS headers, so a browser fetch would be blocked outright; and the published URL
   stays out of the page source.

   The published HTML is used in preference to CSV because a CSV export throws the hyperlinks
   away — Drive chips and linked text both come out as plain words — whereas the HTML keeps
   the <a href>. CSV is still accepted, for the case where the URLs live in their own column. */

const SHEET_URL = process.env.OFFICE_SHEETS_URL || ''

export type OfficeSheet = { cat: string; name: string; url: string }

/* Header names we recognise, lower-cased. Order within the sheet does not matter. */
const CAT_KEYS = ['category', 'cat', 'group']
const NAME_KEYS = ['task', 'name', 'sheet', 'title']
const LINK_KEYS = ['sheet link', 'link', 'url', 'sheet url']

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
}

/* Google wraps chip labels in nested spans and sometimes routes links through
   google.com/url?q=<real>. Unwrap both so we store the destination, not the redirect. */
function cleanUrl(raw: string): string {
  if (!raw) return ''
  let u = decodeEntities(raw).trim()
  const m = u.match(/[?&]q=([^&]+)/)
  if (u.includes('google.com/url') && m) {
    try { u = decodeURIComponent(m[1]) } catch { /* keep the redirect if it will not decode */ }
  }
  return /^https?:\/\//i.test(u) ? u : ''
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/* --- xlsx (Google's export?format=xlsx) ---
   This is the only export Google offers that keeps the URL behind a link CHIP — pubhtml is a
   JS shell with no table, and CSV flattens chips to their label text. The workbook is a zip:
   cell text lives in each xl/worksheets/sheetN.xml (+ sharedStrings), and every chip/link is
   a <hyperlink ref="F5" r:id="rIdN"> resolved through that sheet's .rels file. */

function unzip(buf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>()
  /* End-of-central-directory record: scan back for its signature. */
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) return files
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16) /* central directory offset */
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break
    const method = buf.readUInt16LE(p + 10)
    const csize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const cmtLen = buf.readUInt16LE(p + 32)
    const lho = buf.readUInt32LE(p + 42)
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8')
    /* local header repeats name/extra lengths — data starts after ITS values */
    const lNameLen = buf.readUInt16LE(lho + 26)
    const lExtraLen = buf.readUInt16LE(lho + 28)
    const start = lho + 30 + lNameLen + lExtraLen
    const raw = buf.slice(start, start + csize)
    try {
      files.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw))
    } catch { /* skip an unreadable member rather than fail the lot */ }
    p += 46 + nameLen + extraLen + cmtLen
  }
  return files
}

function colToIndex(ref: string): number {
  const m = ref.match(/^([A-Z]+)/)
  if (!m) return 0
  let n = 0
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

function parseXlsx(buf: Buffer): OfficeSheet[] {
  const files = unzip(buf)
  if (!files.size) return []
  /* shared strings: <si> may contain one <t> or several rich-text runs */
  const shared: string[] = []
  const ss = files.get('xl/sharedStrings.xml')
  if (ss) {
    const xml = ss.toString('utf8')
    const siRe = /<si[^>]*>([\s\S]*?)<\/si>/g
    let si: RegExpExecArray | null
    while ((si = siRe.exec(xml))) {
      const ts = [...si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeEntities(m[1]))
      shared.push(ts.join(''))
    }
  }
  /* every worksheet: cells + its rels for hyperlink targets. The right tab is found later by
     mapRows spotting the Category/Task header, so extra tabs are harmless. */
  const all: OfficeSheet[] = []
  for (const [name, data] of files) {
    const m = name.match(/^xl\/worksheets\/(sheet\d+)\.xml$/)
    if (!m) continue
    const xml = data.toString('utf8')
    const relFile = files.get(`xl/worksheets/_rels/${m[1]}.xml.rels`)
    const relById = new Map<string, string>()
    if (relFile) {
      for (const r of relFile.toString('utf8').matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
        relById.set(r[1], cleanUrl(r[2]))
      }
    }
    /* hyperlink refs: cell -> url. Attributes are matched individually — Google writes
       r:id BEFORE ref (<hyperlink r:id="rId1" location="gid=0" ref="F5"/>), so any
       order-dependent pattern silently loses every link. */
    const linkByCell = new Map<string, string>()
    for (const h of xml.matchAll(/<hyperlink\b([^>]*)\/?>/g)) {
      const attrs = h[1]
      const ref = attrs.match(/\bref="([^"]+)"/)?.[1]
      const rid = attrs.match(/\br:id="([^"]+)"/)?.[1]
      const url = rid ? relById.get(rid) || '' : ''
      if (ref && url) linkByCell.set(ref, url)
    }
    /* cells -> grid rows. Same rule: pull r= and t= out of the attribute string separately,
       because a single lazy pattern can satisfy itself by skipping the optional t= capture —
       shared-string cells then read as their index numbers instead of their text. */
    const rowsByNum = new Map<number, { cells: string[]; links: string[] }>()
    for (const c of xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = c[1]
      const ref = attrs.match(/\br="([A-Z]+\d+)"/)?.[1]
      if (!ref) continue
      const type = attrs.match(/\bt="([^"]+)"/)?.[1] || ''
      const inner = c[2]
      let text = ''
      if (type === 's') {
        const v = inner.match(/<v>(\d+)<\/v>/)
        text = v ? shared[Number(v[1])] || '' : ''
      } else if (type === 'inlineStr') {
        text = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodeEntities(x[1])).join('')
      } else {
        const v = inner.match(/<v>([\s\S]*?)<\/v>/)
        text = v ? decodeEntities(v[1]) : ''
      }
      const rowNum = Number(ref.match(/\d+/)![0])
      const col = colToIndex(ref)
      const row = rowsByNum.get(rowNum) || { cells: [], links: [] }
      row.cells[col] = String(text).trim()
      row.links[col] = linkByCell.get(ref) || ''
      rowsByNum.set(rowNum, row)
    }
    const ordered = [...rowsByNum.keys()].sort((a, b) => a - b).map((k) => {
      const r = rowsByNum.get(k)!
      /* normalise sparse arrays */
      for (let i = 0; i < r.cells.length; i++) { r.cells[i] = r.cells[i] || ''; r.links[i] = r.links[i] || '' }
      return r
    })
    all.push(...mapRows(ordered))
  }
  return all
}

/* --- published HTML --- */
function parseHtml(html: string): OfficeSheet[] {
  const rows: { cells: string[]; links: string[] }[] = []
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
  let tr: RegExpExecArray | null
  while ((tr = trRe.exec(html))) {
    const cells: string[] = []
    const links: string[] = []
    const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi
    let td: RegExpExecArray | null
    while ((td = tdRe.exec(tr[1]))) {
      const inner = td[1]
      cells.push(stripTags(inner))
      const a = inner.match(/<a[^>]+href=["']([^"']+)["']/i)
      links.push(a ? cleanUrl(a[1]) : '')
    }
    if (cells.some(Boolean)) rows.push({ cells, links })
  }
  return mapRows(rows)
}

/* --- CSV (quoted fields, embedded commas/newlines) --- */
function parseCsv(text: string): OfficeSheet[] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (c !== '\r') field += c
  }
  row.push(field)
  if (row.some((f) => f.trim())) rows.push(row)
  return mapRows(rows.map((cells) => ({ cells: cells.map((c) => c.trim()), links: cells.map((c) => cleanUrl(c)) })))
}

/* Finds the header row wherever it sits — the real sheet starts several rows down — then maps
   columns by name so re-ordering them in Sheets cannot break this. */
function mapRows(rows: { cells: string[]; links: string[] }[]): OfficeSheet[] {
  const idxOf = (cells: string[], keys: string[]) =>
    cells.findIndex((c) => keys.includes(c.trim().toLowerCase()))

  let headerAt = -1
  let iCat = -1
  let iName = -1
  let iLink = -1
  for (let r = 0; r < rows.length; r++) {
    const cat = idxOf(rows[r].cells, CAT_KEYS)
    const name = idxOf(rows[r].cells, NAME_KEYS)
    if (cat >= 0 && name >= 0) {
      headerAt = r; iCat = cat; iName = name; iLink = idxOf(rows[r].cells, LINK_KEYS)
      break
    }
  }
  if (headerAt < 0) return []

  const out: OfficeSheet[] = []
  for (let r = headerAt + 1; r < rows.length; r++) {
    const { cells, links } = rows[r]
    const cat = (cells[iCat] || '').trim()
    const name = (cells[iName] || '').trim()
    if (!cat && !name) continue
    if (!name) continue
    /* Prefer the link column; fall back to a link found anywhere in the row. */
    let url = iLink >= 0 ? links[iLink] || '' : ''
    if (!url) url = links.find((l) => !!l) || ''
    out.push({ cat: cat || 'Other', name, url })
  }
  return out
}

export async function GET(req: Request) {
  const sess = authFromRequest(req)
  if (!sess) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!SHEET_URL) {
    return NextResponse.json({ sheets: [], configured: false })
  }
  try {
    /* Cached for 2 minutes so idle reopening of the panel does not re-hit Google. ?fresh=1
       (the panel's Refresh link) bypasses the cache entirely — Google's own republish delay
       (up to a few minutes after an edit) is then the only wait left, and that one is theirs. */
    const wantsFresh = new URL(req.url).searchParams.get('fresh') === '1'
    const res = await fetch(SHEET_URL, wantsFresh
      ? { cache: 'no-store', redirect: 'follow' }
      : { next: { revalidate: 120 }, redirect: 'follow' })
    if (!res.ok) {
      return NextResponse.json({ sheets: [], configured: true, error: 'Sheet fetch failed: ' + res.status }, { status: 200 })
    }
    const bytes = Buffer.from(await res.arrayBuffer())
    /* zip magic "PK" -> xlsx export (the only format that keeps chip links) */
    let format: string
    let sheets: OfficeSheet[]
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
      format = 'xlsx'
      sheets = parseXlsx(bytes)
    } else {
      const body = bytes.toString('utf8')
      const looksHtml = /<table|<tr[\s>]/i.test(body)
      format = looksHtml ? 'html' : 'csv'
      sheets = looksHtml ? parseHtml(body) : parseCsv(body)
    }
    return NextResponse.json({
      sheets,
      configured: true,
      format,
      withLinks: sheets.filter((s) => s.url).length,
    })
  } catch (e: any) {
    return NextResponse.json({ sheets: [], configured: true, error: String(e?.message || e) }, { status: 200 })
  }
}
