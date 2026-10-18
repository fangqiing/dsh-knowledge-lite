// dsh-knowledge-lite · host half
//
// Responsibilities:
//   1. own the on-disk note library (lib/store.js)
//   2. expose it to the browser half over a same-origin HTTP route
//
// Browser half -> `fetch('/_dsh/dsh-knowledge-lite/<method>')`
// Host half   -> `ctx.webServer.register({ kind:'prefix', path })`
// (the channel dsh-bottom-info-bar uses; the official Remote namespace is the
// alternative, but this one needs no extra service and is proven in this build.)

import { appendFileSync, mkdirSync } from 'node:fs'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { NoteStore } from './store.js'
import { Writeback } from './writeback.js'
import { migrateLibrary, readConfig, writeConfig } from './config.js'
import {
  extractText, filesDir, isTextFile, openWithSystem, resolveAttachment, revealInExplorer, saveAttachment, stat
} from './attachments.js'

export const name = 'dsh-knowledge-lite'

/** Cordis services this host half needs before it applies. */
export const inject = ['webServer', 'llm']

const BASE = '/_dsh/dsh-knowledge-lite'
const PROBE_LOG = 'E:/dsh-kb/_probe.log'
const TAG = '[kb-lite]'

/** Append one durable line: the desktop shell has no console we can read. */
function trace(line) {
  try {
    mkdirSync('E:/dsh-kb', { recursive: true })
    appendFileSync(PROBE_LOG, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    /* evidence is best-effort; never break the plugin over it */
  }
}

export function apply(ctx, config) {
  console.log(`${TAG} host apply called; config =`, JSON.stringify(config ?? null))
  trace(`host apply ok (config=${JSON.stringify(config ?? null)})`)

  // The note root is user-configurable (config file outside the library, so
  // moving the library never moves the setting with it).
  let root = readConfig().root
  let store = new NoteStore({ root })
  let writeback = new Writeback(ctx, store)
  writeback.attach()
  ctx.effect(() => () => writeback.detach())

  /** The single dispatch table; every method returns plain JSON data. */
  const methods = {
    ping: async () => ({ ok: true, at: new Date().toISOString(), stats: await store.stats() }),
    list: (args) => store.list(args ?? {}),
    tags: () => store.tags(),
    get: (args) => store.get(args?.id),
    save: (args) => store.save(args ?? {}),
    rename: (args) => store.rename(args?.id, args?.title),
    remove: (args) => store.remove(args?.id),
    search: (args) => store.search(args?.query ?? '', args ?? {}),
    stats: () => store.stats(),

    /** Directories are real folders; the path is the source of truth. */
    listDirs: () => store.listDirs(),
    mkdirDir: async (args) => ({ dir: await store.mkdir(args?.dir) }),
    renameDir: async (args) => ({ dir: await store.renameDir(args?.from, args?.to) }),
    /** Refuses a non-empty directory unless `cascade` is set. */
    removeDir: (args) => store.removeDir(args?.dir, { cascade: args?.cascade === true }),
    moveNote: async (args) => {
      const moved = await store.move(args?.id, args?.dir ?? '')
      if (!moved) throw new Error('笔记不存在')
      return moved
    },

    /** One turn → note candidates (nothing is written until `save` confirms). */
    extract: (args) => writeback.extract(args ?? {}),

    /**
     * Import a dropped file.
     *  - plain text goes into the body as-is;
     *  - OOXML (.docx/.xlsx/.pptx) is stored as an attachment AND extracted to
     *    Markdown/CSV so it becomes searchable and quotable;
     *  - everything else (PDF, images, archives, legacy .doc/.xls) is kept
     *    byte-for-byte and opened with the system program.
     * Attaches to `noteId` when given, otherwise creates its own note.
     */
    importFile: async (args) => {
      const name = String(args?.name ?? '').trim()
      if (name === '') throw new Error('缺少文件名')
      const base64 = String(args?.dataBase64 ?? '')
      if (base64 === '') throw new Error('文件内容为空')
      const buffer = Buffer.from(base64, 'base64')
      const targetId = args?.noteId || randomUUID()

      const extracted = isTextFile(name) ? null : extractText(name, buffer)
      const note = await store.get(targetId)
      const attachTo = note ? targetId : targetId
      const saved = await saveAttachment(root, attachTo, name, base64)

      const title = note?.title || name.replace(/\.[^.]+$/, '') || name
      const body = note?.body
        ? `${note.body}\n\n---\n\n## 附件：${saved.name}\n\n`
        : extracted
          ? `${extracted}\n\n---\n\n> 原文件：${saved.name}（${saved.size} 字节，双击附件可打开）`
          : `> ${saved.name}（${saved.size} 字节）\n>\n> 该格式不做文本抽取，需要时双击附件用系统程序打开。`

      const meta = await store.save({
        id: note ? targetId : undefined,
        title,
        body,
        tags: note?.tags ?? ['附件'],
        files: [saved.stored]
      })
      // A fresh note gets its own id; make sure the attachment prefix matches.
      if (!note && meta.id !== targetId) {
        await saveAttachment(root, meta.id, name, base64)
      }
      trace(`imported ${name} (${saved.size} bytes, extracted=${extracted ? extracted.length : 0})`)
      return { ...meta, attachment: { stored: saved.stored, name: saved.name, size: saved.size }, extracted: Boolean(extracted) }
    },

    /** Hand an attachment to the OS default program (Word, Excel, a PDF reader…). */
    openAttachment: async (args) => {
      const target = resolveAttachment(root, String(args?.stored ?? ''))
      try {
        await stat(target)
      } catch {
        throw new Error('附件文件不存在（可能已被移动或删除）')
      }
      await openWithSystem(target)
      return { ok: true }
    },

    /** Absolute disk path of an attachment (client feeds it to dsh host.openPath). */
    attachmentPath: async (args) => {
      const target = resolveAttachment(root, String(args?.stored ?? ''))
      return { path: target }
    },

    /** Select the attachment in Explorer. */
    revealAttachment: async (args) => {
      const target = resolveAttachment(root, String(args?.stored ?? ''))
      try {
        await stat(target)
      } catch {
        throw new Error('附件文件不存在（可能已被移动或删除）')
      }
      await revealInExplorer(target)
      return { ok: true }
    },
    /**
     * Point the library at another folder. Existing notes are copied first
     * (files keep their ids), then both store and writeback are rebuilt so the
     * change takes effect without restarting dsh.
     */
    configure: async (args) => {
      const next = String(args?.root ?? '').trim()
      if (next === '') throw new Error('新库位置不能为空')
      const previous = root
      let moved = null
      if (next !== previous) {
        if (args?.migrate !== false) moved = await migrateLibrary(previous, next)
        await writeConfig(next)
        root = next
        writeback.detach()
        store = new NoteStore({ root })
        writeback = new Writeback(ctx, store)
        writeback.attach()
        trace(`library root changed: ${previous} -> ${next}${moved ? ` (copied ${moved.copied})` : ''}`)
      }
      return { ok: true, moved, stats: await store.stats() }
    }
  }

  const readJsonBody = async (req) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8').trim()
    return raw === '' ? {} : JSON.parse(raw)
  }

  /**
   * Route guard. A route registered on the web server is reachable by ANY local
   * process, so the browser half proves itself two ways:
   *   1. a per-start token, injected into the (auth-gated) index page and sent
   *      back as `x-dsh-kb-token` — compared in constant time;
   *   2. otherwise, a same-origin fallback (loopback http, or the desktop
   *      `dsh-app://` scheme), which still blocks a hostile web page from
   *      driving the library through the user's browser.
   */
  let sampled = false
  const isAuthorized = (req) => {
    const provided = req.headers['x-dsh-kb-token']
    // A token was sent: it must be the right one. Falling back to the origin
    // check here would let a wrong token through, which defeats the point.
    if (typeof provided === 'string' && provided !== '') {
      if (provided.length !== TOKEN.length) return false
      try {
        return timingSafeEqual(Buffer.from(provided), Buffer.from(TOKEN))
      } catch {
        return false
      }
    }

    // No token. In the web server the browser half always has one (tapIndex
    // injects it into the authenticated index page), so this branch only ever
    // runs for the desktop shell: Electron loads the UI from `dsh-app://app/…`,
    // which has no index page to inject into and whose fetch carries no usable
    // http Origin. Being strict here would break the desktop app outright, so
    // accept that shape and keep rejecting genuine cross-site web requests.
    if (!sampled) {
      sampled = true
      // Names only, never values: enough to know whether a session cookie
      // exists that a future stricter check could key on.
      const cookieNames = String(req.headers.cookie ?? '')
        .split(';')
        .map((part) => part.split('=')[0].trim())
        .filter(Boolean)
      trace(`request sample: origin=${JSON.stringify(req.headers.origin ?? null)} ` +
        `referer=${JSON.stringify(req.headers.referer ?? null)} ` +
        `cookies=${JSON.stringify(cookieNames)} ` +
        `ua=${JSON.stringify(String(req.headers['user-agent'] ?? '').slice(0, 60))}`)
    }

    const source = String(req.headers.origin || req.headers.referer || '')
    if (source === '' || source === 'null') return true
    if (source.startsWith('dsh-app://')) return true
    try {
      const { hostname } = new URL(source)
      return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
    } catch {
      return false
    }
  }

  // Per-start token. Injected into the index page (which the web server only
  // serves to an authenticated session) and echoed back by the browser half.
  const TOKEN = randomBytes(24).toString('base64url')
  try {
    if (typeof ctx.webServer.tapIndex === 'function') {
      ctx.webServer.tapIndex((html) =>
        html.includes('</head>')
          ? html.replace('</head>', `<script>window.__DSH_KB_TOKEN__=${JSON.stringify(TOKEN)};</script></head>`)
          : html
      )
      trace('access token injected into index')
    }
  } catch (err) {
    console.warn(`${TAG} tapIndex unavailable, falling back to origin checks:`, err?.message)
  }

  const handler = async (req, res) => {
    const send = (code, payload) => {
      res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      })
      res.end(JSON.stringify(payload))
    }
    try {
      if (!isAuthorized(req)) {
        send(403, { ok: false, error: 'forbidden: 缺少或错误的知识库访问令牌' })
        return
      }
      const rest = String(req.url ?? '').slice(BASE.length).split('?')[0]
      const method = rest.replace(/^\/+|\/+$/g, '') || 'ping'
      const fn = methods[method]
      if (typeof fn !== 'function') {
        send(404, { ok: false, error: `unknown method: ${method}` })
        return
      }
      const args = req.method === 'POST' ? await readJsonBody(req) : {}
      send(200, { ok: true, data: await fn(args) })
    } catch (err) {
      console.error(`${TAG} rpc failed:`, err)
      trace(`rpc error: ${err?.message}`)
      send(500, { ok: false, error: String(err?.message ?? err) })
    }
  }

  try {
    const dispose = ctx.webServer.register({ kind: 'prefix', path: BASE, handler })
    trace(`rpc route registered at ${BASE}/*`)
    console.log(`${TAG} rpc route registered at ${BASE}/*`)
    // Let Cordis own disposal so a reload cannot leave a stale route behind.
    if (typeof ctx.effect === 'function') ctx.effect(() => dispose)
  } catch (err) {
    console.error(`${TAG} rpc route registration failed:`, err)
    trace(`rpc route FAILED: ${err?.message}`)
  }
}
