// dsh-knowledge-lite · browser half
//
// Static bundle form required by DSH: the web shell installs a
// `window.__ModuleLoader__` facade and every plugin ships as CJS-in-a-factory.
//
//   window.__ModuleLoader__.load({ id, factory(require) => exports })
//
// Two things the guard facade enforces (both learned the hard way):
//   1. the returned plugin MUST declare `inject` — services are unreachable otherwise
//   2. slots can be declared AFTER we apply, so registration waits for them
//
// Panel model (option A: the library takes over the centre column):
//   `main` is a keyed slot; the shell renders the entry whose key equals the
//   active panel id, and the Conversation when that id is null. So we register
//   a keyed `main` entry plus sidebar entry points, and switch with
//   `layout.selectPanel(id)` / `selectPanel(null)`.

window.__ModuleLoader__.load({
  id: 'dsh-knowledge-lite',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef } = React

    const TAG = '[kb-lite]'
    const PANEL_ID = 'knowledge-lite'
    const API = '/_dsh/dsh-knowledge-lite'

    /* ------------------------------------------------------------------ */
    /* styles — injected once; .kb- prefixed, host CSS variables only      */
    /* ------------------------------------------------------------------ */

    const CSS = `
.kb-panel{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--text,inherit);font:var(--font-ui,inherit);background:inherit}
.kb-toolbar{display:flex;gap:8px;align-items:center;padding:10px 14px;border-bottom:1px solid var(--border,rgba(128,128,128,.25));flex:0 0 auto;flex-wrap:wrap}
.kb-input,.kb-titleinput,.kb-ta{background:transparent;color:inherit;font:inherit;border:1px solid var(--border,rgba(128,128,128,.35));border-radius:8px;outline:none;transition:border-color 120ms}
.kb-input:focus,.kb-titleinput:focus,.kb-ta:focus{border-color:var(--accent,currentColor)}
.kb-input{flex:1;min-width:120px;padding:6px 10px;font-size:13px}
.kb-btn{padding:6px 11px;border-radius:8px;border:1px solid var(--border,rgba(128,128,128,.35));background:transparent;color:inherit;font:inherit;font-size:13px;cursor:pointer;transition:background 120ms,border-color 120ms}
.kb-btn:hover{background:var(--surface-hover,rgba(128,128,128,.1))}
.kb-btn:disabled{opacity:.45;cursor:default}
.kb-btn.kb-primary{border-color:var(--accent,currentColor)}
.kb-body{display:flex;flex:1;min-height:0}
.kb-list{width:290px;flex:0 0 auto;overflow:auto;border-right:1px solid var(--border,rgba(128,128,128,.25))}
.kb-item{padding:10px 12px;cursor:pointer;border-bottom:1px solid var(--border,rgba(128,128,128,.14))}
.kb-item:hover{background:var(--surface-hover,rgba(128,128,128,.08))}
.kb-item.kb-selected{background:var(--surface-hover,rgba(128,128,128,.14))}
.kb-item-title{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kb-item-excerpt{font-size:12px;opacity:.62;margin-top:3px;line-height:1.45;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.kb-item-meta{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:6px}
.kb-tag{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--border,rgba(128,128,128,.35));opacity:.8;white-space:nowrap}
.kb-time{font-size:11px;opacity:.45;margin-left:auto}
.kb-editor{flex:1;display:flex;flex-direction:column;min-width:0;padding:14px;gap:8px}
.kb-titleinput{padding:7px 11px;font-size:16px;font-weight:600}
.kb-ta{flex:1;min-height:0;padding:10px 12px;line-height:1.6;font-size:13px;resize:none;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.kb-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.kb-status{font-size:12px;opacity:.72}
.kb-status.kb-err{color:#d9534f;opacity:.95}
.kb-empty{padding:28px 16px;text-align:center;opacity:.55;font-size:13px;line-height:1.7}
.kb-icon{display:flex;align-items:center;justify-content:center;width:100%;height:100%;cursor:pointer;color:inherit}
.kb-tail-btn{font-size:12px;padding:3px 9px;opacity:.85}
.kb-tail-status{font-size:12px;opacity:.7}
.kb-tail{margin:4px 0 10px;border:1px solid var(--border,rgba(128,128,128,.28));border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:10px}
.kb-tail-title{font-size:12px;font-weight:600;opacity:.85}
.kb-tail-item{display:flex;gap:9px;align-items:flex-start}
.kb-tail-check{display:flex;align-items:center;margin-top:6px;cursor:pointer}
.kb-tail-fields{flex:1;display:flex;flex-direction:column;gap:5px;min-width:0}
.kb-tail-fields .kb-input{font-size:12px;padding:4px 8px}
.kb-tail-tags{opacity:.8}
.kb-tail-body{margin:0;font-size:12px;line-height:1.55;opacity:.75;white-space:pre-wrap;word-break:break-word;max-height:120px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.kb-tail-route{font-size:11px;opacity:.5}
.kb-back{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:13px;cursor:pointer;transition:background 120ms}
.kb-back:hover{background:var(--surface-hover,rgba(128,128,128,.1))}
.kb-drop-active{outline:2px dashed var(--accent,currentColor);outline-offset:-8px}
.kb-drop-hint{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:var(--surface-hover,rgba(128,128,128,.1));font-size:14px;pointer-events:none;z-index:6}
.kb-root{font-size:12px;opacity:.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px}
.kb-root-input{font-size:12px;padding:4px 8px;max-width:360px}
.kb-cite{position:fixed;left:50%;top:16vh;transform:translateX(-50%);width:min(560px,92vw);z-index:9999;background:var(--surface,Canvas);color:var(--text,inherit);border:1px solid var(--border,rgba(128,128,128,.35));border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.28);padding:12px;display:flex;flex-direction:column;gap:8px}
.kb-cite-input{padding:8px 11px;font-size:13px;border:1px solid var(--border,rgba(128,128,128,.35));border-radius:8px;background:transparent;color:inherit;font:inherit;outline:none}
.kb-cite-input:focus{border-color:var(--accent,currentColor)}
.kb-cite-list{display:flex;flex-direction:column;max-height:46vh;overflow:auto}
.kb-cite-row{display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:7px 9px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.kb-cite-row:hover,.kb-cite-row.kb-cite-active{background:var(--surface-hover,rgba(128,128,128,.12))}
.kb-cite-title{font-size:13px;font-weight:600}
.kb-cite-excerpt{font-size:11px;opacity:.6}
.kb-cite-empty{font-size:12px;opacity:.6;padding:10px}
.kb-cite-hint{font-size:11px;opacity:.5}
.kb-menu{position:fixed;z-index:10000;min-width:180px;background:var(--surface,Canvas);color:var(--text,inherit);border:1px solid var(--border,rgba(128,128,128,.35));border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.26);padding:5px;display:flex;flex-direction:column;gap:1px}
.kb-menu-item{padding:7px 10px;border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;font-size:13px;text-align:left;cursor:pointer;white-space:nowrap;width:100%}
.kb-menu-item:hover{background:var(--surface-hover,rgba(128,128,128,.12))}
.kb-menu-item.kb-menu-danger{color:#d9534f}
.kb-menu-sep{height:1px;margin:4px 6px;background:var(--border,rgba(128,128,128,.25))}
.kb-menu-input{width:100%;padding:6px 8px;font-size:13px;border:1px solid var(--border,rgba(128,128,128,.35));border-radius:7px;background:transparent;color:inherit;font:inherit;outline:none}
.kb-files{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px solid var(--border,rgba(128,128,128,.25));border-radius:8px}
.kb-file{display:flex;align-items:center;gap:8px;font-size:12px}
.kb-file-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kb-file-badge{font-size:11px;opacity:.65;border:1px solid var(--border,rgba(128,128,128,.35));border-radius:999px;padding:0 6px;white-space:nowrap}
.kb-item-badge{font-size:11px;opacity:.6;margin-left:6px}
.kb-tree-row{display:flex;align-items:center;gap:6px;padding:6px 8px;margin:1px 0;border-radius:7px;cursor:pointer;font-size:13px;transition:background 120ms}
.kb-tree-row:hover{background:var(--surface-hover,rgba(128,128,128,.08))}
.kb-tree-caret{width:12px;flex:0 0 auto;opacity:.5;font-size:10px;line-height:1}
.kb-tree-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.kb-tree-count{font-size:11px;opacity:.45;flex:0 0 auto}
.kb-tree-row.kb-drop-target{outline:1px dashed var(--accent,currentColor);outline-offset:-2px}
`

    let stylesInstalled = false
    function installStyles() {
      if (stylesInstalled || typeof document === 'undefined') return
      stylesInstalled = true
      const el = document.createElement('style')
      el.setAttribute('data-plugin', 'dsh-knowledge-lite')
      el.textContent = CSS
      document.head.appendChild(el)
    }

    /* ------------------------------------------------------------------ */
    /* host RPC + tiny observable store                                    */
    /* ------------------------------------------------------------------ */

    // Injected by the host half into the auth-gated index page. Absent in the
    // desktop shell, where the origin check is the fallback.
    const ACCESS_TOKEN = typeof window !== 'undefined' && typeof window.__DSH_KB_TOKEN__ === 'string'
      ? window.__DSH_KB_TOKEN__
      : ''

    const rpc = async (method, args) => {
      const headers = { 'content-type': 'application/json' }
      if (ACCESS_TOKEN) headers['x-dsh-kb-token'] = ACCESS_TOKEN
      const res = await fetch(`${API}/${method}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(args ?? {})
      })
      const payload = await res.json().catch(() => null)
      if (!res.ok || !payload || payload.ok !== true) {
        throw new Error(payload?.error || `HTTP ${res.status}`)
      }
      return payload.data
    }

    /* ------------------------------------------------------------------ */
    /* citing a note into the composer (no dependency on shell internals)   */
    /* ------------------------------------------------------------------ */

    /**
     * The chat composer, not "whatever textarea comes first in the DOM" —
     * several plugins own inputs. Prefer a visible contenteditable (that is
     * what the dsh composer is), and among several take the last one, which
     * is the main chat box rather than a small inline editor.
     */
    function composerEl() {
      if (typeof document === 'undefined') return null
      const visible = (el) => el.offsetParent !== null || el.getClientRects().length > 0
      const editables = [...document.querySelectorAll('[contenteditable="true"]')].filter(visible)
      if (editables.length > 0) return editables[editables.length - 1]
      const areas = [...document.querySelectorAll('textarea')].filter(visible)
      if (areas.length > 0) return areas[areas.length - 1]
      return null
    }

    /** Insert text at the caret of whatever the composer turns out to be. */
    function insertIntoComposer(text) {
      const el = composerEl()
      if (!el) return false
      el.focus()
      if (el.isContentEditable) {
        // Selection API rather than execCommand: headless/synthetic input can
        // silently drop an execCommand('insertText'), and this path also works
        // when the caret sits in the middle of existing text.
        let inserted = false
        try {
          const sel = window.getSelection()
          if (sel && sel.rangeCount > 0) {
            const range = sel.getRangeAt(0)
            if (!el.contains(range.commonAncestorContainer)) {
              const fresh = document.createRange()
              fresh.selectNodeContents(el)
              fresh.collapse(false)
              sel.removeAllRanges()
              sel.addRange(fresh)
            }
            const range2 = sel.getRangeAt(0)
            range2.deleteContents()
            const node = document.createTextNode(text)
            range2.insertNode(node)
            range2.setStartAfter(node)
            range2.collapse(true)
            sel.removeAllRanges()
            sel.addRange(range2)
            inserted = true
          }
        } catch (err) {
          console.warn(`${TAG} selection insert failed, falling back`, err?.message)
        }
        if (!inserted) document.execCommand('insertText', false, text)
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      }
      const start = el.selectionStart ?? el.value.length
      const end = el.selectionEnd ?? el.value.length
      el.value = el.value.slice(0, start) + text + el.value.slice(end)
      const caret = start + text.length
      try { el.setSelectionRange(caret, caret) } catch { /* some inputs refuse */ }
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    }

    function quoteOf(note) {
      const lines = String(note?.body ?? '')
        .split('\n')
        .map((l) => l.trimEnd())
        .filter((l) => l.trim() !== '')
        .slice(0, 5)
      const tags = (note?.tags ?? []).length > 0 ? `  \`${note.tags.join('` `')}\`` : ''
      const head = `> **知识库 · ${note?.title || '未命名'}**${tags}`
      return `\n\n${head}\n${lines.map((l) => `> ${l}`).join('\n')}\n`
    }

    /** Put a note into the composer; fall back to the clipboard. */
    function citeNote(note) {
      const text = quoteOf(note)
      if (insertIntoComposer(text)) {
        console.log(`${TAG} cited note into composer:`, note?.title)
        return true
      }
      try {
        navigator.clipboard?.writeText(text.trim())
        console.log(`${TAG} composer not found — copied to clipboard instead`)
      } catch { /* clipboard may be denied */ }
      return false
    }

    /** Ctrl+Alt+K anywhere: search the library and drop a quote into the chat. */
    /**
     * Mirror of the host's text/binary split. Text files become the note body;
     * everything else goes through `importFile`, which stores the bytes and
     * extracts OOXML text server-side.
     */
    const TEXT_EXT = new Set([
      '.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.log', '.yaml', '.yml',
      '.ini', '.toml', '.conf', '.xml', '.html', '.htm', '.css', '.js', '.mjs',
      '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.c',
      '.h', '.cpp', '.hpp', '.cs', '.sh', '.bat', '.ps1', '.sql', '.env'
    ])
    const isTextName = (name) => {
      const ext = /\.([^.]+)$/.exec(String(name ?? '').toLowerCase())
      return ext ? TEXT_EXT.has(ext[0]) : false
    }
    /** `storedName` is `<id>--<original>`; show only the original. */
    const displayName = (stored) => String(stored ?? '').split('--').slice(1).join('--') || String(stored ?? '')

    const fileToBase64 = (file) => new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
      reader.onload = () => {
        const result = String(reader.result ?? '')
        resolve(result.slice(result.indexOf(',') + 1))
      }
      reader.readAsDataURL(file)
    })

    async function importDroppedFiles(files) {
      S.busy = true
      S.error = ''
      emit()
      let saved = 0
      let extracted = 0
      for (const file of files) {
        try {
          if (isTextName(file.name)) {
            const text = await file.text()
            const capped = text.length > 400000 ? `${text.slice(0, 400000)}\n\n…（内容过长已截断）` : text
            await rpc('save', {
              title: file.name.replace(/\.[^.]+$/, '') || file.name,
              body: capped,
              tags: ['导入'],
              source: 'import'
            })
          } else {
            const base64 = await fileToBase64(file)
            const result = await rpc('importFile', {
              name: file.name,
              dataBase64: base64,
              // Attach to the open note when there is one, else make its own.
              noteId: S.current?.id
            })
            if (result?.extracted) extracted += 1
            if (result?.id) {
              const full = await rpc('get', { id: result.id })
              if (full) S.current = { id: full.id, title: full.title, body: full.body, tags: full.tags, files: full.files }
            }
          }
          saved += 1
        } catch (err) {
          S.error = `${file.name}：${err?.message ?? err}`
        }
      }
      S.busy = false
      S.status = saved > 0
        ? `已导入 ${saved} 个文件${extracted > 0 ? `（${extracted} 个已抽取文本，可搜索引用）` : ''}`
        : S.status
      await Promise.all([reloadList(), reloadTags()])
      emit()
    }

    /* ------------------------------------------------------------------ */
    /* note context menu (plain DOM, same skin as the cite overlay)         */
    /* ------------------------------------------------------------------ */

    let noteMenu = null

    function closeNoteMenu() {
      if (noteMenu) noteMenu.remove()
      noteMenu = null
    }

    async function copyToClipboard(text) {
      try {
        await navigator.clipboard.writeText(text)
        S.status = '已复制到剪贴板'
      } catch (err) {
        console.log(`${TAG} clipboard write failed:`, err?.message)
        S.status = '复制失败：浏览器拒绝了剪贴板访问'
      }
      emit()
    }

    async function noteFullText(note) {
      const full = await rpc('get', { id: note.id })
      const body = full?.body ?? note.excerpt ?? ''
      return `# ${full?.title || note.title}\n\n${body}\n`
    }

    async function removeNoteById(id) {
      const gone = await run(() => rpc('remove', { id }), '已删除')
      if (gone !== undefined) {
        if (S.current?.id === id) S.current = null
        await Promise.all([reloadList(), reloadTags()])
      }
      emit()
    }

    function openNoteMenu(note, x, y) {
      closeNoteMenu()
      noteMenu = document.createElement('div')
      noteMenu.className = 'kb-menu'

      /**
       * `keepOpen` items reuse this very element to swap in a prompt (rename
       * input, delete confirmation) — closing first would null the container
       * out from under them.
       */
      const addItem = (label, onClick, cls, keepOpen) => {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = cls ? `kb-menu-item ${cls}` : 'kb-menu-item'
        btn.textContent = label
        btn.addEventListener('click', () => {
          if (!keepOpen) closeNoteMenu()
          onClick()
        })
        noteMenu.appendChild(btn)
        return btn
      }
      const addSep = () => {
        const sep = document.createElement('div')
        sep.className = 'kb-menu-sep'
        noteMenu.appendChild(sep)
      }
      /** Swap the menu contents in place (rename prompt, delete confirmation). */
      const replaceMenu = (build) => {
        noteMenu.innerHTML = ''
        build()
      }

      addItem('打开', async () => {
        /** 导入的文档（HTML/Word/PDF…）带有附件 → 交系统默认程序打开原文件；
         *  纯手写笔记没有附件 → 进内置编辑器。 */
        let full = null
        try { full = await rpc('get', { id: note.id }) } catch { full = null }
        const files = full?.files ?? []
        if (files.length === 0) return openNote(note.id)
        if (files.length === 1) return openStored(files[0])
        replaceMenu(() => {
          files.forEach((stored) => addItem(`打开「${displayName(stored)}」`, () => openStored(stored)))
          addSep()
          addItem('在编辑器中打开', () => openNote(note.id))
        })
      })
      addItem('复制内容', async () => { await copyToClipboard(await noteFullText(note)) })
      addItem('剪切（复制后删除）', async () => {
        await copyToClipboard(await noteFullText(note))
        await removeNoteById(note.id)
      })
      addSep()
      addItem('重命名', () => {
        replaceMenu(() => {
          const input = document.createElement('input')
          input.className = 'kb-menu-input'
          input.value = note.title
          input.addEventListener('keydown', (ev) => {
            ev.stopPropagation()
            if (ev.key === 'Enter') commit()
            else if (ev.key === 'Escape') closeNoteMenu()
          })
          const commit = async () => {
            const next = input.value.trim()
            console.log(`${TAG} rename commit: "${note.title}" -> "${next}"`)
            closeNoteMenu()
            if (next === '' || next === note.title) {
              console.log(`${TAG} rename skipped (empty or unchanged)`)
              return
            }
            try {
              const done = await rpc('rename', { id: note.id, title: next })
              console.log(`${TAG} rename rpc returned:`, JSON.stringify(done))
              S.status = '已重命名'
              if (S.current?.id === note.id) S.current = { ...S.current, title: next }
              await Promise.all([reloadList(), reloadTags()])
            } catch (err) {
              console.log(`${TAG} rename FAILED:`, err?.message ?? err)
              S.error = `重命名失败：${err?.message ?? err}`
            }
            emit()
          }
          input.addEventListener('blur', closeNoteMenu, { once: true })
          noteMenu.appendChild(input)
          input.focus()
          input.select()
        })
      }, null, true)
      addItem('保存', async () => {
        if (S.current?.id !== note.id) await openNote(note.id)
        await saveNote()
      })
      addSep()
      addItem('删除', () => {
        replaceMenu(() => {
          const yes = document.createElement('button')
          yes.type = 'button'
          yes.className = 'kb-menu-item kb-menu-danger'
          yes.textContent = `确认删除「${note.title}」？`
          yes.addEventListener('click', () => { closeNoteMenu(); removeNoteById(note.id) })
          const no = document.createElement('button')
          no.type = 'button'
          no.className = 'kb-menu-item'
          no.textContent = '取消'
          no.addEventListener('click', closeNoteMenu)
          noteMenu.append(yes, no)
          yes.focus()
        })
      }, 'kb-menu-danger', true)

      document.body.appendChild(noteMenu)
      const rect = noteMenu.getBoundingClientRect()
      noteMenu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`
      noteMenu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`
    }

    /** Right-click on a directory: new subdirectory, rename, delete. */
    function openDirMenu(path, x, y) {
      closeNoteMenu()
      noteMenu = document.createElement('div')
      noteMenu.className = 'kb-menu'
      const addItem = (label, onClick, cls, keepOpen) => {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = cls ? `kb-menu-item ${cls}` : 'kb-menu-item'
        btn.textContent = label
        btn.addEventListener('click', () => {
          if (!keepOpen) closeNoteMenu()
          onClick()
        })
        noteMenu.appendChild(btn)
        return btn
      }
      const addSep = () => {
        const sep = document.createElement('div')
        sep.className = 'kb-menu-sep'
        noteMenu.appendChild(sep)
      }
      const askText = (initial, onCommit) => {
        noteMenu.innerHTML = ''
        const input = document.createElement('input')
        input.className = 'kb-menu-input'
        input.value = initial
        input.addEventListener('keydown', (ev) => {
          ev.stopPropagation()
          if (ev.key === 'Enter') {
            const value = input.value
            closeNoteMenu()
            onCommit(value)
          } else if (ev.key === 'Escape') closeNoteMenu()
        })
        noteMenu.appendChild(input)
        input.focus()
        input.select()
      }

      const total = notesUnder(path).length
      addItem('新建子目录', () => askText('', (name) => createSubDir(path, name)), null, true)

      if (path !== '') {
        addItem('重命名', () => askText(dirLeaf(path), async (next) => {
          const clean = String(next ?? '').trim()
          if (clean === '' || clean === dirLeaf(path)) return
          const parent = path.split('/').slice(0, -1).join('/')
          try {
            await rpc('renameDir', { from: path, to: parent === '' ? clean : `${parent}/${clean}` })
            S.status = '目录已重命名'
            await Promise.all([reloadDirs(), reloadList()])
          } catch (err) {
            S.error = `重命名失败：${err?.message ?? err}`
          }
          emit()
        }), null, true)
        addSep()
        addItem(`删除（将连带删除 ${total} 篇笔记）`, () => {
          noteMenu.innerHTML = ''
          const yes = document.createElement('button')
          yes.type = 'button'
          yes.className = 'kb-menu-item kb-menu-danger'
          yes.textContent = `确认删除「${dirLeaf(path)}」及其中 ${total} 篇笔记？`
          yes.addEventListener('click', async () => {
            closeNoteMenu()
            S.busy = true
            emit()
            try {
              const res = await rpc('removeDir', { dir: path, cascade: true })
              S.status = `已删除目录（连带 ${res?.removed ?? 0} 篇笔记）`
              S.expanded.delete(path)
              await Promise.all([reloadDirs(), reloadList(), reloadTags()])
            } catch (err) {
              S.error = `删除目录失败：${err?.message ?? err}`
            } finally {
              S.busy = false
              emit()
            }
          })
          const no = document.createElement('button')
          no.type = 'button'
          no.className = 'kb-menu-item'
          no.textContent = '取消'
          no.addEventListener('click', closeNoteMenu)
          noteMenu.append(yes, no)
          yes.focus()
        }, 'kb-menu-danger', true)
      }

      document.body.appendChild(noteMenu)
      const rect = noteMenu.getBoundingClientRect()
      noteMenu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`
      noteMenu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`
    }

    /** Right-click an attachment: open with the OS default program, or reveal in Explorer. */
    function openAttachmentMenu(stored, x, y) {
      closeNoteMenu()
      noteMenu = document.createElement('div')
      noteMenu.className = 'kb-menu'
      const addItem = (label, onClick, cls, keepOpen) => {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = cls ? `kb-menu-item ${cls}` : 'kb-menu-item'
        btn.textContent = label
        btn.addEventListener('click', () => {
          if (!keepOpen) closeNoteMenu()
          onClick()
        })
        noteMenu.appendChild(btn)
        return btn
      }
      addItem('打开', () => openStored(stored))
      addItem('定位', () => revealStored(stored))
      document.body.appendChild(noteMenu)
      const rect = noteMenu.getBoundingClientRect()
      noteMenu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`
      noteMenu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`
    }

    function installCiteOverlay() {
      if (typeof document === 'undefined' || typeof window === 'undefined') return
      let box = null
      let list = null
      let input = null
      let notes = []
      let cursor = 0

      const close = () => {
        if (box) box.remove()
        box = null
        list = null
        input = null
      }

      const render = () => {
        if (!list) return
        list.innerHTML = ''
        if (notes.length === 0) {
          const empty = document.createElement('div')
          empty.className = 'kb-cite-empty'
          empty.textContent = '没有匹配的笔记'
          list.appendChild(empty)
          return
        }
        notes.forEach((note, i) => {
          const row = document.createElement('button')
          row.type = 'button'
          row.className = i === cursor ? 'kb-cite-row kb-cite-active' : 'kb-cite-row'
          const title = document.createElement('span')
          title.className = 'kb-cite-title'
          title.textContent = note.title || '未命名笔记'
          const meta = document.createElement('span')
          meta.className = 'kb-cite-excerpt'
          meta.textContent = (note.tags ?? []).join(' / ') || note.excerpt || ''
          row.append(title, meta)
          row.addEventListener('click', () => { citeNote(note); close() })
          row.addEventListener('mouseenter', () => { cursor = i; render() })
          list.appendChild(row)
        })
      }

      const search = async (q) => {
        try {
          notes = await rpc('search', { query: q, limit: 8 })
        } catch (err) {
          notes = []
          console.log(`${TAG} cite search failed:`, err?.message)
        }
        cursor = 0
        render()
      }

      const open = () => {
        if (box) { close(); return }
        box = document.createElement('div')
        box.className = 'kb-cite'
        box.innerHTML =
          '<input class="kb-cite-input" placeholder="搜索知识库笔记，回车插入引用" />' +
          '<div class="kb-cite-list"></div>' +
          '<div class="kb-cite-hint">↑↓ 选择 · Enter 插入到对话 · Esc 关闭</div>'
        document.body.appendChild(box)
        input = box.querySelector('.kb-cite-input')
        list = box.querySelector('.kb-cite-list')
        input.addEventListener('input', () => { search(input.value) })
        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'ArrowDown') { cursor = Math.min(cursor + 1, notes.length - 1); render(); ev.preventDefault() } else if (ev.key === 'ArrowUp') { cursor = Math.max(cursor - 1, 0); render(); ev.preventDefault() } else if (ev.key === 'Enter') { if (notes[cursor]) { citeNote(notes[cursor]); close() } ev.preventDefault() } else if (ev.key === 'Escape') { close(); ev.preventDefault() }
        })
        search('')
        input.focus()
      }

      window.addEventListener('keydown', (ev) => {
        if (ev.ctrlKey && ev.altKey && String(ev.key).toLowerCase() === 'k') {
          ev.preventDefault()
          open()
        } else if (ev.key === 'Escape' && box) {
          close()
        }
      })
      document.addEventListener('mousedown', (ev) => {
        if (box && !box.contains(ev.target)) close()
      })
    }

    const S = {
      ready: false,
      notes: [],
      dirs: [],
      expanded: new Set(['']),
      query: '',
      tagFilter: [],
      tags: [],
      current: null,
      root: '',
      status: '',
      error: '',
      busy: false,
      subs: new Set()
    }
    const emit = () => { for (const fn of S.subs) fn() }
    function subscribe(fn) {
      S.subs.add(fn)
      return () => S.subs.delete(fn)
    }
    /** Re-render this component on any store change. */
    function useStore() {
      const [, bump] = useState(0)
      useEffect(() => subscribe(() => bump((n) => n + 1)), [])
      return S
    }

    async function run(fn, okMessage) {
      S.busy = true
      S.error = ''
      emit()
      try {
        const result = await fn()
        if (okMessage) S.status = okMessage
        return result
      } catch (err) {
        S.error = String(err?.message ?? err)
        return undefined
      } finally {
        S.busy = false
        emit()
      }
    }

    async function reloadTags() {
      try {
        S.tags = await rpc('tags')
      } catch {
        /* the tag strip is cosmetic; never block on it */
      }
    }

    async function reloadDirs() {
      try {
        S.dirs = await rpc('listDirs')
      } catch {
        S.dirs = []
      }
    }

    /**
     * The tree is derived on every render from two flat lists — directories
     * that exist on disk (including empty ones) and notes with their `dir`.
     * Directories are the source of truth; a folder holding no note still shows.
     */
    function childDirsOf(path) {
      const prefix = path === '' ? '' : `${path}/`
      return S.dirs.filter((d) => {
        if (prefix === '') return !d.includes('/')
        if (!d.startsWith(prefix)) return false
        return !d.slice(prefix.length).includes('/')
      })
    }
    const notesIn = (path) => S.notes.filter((n) => (n.dir || '') === path)
    const dirName = (path) => (path === '' ? '全部笔记' : path.split('/').pop())
    const dirLeaf = (path) => (path === '' ? '' : path.split('/').pop())

    function toggleDir(path) {
      if (S.expanded.has(path)) {
        // Collapsing the root would hide the library entirely.
        if (path !== '') S.expanded.delete(path)
      } else {
        S.expanded.add(path)
      }
      emit()
    }

    /** Notes directly inside a directory (root: everything). */
    function notesUnder(path) {
      if (path === '') return S.notes
      const prefix = `${path}/`
      return S.notes.filter((n) => (n.dir || '') === path || (n.dir || '').startsWith(prefix))
    }

    async function reloadList() {
      const data = await run(() =>
        S.query.trim() === ''
          ? rpc('list', { tags: S.tagFilter })
          : rpc('search', { query: S.query, tags: S.tagFilter })
      )
      if (Array.isArray(data)) S.notes = data
      return data
    }

    async function openNote(id) {
      const note = await run(() => rpc('get', { id }))
      if (note) {
        S.current = { id: note.id, title: note.title, body: note.body, tags: note.tags }
        S.status = ''
      }
      emit()
    }

    async function openStored(stored) {
      try {
        const res = await rpc('openAttachment', { stored })
        if (res?.ok) S.status = `已用系统默认程序打开「${displayName(stored)}」`
        else S.error = `打开失败：${res?.error ?? '未知原因'}`
      } catch (err) {
        S.error = `打开失败：${err?.message ?? err}`
      }
      emit()
    }

    async function revealStored(stored) {
      try {
        await rpc('revealAttachment', { stored })
        S.status = `已在资源管理器中定位「${displayName(stored)}」`
      } catch (err) {
        S.error = `定位失败：${err?.message ?? err}`
      }
      emit()
    }

    async function saveNote() {
      const cur = S.current
      if (!cur) return
      const saved = await run(
        () => rpc('save', {
          id: cur.id || undefined,
          title: cur.title,
          body: cur.body,
          tags: cur.tags,
          files: cur.files
        }),
        '已保存'
      )
      if (saved) {
        S.current = {
          id: saved.id,
          title: saved.title,
          body: cur.body,
          tags: saved.tags,
          files: saved.files ?? cur.files
        }
        await Promise.all([reloadList(), reloadTags()])
      }
      emit()
    }

    function newNote() {
      S.current = { id: '', title: '', body: '', tags: [] }
      S.status = '新建笔记：填好标题后保存'
      emit()
    }

    function toggleTag(tag) {
      const at = S.tagFilter.indexOf(tag)
      if (at === -1) S.tagFilter.push(tag)
      else S.tagFilter.splice(at, 1)
      emit()
      reloadList()
    }

    function touch(patch) {
      S.current = { ...S.current, ...patch }
      emit()
    }

    /* ------------------------------------------------------------------ */
    /* components                                                          */
    /* ------------------------------------------------------------------ */

    function formatTime(iso) {
      if (!iso) return ''
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return ''
      const pad = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    function NoteRow(props) {
      const note = props.note
      return h('div', {
        className: `kb-item${props.selected ? ' kb-selected' : ''}`,
        style: { paddingLeft: `${8 + (props.depth ?? 0) * 14}px` },
        onClick: props.onClick,
        draggable: true,
        onDragStart: (ev) => {
          ev.dataTransfer.setData('text/plain', note.id)
          ev.dataTransfer.effectAllowed = 'move'
        },
        onContextMenu: (ev) => {
          ev.preventDefault()
          openNoteMenu(props.note, ev.clientX, ev.clientY)
        }
      },
        h('div', { className: 'kb-item-title' },
          note.title || '未命名笔记',
          (note.files ?? []).length > 0
            ? h('span', { className: 'kb-item-badge' }, `${note.files.length} 附件`)
            : null
        ),
        note.excerpt ? h('div', { className: 'kb-item-excerpt' }, note.excerpt) : null,
        h('div', { className: 'kb-item-meta' },
          ...(note.tags ?? []).slice(0, 4).map((t) => h('span', { key: t, className: 'kb-tag' }, t)),
          h('span', { className: 'kb-time' }, formatTime(note.updated))
        )
      )
    }

    function clickableTag(tag, count, onToggle, active) {
      return h('button', {
        key: tag,
        className: 'kb-btn',
        style: active ? { borderColor: 'var(--accent, currentColor)' } : undefined,
        onClick: onToggle
      }, `${tag}${count ? ` ${count}` : ''}`)
    }

        /**
     * One directory row plus, when expanded, its sub-directories and notes.
     * Dropping a note row onto a directory row moves it there.
     */
    function DirNode(props) {
      const s = useStore()
      const path = props.path
      const depth = props.depth ?? 0
      const open = s.expanded.has(path)
      const kids = childDirsOf(path)
      const notes = notesIn(path)
      const total = notesUnder(path).length

      return h('div', null,
        h('div', {
          className: 'kb-tree-row',
          style: { paddingLeft: `${8 + depth * 14}px` },
          title: path === '' ? '根目录' : path,
          onClick: () => toggleDir(path),
          onDragOver: (ev) => {
            ev.preventDefault()
            ev.dataTransfer.dropEffect = 'move'
            ev.currentTarget.classList.add('kb-drop-target')
          },
          onDragLeave: (ev) => ev.currentTarget.classList.remove('kb-drop-target'),
          onDrop: async (ev) => {
            ev.preventDefault()
            ev.currentTarget.classList.remove('kb-drop-target')
            const id = ev.dataTransfer.getData('text/plain')
            if (!id || notes.some((n) => n.id === id)) return
            S.busy = true
            emit()
            try {
              await rpc('moveNote', { id, dir: path })
              S.status = `已移动到「${dirName(path)}」`
              S.expanded.add(path)
              await Promise.all([reloadList(), reloadDirs(), reloadTags()])
            } catch (err) {
              S.error = `移动失败：${err?.message ?? err}`
            } finally {
              S.busy = false
              emit()
            }
          },
          onContextMenu: (ev) => {
            ev.preventDefault()
            openDirMenu(path, ev.clientX, ev.clientY)
          }
        },
          h('span', { className: 'kb-tree-caret' }, kids.length + notes.length > 0 ? (open ? '▾' : '▸') : '·'),
          h('span', { className: 'kb-tree-name' }, dirName(path)),
          h('span', { className: 'kb-tree-count' }, String(total))
        ),
        open
          ? h('div', null,
              ...kids.map((k) => h(DirNode, { key: k, path: k, depth: depth + 1 })),
              ...notes.map((n) =>
                h(NoteRow, {
                  key: n.id,
                  note: n,
                  depth: depth + 1,
                  selected: s.current?.id === n.id,
                  onClick: () => openNote(n.id)
                })
              )
            )
          : null
      )
    }

    /** Create a subdirectory of `parent`; empty name becomes 新目录, deduped. */
    async function createSubDir(parent, name) {
      const base = String(name ?? '').trim() || '新目录'
      const scope = S.dirs.filter((d) => (parent === '' ? true : d.startsWith(`${parent}/`)))
      const taken = new Set(scope.map((d) => d.split('/').pop()))
      let finalName = base
      let counter = 2
      while (taken.has(finalName)) finalName = `${base} ${counter++}`
      const target = parent === '' ? finalName : `${parent}/${finalName}`
      try {
        await rpc('mkdirDir', { dir: target })
        S.expanded.add(parent)
        S.status = `已创建目录「${finalName}」`
        await reloadDirs()
      } catch (err) {
        S.error = `创建目录失败：${err?.message ?? err}`
      }
      emit()
    }

    function Editor() {
      const s = useStore()
      const cur = s.current

      useEffect(() => {
        const onKey = (ev) => {
          if ((ev.ctrlKey || ev.metaKey) && String(ev.key).toLowerCase() === 's') {
            ev.preventDefault()
            saveNote()
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [])

      if (!cur) {
        return h('div', { className: 'kb-empty' },
          '从左侧选一篇笔记，或点「新建」。',
          h('br'),
          '库位置 E:/dsh-kb/notes/ —— 每篇一个 .md，可直接用外部编辑器改'
        )
      }

      return h('div', { className: 'kb-editor' },
        h('input', {
          className: 'kb-titleinput',
          placeholder: '标题',
          value: cur.title,
          onChange: (ev) => touch({ title: ev.target.value })
        }),
        h('div', { className: 'kb-row' },
          h('input', {
            className: 'kb-input',
            placeholder: '标签，用逗号分隔',
            value: (cur.tags ?? []).join(', '),
            onChange: (ev) => touch({ tags: ev.target.value.split(',') })
          })
        ),
        h('textarea', {
          className: 'kb-ta',
          placeholder: '正文（Markdown）',
          value: cur.body,
          onChange: (ev) => touch({ body: ev.target.value })
        }),
        (cur.files ?? []).length > 0
          ? h('div', { className: 'kb-files' },
              ...cur.files.map((stored) =>
                h('div', {
                  className: 'kb-file',
                  key: stored,
                  onContextMenu: (ev) => { ev.preventDefault(); openAttachmentMenu(stored, ev.clientX, ev.clientY) }
                },
                  h('span', { className: 'kb-file-name', title: displayName(stored) }, displayName(stored)),
                  h('button', {
                    className: 'kb-btn',
                    title: '用系统默认程序打开（Word / Excel / PDF 阅读器…），也可右键此文件选择「打开」',
                    onClick: () => openStored(stored)
                  }, '打开'),
                  h('button', {
                    className: 'kb-btn',
                    title: '在资源管理器中定位',
                    onClick: () => revealStored(stored)
                  }, '定位')
                )
              )
            )
          : null,
        h('div', { className: 'kb-row' },
          h('button', {
            className: 'kb-btn kb-primary',
            onClick: saveNote,
            disabled: s.busy
          }, cur.id ? '保存 (Ctrl+S)' : '创建'),
          h('button', {
            className: 'kb-btn',
            title: '把这篇笔记以引用块插入对话输入框（也可在任意输入框按 Ctrl+Alt+K）',
            onClick: () => citeNote({ title: cur.title, body: cur.body, tags: cur.tags })
          }, '引用到对话'),
          h('span', { className: `kb-status${s.error ? ' kb-err' : ''}` },
            s.error || s.status || (cur.id ? formatTime(cur.updated) : '尚未保存'))
        )
      )
    }

    function KBPanel(props) {
      const s = useStore()
      const [dragging, setDragging] = useState(false)
      const [editingRoot, setEditingRoot] = useState(false)
      const [rootDraft, setRootDraft] = useState('')

      useEffect(() => {
        if (S.ready) return
        S.ready = true
        rpc('ping', {})
          .then((d) => { S.root = d?.stats?.root ?? ''; emit() })
          .catch(() => {})
        reloadDirs()
        reloadList().then(() => reloadTags())
      }, [])

      /** Drop any file(s) onto the library: text inlines, binaries attach. */
      const onDrop = async (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
        setDragging(false)
        const files = [...(ev.dataTransfer?.files ?? [])]
        if (files.length === 0) return
        await importDroppedFiles(files)
      }

      const applyRoot = async () => {
        const next = rootDraft.trim()
        if (next === '') return
        setEditingRoot(false)
        S.busy = true
        emit()
        try {
          const data = await rpc('configure', { root: next, migrate: true })
          S.root = data?.stats?.root ?? next
          S.status = `库位置已改为 ${S.root}，旧笔记已复制过去`
          S.current = null
          await Promise.all([reloadList(), reloadTags()])
        } catch (err) {
          S.error = String(err?.message ?? err)
        } finally {
          S.busy = false
          emit()
        }
      }

      return h('div', {
        className: `kb-panel${dragging ? ' kb-drop-active' : ''}`,
        onDragOver: (ev) => { ev.preventDefault(); if (!dragging) setDragging(true) },
        onDragLeave: (ev) => { if (ev.currentTarget === ev.target) setDragging(false) },
        onDrop
      },
        h('div', { className: 'kb-toolbar' },
          h('button', {
            className: 'kb-back',
            title: '回到聊天',
            onClick: () => props?.onClose?.()
          }, '← 返回聊天'),
          h('input', {
            className: 'kb-input',
            placeholder: '搜索标题 / 正文 / 标签',
            value: s.query,
            onChange: (ev) => { S.query = ev.target.value; emit() },
            onKeyDown: (ev) => { if (ev.key === 'Enter') reloadList() }
          }),
          h('button', { className: 'kb-btn', onClick: () => reloadList(), disabled: s.busy }, '搜索'),
          h('button', { className: 'kb-btn', onClick: () => createSubDir('', '') }, '新建目录'),
          h('button', { className: 'kb-btn kb-primary', onClick: newNote }, '新建'),
          h('button', {
            className: 'kb-btn',
            onClick: () => { S.query = ''; S.tagFilter = []; emit(); reloadList() }
          }, '清空')
        ),
        h('div', { className: 'kb-toolbar' },
          editingRoot
            ? h('span', { className: 'kb-status' }, '新位置：')
            : h('span', { className: 'kb-root', title: s.root }, `库位置：${s.root || '…'}`),
          editingRoot
            ? h('input', {
                className: 'kb-input kb-root-input',
                value: rootDraft,
                placeholder: '例如 D:/我的知识库',
                onChange: (ev) => setRootDraft(ev.target.value),
                onKeyDown: (ev) => { if (ev.key === 'Enter') applyRoot() }
              })
            : h('button', {
                className: 'kb-btn',
                onClick: () => { setRootDraft(s.root || ''); setEditingRoot(true) }
              }, '更改位置'),
          editingRoot
            ? h('button', { className: 'kb-btn kb-primary', onClick: applyRoot, disabled: s.busy }, '保存并迁移')
            : null,
          editingRoot
            ? h('button', { className: 'kb-btn', onClick: () => setEditingRoot(false) }, '取消')
            : h('span', { className: 'kb-status' }, '· 把文件拖进窗口即可导入'),
          s.error ? h('span', { className: 'kb-status kb-err' }, s.error) : null,
          !editingRoot && !s.error && s.status ? h('span', { className: 'kb-status' }, s.status) : null
        ),
        s.tags.length > 0
          ? h('div', { className: 'kb-toolbar' },
              h('span', { className: 'kb-status' }, '标签：'),
              ...s.tags.slice(0, 18).map((t) =>
                clickableTag(t.tag, t.count, () => toggleTag(t.tag), s.tagFilter.includes(t.tag))
              )
            )
          : null,
        h('div', { className: 'kb-body' },
          h('div', { className: 'kb-list' },
            s.dirs.length === 0 && s.notes.length === 0
              ? h('div', { className: 'kb-empty' }, s.busy ? '加载中…' : '还没有笔记')
              : h(DirNode, { path: '', depth: 0 })
          ),
          h(Editor, null)
        ),
        dragging ? h('div', { className: 'kb-drop-hint' }, '松手即可导入为笔记') : null
      )
    }

    function KBIcon(props) {
      const size = props?.size ?? 16
      return h('div', { className: 'kb-icon', title: '轻量知识库' },
        h('svg', {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round'
        },
          h('path', { d: 'M2.5 3.2c0-.5.4-.9.9-.9h4.2c.5 0 .9.4.9.9v9.6c0 .5-.4.9-.9.9H3.4c-.5 0-.9-.4-.9-.9z' }),
          h('path', { d: 'M9.5 3.2c0-.5.4-.9.9-.9h2.2c.5 0 .9.4.9.9v9.6c0 .5-.4.9-.9.9h-2.2c-.5 0-.9-.4-.9-.9z' })
        )
      )
    }

    /**
     * Turn-tail occupant: one button per finished turn. Clicking runs the host
     * extraction (nothing is written), then offers an editable checklist and
     * only `save`s what the user kept checked.
     * phase: idle → loading → review | empty → writing → done
     */
    function WritebackTail(props) {
      const [phase, setPhase] = useState('idle')
      const [candidates, setCandidates] = useState([])
      const [edits, setEdits] = useState({})
      const [route, setRoute] = useState('')
      const [error, setError] = useState('')
      const [written, setWritten] = useState(0)

      const run = async () => {
        setPhase('loading')
        setError('')
        try {
          const data = await rpc('extract', { turn: props?.turn, seq: props?.seq })
          if (!Array.isArray(data?.candidates) || data.candidates.length === 0) {
            setPhase('empty')
            return
          }
          const init = {}
          data.candidates.forEach((c, i) => {
            init[i] = { checked: true, title: c.title, tags: (c.tags ?? []).join(', ') }
          })
          setCandidates(data.candidates)
          setEdits(init)
          setRoute(`${data.route?.provider ?? ''}/${data.route?.model ?? ''}`)
          setPhase('review')
        } catch (err) {
          setError(String(err?.message ?? err))
          setPhase('idle')
        }
      }

      const confirm = async () => {
        setPhase('writing')
        let count = 0
        for (let i = 0; i < candidates.length; i += 1) {
          const edit = edits[i]
          if (!edit?.checked) continue
          try {
            await rpc('save', {
              title: edit.title,
              body: candidates[i].body,
              tags: edit.tags,
              source: 'conversation'
            })
            count += 1
          } catch (err) {
            setError(`第 ${i + 1} 条写入失败：${err?.message ?? err}`)
          }
        }
        setWritten(count)
        setPhase('done')
      }

      const patch = (i, part) => setEdits({ ...edits, [i]: { ...edits[i], ...part } })

      if (phase === 'idle') {
        return h('button', {
          className: 'kb-btn kb-tail-btn',
          title: '用 AI 从这一轮抽取可复用的知识点，确认后存入知识库',
          onClick: run
        }, error ? `重试抽取${error ? `（${error.slice(0, 60)}）` : ''}` : '存入知识库')
      }
      if (phase === 'loading') return h('span', { className: 'kb-tail-status' }, 'AI 抽取中…')
      if (phase === 'empty') return h('span', { className: 'kb-tail-status' }, '这一轮没有值得保存的知识点')
      if (phase === 'writing') return h('span', { className: 'kb-tail-status' }, '写入中…')
      if (phase === 'done') {
        return h('span', { className: 'kb-tail-status' },
          `已写入 ${written} 条` + (error ? `（${error}）` : '') + ' — 打开左栏「知识库」查看')
      }

      return h('div', { className: 'kb-tail' },
        h('div', { className: 'kb-tail-title' }, `AI 找到 ${candidates.length} 条候选：`),
        ...candidates.map((c, i) =>
          h('div', { className: 'kb-tail-item', key: i },
            h('label', { className: 'kb-tail-check' },
              h('input', {
                type: 'checkbox',
                checked: edits[i]?.checked ?? false,
                onChange: (ev) => patch(i, { checked: ev.target.checked })
              })
            ),
            h('div', { className: 'kb-tail-fields' },
              h('input', {
                className: 'kb-input',
                value: edits[i]?.title ?? '',
                placeholder: '标题',
                onChange: (ev) => patch(i, { title: ev.target.value })
              }),
              h('input', {
                className: 'kb-input kb-tail-tags',
                value: edits[i]?.tags ?? '',
                placeholder: '标签（逗号分隔）',
                onChange: (ev) => patch(i, { tags: ev.target.value })
              }),
              h('pre', { className: 'kb-tail-body' }, c.body)
            )
          )
        ),
        h('div', { className: 'kb-row' },
          h('button', { className: 'kb-btn kb-primary', onClick: confirm }, '写入选中的'),
          h('button', { className: 'kb-btn', onClick: () => setPhase('idle') }, '取消'),
          h('span', { className: 'kb-tail-route' }, route)
        )
      )
    }

    /* ------------------------------------------------------------------ */
    /* plugin                                                              */
    /* ------------------------------------------------------------------ */

    exports.name = 'dsh-knowledge-lite'
    // Cordis service declaration — `ctx.slots` / `ctx.layout` are unreachable
    // without it (the guard facade whitelists nothing else).
    exports.inject = ['slots', 'layout']

    exports.apply = (ctx) => {
      installStyles()
      installCiteOverlay()
      // Dismiss the note menu the way every desktop app does.
      window.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') closeNoteMenu()
      })
      document.addEventListener('mousedown', (ev) => {
        if (noteMenu && !noteMenu.contains(ev.target)) closeNoteMenu()
      })

      const pick = (name) => ctx?.[name] ?? (typeof ctx?.get === 'function' ? ctx.get(name) : null)
      const slots = pick('slots')
      const layout = pick('layout')
      if (!slots || typeof slots.register !== 'function') {
        console.warn(`${TAG} no slots service — cannot mount`)
        return
      }
      console.log(`${TAG} apply; layout =`, Boolean(layout))

      const closePanel = () => {
        try {
          if (layout && typeof layout.selectPanel === 'function') {
            layout.selectPanel(null)
            return
          }
        } catch (err) {
          console.warn(`${TAG} selectPanel(null) failed`, err)
        }
        S.status = '无法返回聊天：layout 服务不可用'
        emit()
      }

      /**
       * Register into `name` once it is declared. The shell declares the
       * sidebar/conversation seats after plugins apply, so a direct register
       * throws "not declared"; `subscribe` is documented to accept subscriptions
       * ahead of declaration, and a short poll covers the gap around it.
       *
       * `optionVariants` is tried in order: the published 0.2.0-rc.2 types and
       * the running shell disagree about `conversation.chat.turnTail`
       * (types say chain-with-select, the shell validates it as a list needing
       * an id), so we carry both shapes rather than betting on one.
       */
      const registerWhenReady = (name, optionVariants, component) => {
        let done = false
        let lastError = null
        const attempt = () => {
          if (done) return true
          for (const options of optionVariants) {
            try {
              slots.register({ name, ...options }, component)
              done = true
              console.log(`${TAG} registered ${name}`)
              return true
            } catch (err) {
              lastError = err
            }
          }
          return false
        }
        if (attempt()) return
        if (typeof slots.subscribe === 'function') {
          const off = slots.subscribe(name, () => {
            if (attempt() && typeof off === 'function') off()
          })
        }
        let tries = 0
        const timer = window.setInterval(() => {
          tries += 1
          if (attempt()) {
            window.clearInterval(timer)
            return
          }
          if (tries >= 25) {
            window.clearInterval(timer)
            // Surface why: a malformed option shape would otherwise fail
            // silently forever.
            console.log(`${TAG} GIVE UP registering ${name} after ${tries} polls; last error:`, lastError?.message ?? lastError)
          }
        }, 400)
      }

      // 1. the library itself, as a centre-column panel
      registerWhenReady('main', [{ key: PANEL_ID }], () => h(KBPanel, { onClose: closePanel }))
      // 2. ONE sidebar entry, rendered by the shell exactly like its other
      //    panel rows (icon + label, full width). A second launcher at the
      //    sidebar foot was redundant and rendered as a cramped vertical chip,
      //    so it is gone.
      registerWhenReady('sidebar.panellist', [{ id: PANEL_ID, order: 40, label: '知识库' }], KBIcon)
      // 4. per-turn extraction entry at the end of each completed turn.
      //    `conversation.chat.turnTail` is a CHAIN slot, so it needs `select`;
      //    returning a truthy match claims every turn (we render our own
      //    single button rather than composing into someone else's selector).
      registerWhenReady('conversation.chat.turnTail', [
        { id: 'kb-writeback', select: () => true, priority: 5 },
        { select: () => true, priority: 5 },
        { id: 'kb-writeback', priority: 5 }
      ], WritebackTail)

      // Warm the channel so the first open feels instant.
      rpc('ping', {})
        .then((data) => console.log(`${TAG} rpc ok; notes =`, data?.stats?.count))
        .catch((err) => console.log(`${TAG} rpc FAILED: ${err?.message}`))
    }

    return exports
  }
})
