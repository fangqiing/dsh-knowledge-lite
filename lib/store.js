/**
 * dsh-knowledge-lite · note store (host half)
 *
 * A zero-dependency Markdown note library on disk. One note = one
 * `<uuid>.md` file with a small frontmatter header, so the whole library stays
 * readable and editable outside dsh (any editor, file manager, git, sync tool).
 *
 * Layout — directories are real folders, not a field in the header:
 *   E:/dsh-kb/
 *     notes/
 *       随手记.md                ← root level (no directory)
 *       工作/
 *         项目A.md
 *         复盘/
 *           2026-10.md
 *     files/
 *       <uuid>--<original name>  ← binary attachments
 *
 * A note's directory is derived from its path, never stored in the
 * frontmatter: moving a file by hand in Explorer must not desync anything.
 *
 * Design notes:
 * - No YAML library. The frontmatter dialect is a deliberate subset:
 *   `key: scalar`, `key: "quoted scalar"`, `key: [a, b]`. Parsing takes the
 *   first colon only, so bare values may contain colons.
 * - Files dropped in by hand (no frontmatter) are still readable: the file
 *   name becomes the id and title until the note is saved once.
 * - Writes are atomic (temp file + rename) to survive a crash mid-save.
 * - An mtime-keyed cache keeps repeated list/search calls off the disk.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { DEFAULT_ROOT } from './config.js'
import { resolveAttachment } from './attachments.js'

// Single source of truth lives in config.js (user-overridable); re-exported
// here so callers that already import the store keep working.
export { DEFAULT_ROOT }

export const NOTES_SUBDIR = 'notes'
export const FILE_EXT = '.md'
const FENCE = '---'
const UNTITLED = '未命名笔记'
const SORTS = new Set(['updated', 'created', 'title'])
const ILLEGAL_DIR_CHARS = /[<>:"|?*-]/

/* ------------------------------------------------------------------ */
/* directory helpers                                                   */
/* ------------------------------------------------------------------ */

/**
 * Normalise a user-supplied directory: '' is the library root, backslashes
 * become slashes, and traversal / illegal characters are rejected outright
 * rather than silently rewritten (a silent rewrite is how libraries end up
 * writing notes somewhere the user did not choose).
 */
export function normalizeDir(dir) {
  const raw = String(dir ?? '').trim().replace(/\\/g, '/')
  if (raw === '' || raw === '/') return ''
  const parts = raw.split('/').filter((part) => part !== '' && part !== '.')
  for (const part of parts) {
    if (part === '..') throw new Error('目录路径不能包含 “..”')
    if (ILLEGAL_DIR_CHARS.test(part)) throw new Error(`目录名含非法字符：${part}`)
  }
  return parts.join('/')
}

/** Ancestor chain of a normalised dir, root first: 'a/b' → ['', 'a', 'a/b']. */
export function dirChain(dir) {
  const norm = normalizeDir(dir)
  if (norm === '') return ['']
  const out = ['']
  let acc = ''
  for (const part of norm.split('/')) {
    acc = acc === '' ? part : `${acc}/${part}`
    out.push(acc)
  }
  return out
}

/** Ancestors of `dir` that do not exist on disk, deepest first. */
function missingAncestors(present, dir) {
  const chain = dirChain(dir)
  const out = []
  for (let i = chain.length - 1; i > 0; i -= 1) {
    if (!present.has(chain[i])) out.push(chain[i])
  }
  return out
}

/* ------------------------------------------------------------------ */
/* frontmatter                                                         */
/* ------------------------------------------------------------------ */

/** Quote a scalar only when leaving it bare would read back ambiguously. */
function quoteScalar(value) {
  const s = String(value ?? '')
  if (s === '') return '""'
  const risky =
    /^[-?*&!|>%@`[\]{}"',#\s]/.test(s) ||
    /[[\]{},]/.test(s) ||
    s.includes('#') ||
    s.includes(': ') ||
    /\s$/.test(s)
  if (!risky) return s
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function unquoteScalar(raw) {
  const s = String(raw ?? '').trim()
  if (s.length >= 2 && s[0] === '"' && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  if (s.length >= 2 && s[0] === "'" && s.endsWith("'")) {
    return s.slice(1, -1)
  }
  return s
}

/** `[a, b]` → ['a','b']; anything else → null (caller decides the fallback). */
function parseStringList(raw) {
  const s = String(raw ?? '').trim()
  if (!s.startsWith('[') || !s.endsWith(']')) return null
  const inner = s.slice(1, -1).trim()
  if (inner === '') return []
  return inner
    .split(',')
    .map((item) => unquoteScalar(item))
    .filter((item) => item !== '')
}

/**
 * Split a note file into metadata + body.
 * @param {string} rawText file contents
 * @param {string} fallbackId id derived from the file name
 */
export function parseNote(rawText, fallbackId) {
  const text = String(rawText ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
  const meta = {
    id: fallbackId,
    title: '',
    tags: [],
    files: [],
    created: '',
    updated: '',
    source: 'manual'
  }
  let body = text

  if (text.startsWith(`${FENCE}\n`)) {
    const end = text.indexOf(`\n${FENCE}`, FENCE.length)
    if (end !== -1) {
      const block = text.slice(FENCE.length + 1, end)
      for (const line of block.split('\n')) {
        const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line)
        if (!m) continue
        const key = m[1]
        const raw = m[2]
        if (key === 'tags' || key === 'files') {
          const list = parseStringList(raw)
          meta[key] = list ?? (raw.trim() === '' ? [] : [unquoteScalar(raw)])
        } else if (Object.prototype.hasOwnProperty.call(meta, key)) {
          meta[key] = unquoteScalar(raw)
        }
      }
      body = text.slice(end + FENCE.length + 1)
    }
  }

  // Normalize only the outer edges so parse(serialize(n)) is idempotent:
  // leading blank lines and the single trailing newline are framing, not content.
  let out = body.replace(/^\n+/, '')
  if (out.endsWith('\n')) out = out.slice(0, -1)
  return { meta, body: out }
}

/** Serialize metadata + body back into the on-disk dialect. */
export function serializeNote(meta, body) {
  const lines = [
    FENCE,
    `id: ${quoteScalar(meta.id)}`,
    `title: ${quoteScalar(meta.title)}`,
    `tags: [${(meta.tags ?? []).map(quoteScalar).join(', ')}]`
  ]
  if (Array.isArray(meta.files) && meta.files.length > 0) {
    lines.push(`files: [${meta.files.map(quoteScalar).join(', ')}]`)
  }
  lines.push(
    `created: ${quoteScalar(meta.created)}`,
    `updated: ${quoteScalar(meta.updated)}`,
    `source: ${quoteScalar(meta.source)}`,
    FENCE
  )
  const text = String(body ?? '').replace(/\s+$/, '')
  return `${lines.join('\n')}\n\n${text}${text === '' ? '' : '\n'}`
}

/** Trim, drop empties, de-duplicate case-insensitively, keep first spelling. */
export function normalizeTags(tags) {
  const out = []
  const seen = new Set()
  const list = Array.isArray(tags) ? tags : String(tags ?? '').split(',')
  for (const raw of list) {
    const tag = String(raw ?? '').trim()
    if (tag === '') continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
  }
  return out
}

/* ------------------------------------------------------------------ */
/* store                                                               */
/* ------------------------------------------------------------------ */

export class NoteStore {
  constructor(options = {}) {
    this.root = options.root || DEFAULT_ROOT
    this.notesDir = join(this.root, options.subdir || NOTES_SUBDIR)
    /** @type {Map<string, {meta: object, body: string, mtimeMs: number, dir: string}>} */
    this.cache = new Map()
    this.ready = false
  }

  async init() {
    if (!this.ready) {
      await mkdir(this.notesDir, { recursive: true })
      this.ready = true
    }
    return this
  }

  /** Absolute path of a note file inside a (normalised) directory. */
  notePath(id, dir = '') {
    const rel = normalizeDir(dir)
    return rel === '' ? join(this.notesDir, `${id}${FILE_EXT}`) : join(this.notesDir, ...rel.split('/'), `${id}${FILE_EXT}`)
  }

  /** Absolute path of a directory (normalised). */
  dirPath(dir = '') {
    const rel = normalizeDir(dir)
    return rel === '' ? this.notesDir : join(this.notesDir, ...rel.split('/'))
  }

  /** Recursive walk of every note file: `{id, dir, file, mtimeMs}`. */
  async #scan() {
    const found = []
    const walk = async (rel) => {
      const abs = rel === '' ? this.notesDir : join(this.notesDir, ...rel.split('/'))
      let items
      try {
        items = await readdir(abs, { withFileTypes: true })
      } catch {
        return
      }
      for (const item of items) {
        if (item.isDirectory()) {
          await walk(rel === '' ? item.name : `${rel}/${item.name}`)
          continue
        }
        if (!item.isFile() || !item.name.endsWith(FILE_EXT)) continue
        const id = basename(item.name, FILE_EXT)
        const file = join(abs, item.name)
        let info
        try {
          info = await stat(file)
        } catch {
          continue
        }
        found.push({ id, dir: rel, file, mtimeMs: info.mtimeMs })
      }
    }
    await walk('')
    return found
  }

  /** Every directory that exists on disk, including empty ones. */
  async listDirs() {
    await this.init()
    const dirs = new Set()
    const walk = async (rel) => {
      const abs = rel === '' ? this.notesDir : join(this.notesDir, ...rel.split('/'))
      let items
      try {
        items = await readdir(abs, { withFileTypes: true })
      } catch {
        return
      }
      for (const item of items) {
        if (!item.isDirectory()) continue
        const next = rel === '' ? item.name : `${rel}/${item.name}`
        dirs.add(next)
        await walk(next)
      }
    }
    await walk('')
    return [...dirs].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  }

  /** Read (or reuse cached) every note file. */
  async loadAll() {
    await this.init()
    const live = new Set()
    const out = []

    for (const found of await this.#scan()) {
      live.add(found.id)
      const hit = this.cache.get(found.id)
      // A note can move between directories; the path is part of identity.
      if (hit && hit.mtimeMs === found.mtimeMs && hit.dir === found.dir) {
        out.push(hit)
        continue
      }
      let text
      try {
        text = await readFile(found.file, 'utf8')
      } catch {
        continue
      }
      const { meta, body } = parseNote(text, found.id)
      const entry = {
        meta: {
          ...meta,
          id: found.id,
          dir: found.dir,
          title: meta.title || found.id,
          tags: normalizeTags(meta.tags)
        },
        body,
        mtimeMs: found.mtimeMs,
        dir: found.dir
      }
      this.cache.set(found.id, entry)
      out.push(entry)
    }

    for (const id of [...this.cache.keys()]) {
      if (!live.has(id)) this.cache.delete(id)
    }
    return out
  }

  /** Metadata only, optionally filtered by directory / tags, sorted. */
  async list({ dir, tags = [], sort = 'updated' } = {}) {
    const wanted = normalizeTags(tags)
    let entries = await this.loadAll()
    if (dir !== undefined && dir !== null) {
      const only = normalizeDir(dir)
      entries = entries.filter((e) => e.meta.dir === only)
    }
    if (wanted.length > 0) {
      entries = entries.filter((e) => wanted.every((t) => e.meta.tags.includes(t)))
    }
    const key = SORTS.has(sort) ? sort : 'updated'
    entries = [...entries].sort((a, b) => {
      if (key === 'title') return a.meta.title.localeCompare(b.meta.title, 'zh-Hans-CN')
      const av = a.meta[key] || ''
      const bv = b.meta[key] || ''
      return bv.localeCompare(av)
    })
    return entries.map((e) => ({ ...e.meta, excerpt: excerptOf(e.body, '') }))
  }

  /** All distinct tags with usage counts, most used first. */
  async tags() {
    const counts = new Map()
    for (const e of await this.loadAll()) {
      for (const tag of e.meta.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1)
      }
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-Hans-CN'))
  }

  /** One note with its body. */
  async get(id) {
    if (!id) return null
    const found = (await this.#scan()).find((f) => f.id === id)
    if (!found) return null
    let text
    try {
      text = await readFile(found.file, 'utf8')
    } catch {
      return null
    }
    const { meta, body } = parseNote(text, id)
    return {
      ...meta,
      id,
      dir: found.dir,
      title: meta.title || id,
      tags: normalizeTags(meta.tags),
      body
    }
  }

  /**
   * Create or update a note. Omit `id` to create; pass an existing id to update
   * in place. `files` accumulates — attachments are added, never dropped.
   * `dir` places a new note, or moves an existing one.
   */
  async save({ id, title, body = '', tags = [], source = 'manual', files, dir } = {}) {
    await this.init()
    const now = new Date().toISOString()
    const previous = id ? await this.#readEntry(id) : null
    const noteId = id || randomUUID()

    const targetDir = dir === undefined || dir === null ? (previous?.meta.dir ?? '') : normalizeDir(dir)
    const sourcePath = previous ? this.notePath(noteId, previous.meta.dir) : null
    const target = this.notePath(noteId, targetDir)
    await mkdir(dirname(target), { recursive: true })

    const mergedFiles = Array.isArray(files)
      ? [...new Set([...(previous?.meta.files ?? []), ...files])]
      : [...(previous?.meta.files ?? [])]

    const meta = {
      id: noteId,
      dir: targetDir,
      title: String(title ?? '').trim() || previous?.meta.title || UNTITLED,
      tags: normalizeTags(tags),
      files: mergedFiles,
      created: previous?.meta.created || now,
      updated: now,
      source: previous?.meta.source || source
    }

    const tmp = `${target}.tmp-${randomUUID().slice(0, 8)}`
    await writeFile(tmp, serializeNote(meta, body), 'utf8')
    if (sourcePath && sourcePath !== target) await rm(sourcePath, { force: true })
    await rename(tmp, target)
    if (sourcePath && sourcePath !== target) {
      await this.#pruneEmptyDirs(previous.meta.dir)
    }

    const info = await stat(target)
    this.cache.set(noteId, { meta, body: String(body ?? ''), mtimeMs: info.mtimeMs, dir: targetDir })
    return { ...meta, excerpt: excerptOf(body, '') }
  }

  /** Rename a note without touching its body or tags. */
  async rename(id, title) {
    const entry = await this.#readEntry(id)
    if (!entry) return null
    const next = String(title ?? '').trim()
    if (next === '' || next === entry.meta.title) return { ...entry.meta }
    return this.save({
      id,
      title: next,
      body: entry.body,
      tags: entry.meta.tags,
      files: entry.meta.files,
      dir: entry.meta.dir
    })
  }

  /** Move a note into another directory (created when missing). */
  async move(id, dir) {
    const entry = await this.#readEntry(id)
    if (!entry) return null
    return this.save({
      id,
      title: entry.meta.title,
      body: entry.body,
      tags: entry.meta.tags,
      files: entry.meta.files,
      dir
    })
  }

  /** Create a directory, including any missing ancestor. */
  async mkdir(dir) {
    await this.init()
    const rel = normalizeDir(dir)
    if (rel === '') throw new Error('目录名不能为空')
    const missing = missingAncestors(new Set(await this.listDirs()), rel)
    for (const one of missing.reverse()) {
      await mkdir(join(this.notesDir, ...one.split('/')))
    }
    return rel
  }

  /** Rename a directory; refuses when the target already exists. */
  async renameDir(from, to) {
    const source = normalizeDir(from)
    const target = normalizeDir(to)
    if (source === '') throw new Error('根目录不能重命名')
    if (target === '') throw new Error('新目录名不能为空')
    if (source === target) return target
    if ((await this.listDirs()).includes(target)) throw new Error(`目标目录已存在：${target}`)
    await mkdir(dirname(join(this.notesDir, ...target.split('/'))), { recursive: true })
    await rename(join(this.notesDir, ...source.split('/')), join(this.notesDir, ...target.split('/')))
    this.cache.clear()
    return target
  }

  /**
   * Delete a directory. Without `cascade` it must already be empty; with it,
   * every note underneath goes too.
   */
  async removeDir(dir, { cascade = false } = {}) {
    const rel = normalizeDir(dir)
    if (rel === '') throw new Error('根目录不能删除')
    const prefix = `${rel}/`
    const entries = await this.loadAll()
    const inside = entries.filter((e) => e.meta.dir === rel || e.meta.dir.startsWith(prefix))
    if (inside.length > 0 && !cascade) {
      throw new Error(`目录「${rel}」不为空，里面还有 ${inside.length} 篇笔记`)
    }
    for (const entry of inside) {
      await this.remove(entry.meta.id)
    }
    // `remove` prunes the branch, so the directory may already be gone.
    await rm(join(this.notesDir, ...rel.split('/')), { recursive: true, force: true })
    this.cache.clear()
    return { removed: inside.length }
  }

  /** Delete a note and the attachment files it owns. */
  async remove(id) {
    if (!id) return false
    // Read first: the cache may not hold this note, and orphaned files in
    // files/ would otherwise pile up forever. A null read means it is gone
    // already, so do not go looking for it a second time.
    const entry = this.cache.get(id) ?? (await this.#readEntry(id))
    if (!entry) return false
    const owned = entry.meta?.files ?? []
    const noteDir = entry.meta?.dir ?? ''
    const target = this.notePath(id, noteDir)
    try {
      await unlink(target)
    } catch (err) {
      if (err?.code === 'ENOENT') {
        await this.#dropFiles(owned)
        this.cache.delete(id)
        return false
      }
      throw err
    }
    await this.#dropFiles(owned)
    this.cache.delete(id)
    await this.#pruneEmptyDirs(noteDir)
    return true
  }

  async stats() {
    const entries = await this.loadAll()
    const bytes = entries.reduce((sum, e) => sum + Buffer.byteLength(e.body, 'utf8'), 0)
    return {
      count: entries.length,
      bytes,
      root: this.root,
      notesDir: this.notesDir,
      dirs: (await this.listDirs()).length
    }
  }

  /* ---------------------------------------------------------------- */
  /* internals                                                        */
  /* ---------------------------------------------------------------- */

  async #locate(id) {
    const found = (await this.#scan()).find((f) => f.id === id)
    if (!found) throw Object.assign(new Error('笔记不存在'), { code: 'ENOENT' })
    return found
  }

  async #readEntry(id) {
    const cached = this.cache.get(id)
    if (cached) return cached
    let found
    try {
      found = await this.#locate(id)
    } catch {
      return null
    }
    let text
    try {
      text = await readFile(found.file, 'utf8')
    } catch {
      return null
    }
    const { meta, body } = parseNote(text, id)
    return { meta: { ...meta, id, dir: found.dir }, body, mtimeMs: found.mtimeMs, dir: found.dir }
  }

  /** Remove stored attachment files, best-effort. */
  async #dropFiles(files) {
    for (const stored of files) {
      try {
        await rm(resolveAttachment(this.root, stored))
      } catch {
        /* already gone, or locked — never block a delete on it */
      }
    }
  }

  /**
   * Walk up from `dir` removing directories that just became empty.
   * Deliberately attempts each level instead of diffing a fresh listing: a
   * directory emptied by the move we just made still *exists* on disk, so a
   * "what is missing" comparison would skip exactly the ones worth removing.
   */
  async #pruneEmptyDirs(dir) {
    const chain = dirChain(dir)
    for (let i = chain.length - 1; i > 0; i -= 1) {
      try {
        await rmdir(join(this.notesDir, ...chain[i].split('/')))
      } catch {
        break // still holds something (or already gone) — stop climbing
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** A short context window around the first match, for list/search results. */
export function excerptOf(body, query) {
  const text = String(body ?? '').replace(/\s+/g, ' ').trim()
  if (text === '') return ''
  const max = 90
  const q = String(query ?? '').trim().toLowerCase()
  if (q === '') return text.length > max ? `${text.slice(0, max)}…` : text
  const at = text.toLowerCase().indexOf(q)
  if (at === -1) return text.length > max ? `${text.slice(0, max)}…` : text
  const start = Math.max(0, at - 24)
  const slice = text.slice(start, start + max)
  return `${start > 0 ? '…' : ''}${slice}${start + max < text.length ? '…' : ''}`
}

export function createStore(options) {
  return new NoteStore(options)
}
