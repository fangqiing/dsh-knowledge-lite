/**
 * dsh-knowledge-lite · binary attachments + Office text extraction
 *
 * Word/Excel/PowerPoint files are OOXML: a ZIP of XML parts. Node ships
 * `zlib`, so the whole extraction path stays dependency-free — no mammoth, no
 * SheetJS — which matters because this plugin installs as a plain directory
 * into the user's profile.
 *
 * What each extractor returns is plain text/Markdown written into the note
 * body, so attachments become searchable and quotable. The original bytes are
 * always kept alongside and open with the system program.
 */

import { inflateRawSync } from 'node:zlib'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

const EOCD_SIG = 0x06054b50
const CD_SIG = 0x02014b50
const LFH_SIG = 0x04034b50

/** Extensions we treat as text and inline into the body. */
const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.log', '.yaml', '.yml',
  '.ini', '.toml', '.conf', '.xml', '.html', '.htm', '.css', '.js', '.mjs',
  '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.c',
  '.h', '.cpp', '.hpp', '.cs', '.sh', '.bat', '.ps1', '.sql', '.env'
])

/** OOXML we can pull text out of without a converter. */
const EXTRACTABLE = new Set(['.docx', '.xlsx', '.pptx'])

export const FILES_SUBDIR = 'files'

export function isTextFile(name) {
  return TEXT_EXT.has(extname(name).toLowerCase())
}

export function isExtractable(name) {
  return EXTRACTABLE.has(extname(name).toLowerCase())
}

/** Anything that should be stored as a binary attachment rather than inlined. */
export function isBinaryAttachment(name) {
  const ext = extname(name).toLowerCase()
  return !TEXT_EXT.has(ext)
}

/* ------------------------------------------------------------------ */
/* minimal zip reader (deflate + stored, no zip64, no encryption)      */
/* ------------------------------------------------------------------ */

function findEndOfCentralDirectory(buf) {
  const floor = Math.max(0, buf.length - 65557)
  for (let i = buf.length - 22; i >= floor; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  return -1
}

/** @returns {Array<{name: string, method: number, compressedSize: number, localOffset: number}>} */
export function listZipEntries(buf) {
  const eocd = findEndOfCentralDirectory(buf)
  if (eocd < 0) throw new Error('不是有效的 ZIP/OOXML 文件')
  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  const entries = []
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CD_SIG) break
    const method = buf.readUInt16LE(offset + 10)
    const compressedSize = buf.readUInt32LE(offset + 20)
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    entries.push({
      name: buf.toString('utf8', offset + 46, offset + 46 + nameLen),
      method,
      compressedSize,
      localOffset
    })
    offset += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** One entry's bytes, or null when the name is absent. */
export function readZipEntry(buf, entryName, entries) {
  const list = entries ?? listZipEntries(buf)
  const hit = list.find((e) => e.name === entryName)
  if (!hit) return null
  const start = hit.localOffset
  if (buf.readUInt32LE(start) !== LFH_SIG) throw new Error(`ZIP 本地头损坏: ${entryName}`)
  const nameLen = buf.readUInt16LE(start + 26)
  const extraLen = buf.readUInt16LE(start + 28)
  const from = start + 30 + nameLen + extraLen
  const data = buf.subarray(from, from + hit.compressedSize)
  return hit.method === 0 ? Buffer.from(data) : inflateRawSync(data)
}

/* ------------------------------------------------------------------ */
/* xml helpers                                                         */
/* ------------------------------------------------------------------ */

function decodeXml(text) {
  return String(text ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&')
}

/** Concatenate every <w:t> run inside a fragment. */
function wordRuns(fragment) {
  return [...fragment.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
    .map((m) => decodeXml(m[1]))
    .join('')
}

/* ------------------------------------------------------------------ */
/* extractors                                                          */
/* ------------------------------------------------------------------ */

/** Word: one output block per paragraph, honouring Heading styles and lists. */
export function docxToMarkdown(buffer) {
  const xml = readZipEntry(buffer, 'word/document.xml')?.toString('utf8')
  if (!xml) return null
  const blocks = []
  for (const paragraph of xml.split('</w:p>')) {
    const text = wordRuns(paragraph).trim()
    if (text === '') continue
    const heading = /<w:pStyle\s+w:val="[^"]*?(?:Heading|标题)\s*(\d)"/i.exec(paragraph)
    if (heading) {
      blocks.push(`${'#'.repeat(Math.min(6, Number(heading[1])))} ${text}`)
    } else if (/<w:numPr[\s/>]/.test(paragraph)) {
      blocks.push(`- ${text}`)
    } else {
      blocks.push(text)
    }
  }
  return blocks.join('\n\n')
}

function columnIndex(ref) {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? 'A'
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/** Excel: first worksheet as CSV (shared strings resolved). */
export function xlsxToCsv(buffer) {
  const entries = listZipEntries(buffer)
  const sharedXml = readZipEntry(buffer, 'xl/sharedStrings.xml', entries)?.toString('utf8') ?? ''
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((x) => decodeXml(x[1])).join('')
  )
  const sheetName =
    entries.find((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))?.name ?? 'xl/worksheets/sheet1.xml'
  const sheetXml = readZipEntry(buffer, sheetName, entries)?.toString('utf8')
  if (!sheetXml) return null

  const rows = []
  for (const rowMatch of sheetXml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = []
    for (const cell of rowMatch[1].matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1] ?? ''
      const inner = cell[2] ?? ''
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? ''
      const type = /t="([^"]+)"/.exec(attrs)?.[1]
      let value = ''
      if (type === 's') {
        const idx = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1]
        value = shared[Number(idx)] ?? ''
      } else if (type === 'inlineStr') {
        value = decodeXml([...inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''))
      } else {
        value = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '')
      }
      if (value !== '') cells[columnIndex(ref)] = value
    }
    if (cells.length > 0) {
      rows.push(cells.map((c) => (/[",\n]/.test(c ?? '') ? `"${String(c).replace(/"/g, '""')}"` : c ?? '')).join(','))
    }
  }
  return rows.join('\n')
}

/** PowerPoint: one section per slide, paragraphs joined with bullets. */
export function pptxToMarkdown(buffer) {
  const entries = listZipEntries(buffer)
  const slides = entries
    .map((e) => e.name)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)/.exec(a)[1]) - Number(/(\d+)/.exec(b)[1]))
  if (slides.length === 0) return null
  const parts = []
  for (const [index, name] of slides.entries()) {
    const xml = readZipEntry(buffer, name, entries)?.toString('utf8') ?? ''
    const lines = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)]
      .map((p) => [...p[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1])).join('').trim())
      .filter((t) => t !== '')
    if (lines.length === 0) continue
    parts.push(`## 第 ${index + 1} 页\n\n${lines.map((l) => `- ${l}`).join('\n')}`)
  }
  return parts.join('\n\n')
}

/** Dispatch by extension; null when we cannot read it. */
export function extractText(name, buffer) {
  const ext = extname(name).toLowerCase()
  try {
    if (ext === '.docx') return docxToMarkdown(buffer)
    if (ext === '.xlsx') return xlsxToCsv(buffer)
    if (ext === '.pptx') return pptxToMarkdown(buffer)
  } catch (err) {
    return `（无法解析：${err?.message ?? err}）`
  }
  return null
}

/* ------------------------------------------------------------------ */
/* storage + opening                                                   */
/* ------------------------------------------------------------------ */

function safeSegment(name) {
  return String(name).replace(/[\\/:*?"<>| -]/g, '_').slice(0, 120)
}

/** Keep one file per id; the stored name is `<id>-<safe original name>`. */
export function storedName(id, originalName) {
  return `${id}--${safeSegment(basename(originalName))}`
}

export function filesDir(root) {
  return join(root, FILES_SUBDIR)
}

export async function saveAttachment(root, id, originalName, base64) {
  const dir = filesDir(root)
  await mkdir(dir, { recursive: true })
  const stored = storedName(id, originalName)
  const target = join(dir, stored)
  await writeFile(target, Buffer.from(base64, 'base64'))
  const info = await stat(target)
  return { stored, name: basename(originalName), size: info.size, bytes: info }
}

export function resolveAttachment(root, stored) {
  const target = join(filesDir(root), basename(stored))
  return target
}

/** Hand the file to the OS default program (Word, Excel, a PDF reader…). */
export function openWithSystem(path) {
  return new Promise((resolve, reject) => {
    // Windows: `start` treats the first quoted argument as a window title, hence
    // the "". macOS/Linux use their openers; all delegate to the file association
    // so a PDF lands in the default reader and .docx in Microsoft Word.
    const spec =
      process.platform === 'win32'
        ? { bin: 'cmd', args: ['/c', 'start', '', path] }
        : process.platform === 'darwin'
          ? { bin: 'open', args: [path] }
          : { bin: 'xdg-open', args: [path] }
    const child = spawn(spec.bin, spec.args, { detached: true, stdio: 'ignore' })
    child.on('error', reject)
    child.unref()
    setTimeout(() => resolve(true), 300)
  })
}

/** Show the file selected in Explorer. */
export function revealInExplorer(path) {
  return new Promise((resolve, reject) => {
    const child = spawn('explorer', [`/select,${path}`], { detached: true, stdio: 'ignore' })
    child.on('error', reject)
    child.unref()
    setTimeout(() => resolve(true), 300)
  })
}

export { readFile, copyFile, rm, stat }