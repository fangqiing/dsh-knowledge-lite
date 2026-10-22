/**
 * dsh-knowledge-lite · writeback (host half)
 *
 * Conversation turn → LLM extraction → user-confirmed note writes.
 *
 * The LLM request shape is replicated from @lemoncat7/dsh-knowledge's
 * extraction module (proven against dsh 0.2.0-rc.2):
 *
 *   ctx.llm.stream({ provider, model, messages, system, maxTokens,
 *                     temperature, signal, sessionId })
 *     chunk.type: 'text-delta' | 'block-end' | 'finish'
 *
 * Turn capture mirrors its snapshotTurn(): slice session events between
 * turn/start markers, keep the last non-empty assistant message, and reuse
 * that message's provider/model as the extraction route.
 *
 * Simplified to the three stages the plan keeps — extract → confirm → write.
 * The confirmation UI lives in the browser half; this module only produces
 * candidates and writes the approved ones.
 */

import { DEFAULT_ROUTE, EXTRACTION_SYSTEM_PROMPT } from './writeback-prompts.js'

const MAX_INPUT_CHARS = 16000
const MAX_TURNS_PER_SESSION = 40
const MAX_TOKENS = 2000
const TIMEOUT_MS = 60000

export { messageText, parseJsonArray, sanitizeCandidates }

/** Text content of a message (same shape dsh-knowledge's runtime helper uses). */
function messageText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text ?? '')
    .join('\n')
    .trim()
}

/** True when a message carries a non-text block (file / image / attachment…). */
function messageHasAttachment(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks.some((b) => b && typeof b.type === 'string' && b.type !== 'text')
}

/** Parse a model answer that may be bare JSON or fenced with ```json … ```. */
function parseJsonArray(text) {
  const raw = String(text ?? '').trim()
  const candidates = [raw]
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  if (fence) candidates.unshift(fence[1].trim())
  for (const attempt of candidates) {
    const start = attempt.indexOf('[')
    const end = attempt.lastIndexOf(']')
    const slice = start >= 0 && end > start ? attempt.slice(start, end + 1) : attempt
    try {
      const parsed = JSON.parse(slice)
      if (Array.isArray(parsed)) return parsed
    } catch {
      /* try the next shape */
    }
  }
  return null
}

/** Keep only structurally sane candidates; stop once we have enough. */
function sanitizeCandidates(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const item of list) {
    // Filter first, cap second: a model that pads its answer with junk must not
    // push real candidates past the limit.
    if (out.length >= 5) break
    if (!item || typeof item !== 'object') continue
    const title = typeof item.title === 'string' ? item.title.trim() : ''
    const body = typeof item.body === 'string' ? item.body.trim() : ''
    if (!title || !body) continue
    const tags = Array.isArray(item.tags)
      ? item.tags
          .map((t) => (typeof t === 'string' ? t.trim() : ''))
          .filter((t) => t !== '')
          .slice(0, 4)
      : []
    out.push({ title: title.slice(0, 120), body, tags })
  }
  return out
}

/**
 * Tolerant locator parse: the browser half hands us the turnTail props
 * verbatim (TurnLocation's exact shape is the shell's business), plus its own
 * `seq` hint. We accept a bare number, an object with a turn-ish field, or
 * fall back to the single observed session.
 * @param locator unknown props from the browser half
 * @param onlySessionId fallback when exactly one session has been observed
 * @returns {{sessionId?: string, turn?: number}}
 */
export function resolveTurnLocator(locator, onlySessionId) {
  const raw = locator ?? {}
  let turn
  const t = raw.turn
  if (typeof t === 'number') turn = t
  else if (t && typeof t === 'object') {
    for (const key of ['turn', 'number', 'index', 'seq', 'n']) {
      if (typeof t[key] === 'number') { turn = t[key]; break }
    }
  }
  if (turn === undefined && typeof raw.seq === 'number') turn = raw.seq

  let sessionId
  const sources = [raw, t && typeof t === 'object' ? t : {}]
  for (const source of sources) {
    for (const key of ['sessionId', 'session', 'id']) {
      const value = source?.[key]
      if (typeof value === 'string' && value) { sessionId = value; break }
    }
    if (sessionId) break
  }
  if (!sessionId && onlySessionId) sessionId = onlySessionId
  return { sessionId, turn }
}

export class Writeback {
  /**
   * @param ctx Cordis context (needs `llm` service and `session/event` events)
   * @param store NoteStore instance for approved writes
   */
  constructor(ctx, store) {
    this.ctx = ctx
    this.store = store
    /** sessionId -> { session, current, turns: Map<turn, snapshot>, order: [] } */
    this.sessions = new Map()
    this.disposers = []
    this.attached = false
  }

  /** Start listening to conversation events. Idempotent. */
  attach() {
    if (this.attached) return
    this.attached = true
    const off = this.ctx.on('session/event', (session, event) => {
      try {
        this.#ingest(session, event)
      } catch (err) {
        this.ctx.logger?.warn?.(`kb-lite writeback ingest failed: ${err?.message ?? err}`)
      }
    })
    this.disposers.push(off)
  }

  detach() {
    for (const off of this.disposers.splice(0)) {
      try { off() } catch { /* disposal is best-effort */ }
    }
    this.attached = false
  }

  /* ---------------------------------------------------------------- */
  /* capture                                                          */
  /* ---------------------------------------------------------------- */

  #bucket(session) {
    const id = session?.id ?? 'unknown'
    let per = this.sessions.get(id)
    if (!per) {
      per = { session, current: null, turns: new Map(), order: [] }
      this.sessions.set(id, per)
      if (this.sessions.size > 12) {
        // drop the oldest bucket entirely; sessions map order = insertion order
        const firstKey = this.sessions.keys().next().value
        this.sessions.delete(firstKey)
      }
    }
    per.session = session
    return per
  }

  #ingest(session, event) {
    const per = this.#bucket(session)
    const type = event?.type

    if (type === 'turn/start') {
      this.#seal(per)
      const turn = event?.data?.turn
      per.current = turn === undefined ? null : { turn, userParts: [], assistantText: '', route: null, hasAttachment: false }
      return
    }

    if (!per.current) return

    if (type === 'user/message') {
      const message = event?.data
      if (message?.source?.kind === 'user') {
        const text = messageText(message)
        if (text) per.current.userParts.push(text)
        if (messageHasAttachment(message)) per.current.hasAttachment = true
      }
      return
    }

    if (type === 'assistant/message') {
      const data = event?.data
      if (data?.turn !== per.current.turn) return
      const message = data?.message
      if (!message) return
      const text = messageText(message)
      if (!text) return
      per.current.assistantText = text
      const provider = message?.source?.provider
      const model = message?.source?.model
      if (provider && model) per.current.route = { provider, model }
    }
  }

  /** Freeze the in-progress turn into the per-session ring. */
  #seal(per) {
    const cur = per.current
    per.current = null
    if (!cur) return
    const userText = cur.userParts.join('\n\n').slice(0, Math.floor(MAX_INPUT_CHARS * 0.4))
    const assistantText = cur.assistantText.slice(0, Math.floor(MAX_INPUT_CHARS * 0.6))
    if (!userText || !assistantText) return
    per.turns.set(cur.turn, { turn: cur.turn, userText, assistantText, route: cur.route, hasAttachment: cur.hasAttachment })
    per.order.push(cur.turn)
    while (per.order.length > MAX_TURNS_PER_SESSION) {
      per.turns.delete(per.order.shift())
    }
  }

  /* ---------------------------------------------------------------- */
  /* extraction                                                       */
  /* ---------------------------------------------------------------- */

  /** Tolerant locator parse (see resolveTurnLocator). */
  #resolveLocator(locator) {
    const onlySessionId = this.sessions.size === 1 ? this.sessions.keys().next().value : undefined
    return resolveTurnLocator(locator, onlySessionId)
  }

  /** Snapshot one turn, preferring the live cache, falling back to a rescan. */
  #snapshotFor(sessionId, turn) {
    const per = this.sessions.get(sessionId)
    if (!per) return undefined
    if (turn !== undefined && per.turns.has(turn)) return per.turns.get(turn)
    // Fall back to a full rescan for historical turns (same shape as
    // snapshotTurn in the reference plugin).
    const session = per.session
    if (!session || typeof session.snapshotEvents !== 'function') return undefined
    const events = session.snapshotEvents()
    let start = -1
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i]
      if (e?.type === 'turn/start' && e?.data?.turn === turn) { start = i; break }
    }
    if (start < 0) return undefined
    const nextOffset = events.slice(start + 1).findIndex((e) => e?.type === 'turn/start')
    const turnEvents = events.slice(start, nextOffset < 0 ? undefined : start + 1 + nextOffset)
    const userText = turnEvents
      .filter((e) => e?.type === 'user/message' && e?.data?.source?.kind === 'user')
      .map((e) => messageText(e.data))
      .filter(Boolean)
      .join('\n\n')
      .slice(0, Math.floor(MAX_INPUT_CHARS * 0.4))
    let assistantText = ''
    let route = null
    for (let i = turnEvents.length - 1; i >= 0; i -= 1) {
      const e = turnEvents[i]
      if (e?.type !== 'assistant/message' || e?.data?.turn !== turn) continue
      const message = e.data.message
      const text = message ? messageText(message) : ''
      if (text) {
        assistantText = text.slice(0, Math.floor(MAX_INPUT_CHARS * 0.6))
        if (message?.source?.provider && message?.source?.model) {
          route = { provider: message.source.provider, model: message.source.model }
        }
        break
      }
    }
    if (!userText || !assistantText) return undefined
    const hasAttachment = turnEvents
      .filter((e) => e?.type === 'user/message' && e?.data?.source?.kind === 'user')
      .some((e) => messageHasAttachment(e.data))
    return { turn, userText, assistantText, route, hasAttachment }
  }

  /** One streaming LLM call (shape copied from the reference plugin). */
  async #callModel(route, userText, assistantText, sessionId) {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new Error('kb-lite extraction timed out')),
      TIMEOUT_MS
    )
    let deltas = ''
    let completed = ''
    let finish
    try {
      const options = {
        provider: route.provider,
        model: route.model,
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: JSON.stringify({ user: userText, assistant: assistantText }) }]
        }],
        system: EXTRACTION_SYSTEM_PROMPT,
        maxTokens: MAX_TOKENS,
        temperature: 0,
        signal: controller.signal
      }
      if (sessionId) options.sessionId = sessionId
      for await (const chunk of this.ctx.llm.stream(options)) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') deltas += chunk.text
        if (chunk?.type === 'block-end' && chunk?.block?.type === 'text') completed += chunk.block.text ?? ''
        if (chunk?.type === 'finish' && chunk && 'reason' in chunk) finish = chunk.reason
      }
    } finally {
      clearTimeout(timer)
    }
    const text = deltas.length > 0 ? deltas : completed
    if (finish && finish.kind === 'error') {
      throw new Error(finish.failure?.message ?? 'extraction model error')
    }
    return text
  }

  /**
   * Produce note candidates for one conversation turn.
   * @param locator {{turn?: unknown, seq?: number}} turnTail props from the browser half
   * @returns {{turn?: number, route: {provider: string, model: string}, candidates: Array<{title: string, body: string, tags: string[]}>}}
   */
  async extract(locator) {
    const { sessionId, turn } = this.#resolveLocator(locator)
    if (!sessionId) {
      throw new Error('无法定位会话：这个会话还没有被知识库观察到（重启后先聊一轮）')
    }
    const snapshot = this.#snapshotFor(sessionId, turn)
    if (!snapshot) {
      throw new Error(`没有找到可抽取的轮次（session=${sessionId.slice(0, 8)}…, turn=${turn ?? '?'}）`)
    }

    // Attachment-scoped writeback: a plain text turn must not trigger the
    // extraction model. The browser half hides the button on such turns too —
    // this is the second guard, so a stale cache or a direct call cannot fire.
    if (!snapshot.hasAttachment) {
      return {
        turn: snapshot.turn,
        route: snapshot.route ?? DEFAULT_ROUTE,
        candidates: [],
        skipped: true,
        reason: 'no-attachment'
      }
    }

    const route = snapshot.route ?? DEFAULT_ROUTE
    let text
    try {
      text = await this.#callModel(route, snapshot.userText, snapshot.assistantText, sessionId)
    } catch (err) {
      throw new Error(`抽取模型调用失败（${route.provider}/${route.model}）：${err?.message ?? err}`)
    }

    const candidates = sanitizeCandidates(parseJsonArray(text))
    return {
      turn: snapshot.turn,
      route,
      candidates
    }
  }

  /**
   * Whether a conversation turn carried a user-supplied attachment (document,
   * image, file…). The browser half uses this to hide the writeback button on
   * plain text turns. Mirrors the capture done in #ingest.
   *
   * Fails open (returns true) when the session/turn cannot be inspected, so a
   * transient blind spot never silently suppresses a legitimate writeback.
   * @param {object} locator {turn?: unknown, seq?: number}
   * @returns {Promise<boolean>}
   */
  async hasAttachment(locator) {
    const { sessionId, turn } = this.#resolveLocator(locator)
    if (!sessionId) return false
    const per = this.sessions.get(sessionId)
    if (per) {
      if (turn !== undefined && per.turns.has(turn)) {
        return per.turns.get(turn).hasAttachment === true
      }
      const session = per.session
      if (session && typeof session.snapshotEvents === 'function') {
        const events = session.snapshotEvents()
        let start = -1
        for (let i = events.length - 1; i >= 0; i -= 1) {
          const e = events[i]
          if (e?.type === 'turn/start' && e?.data?.turn === turn) { start = i; break }
        }
        if (start >= 0) {
          const nextOffset = events.slice(start + 1).findIndex((e) => e?.type === 'turn/start')
          const turnEvents = events.slice(start, nextOffset < 0 ? undefined : start + 1 + nextOffset)
          return turnEvents
            .filter((e) => e?.type === 'user/message' && e?.data?.source?.kind === 'user')
            .some((e) => messageHasAttachment(e.data))
        }
      }
      // Observed session, but this turn is unknown → don't suppress silently.
      return true
    }
    // Session never observed (no events seen yet) → cannot prove absence.
    return true
  }

  /** Write the approved candidates (called once per confirmed note). */
  async write(candidate) {
    return this.store.save({
      id: candidate.id,
      title: candidate.title,
      body: candidate.body,
      tags: candidate.tags,
      source: 'conversation'
    })
  }
}
