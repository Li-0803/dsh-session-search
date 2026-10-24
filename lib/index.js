/**
 * dsh-session-search - host half.
 *
 * 会话全文搜索（主机端实现）。直接在主机读 ~/.dsh/sessions 下的全部
 * session .jsonl.zstd 会话文件，用 node:zlib 按 Zstandard 帧解压成 JSONL，解析出：
 *   - 会话标题（session/title 事件）
 *   - 每条 user/ds 消息（user/message、assistant/message 事件）
 * 再按关键词做本地全文匹配，返回「按会话标题分组的命中列表」。
 *
 * 浏览器半边走同源 JSON 端点：
 *   GET /api/dsh-session-search?q=<关键词>&party=<all|ds|user>
 *
 * 零第三方依赖：解压用 Node 内置 node:zlib（DSH 自身也用同一 API），
 * 帧扫描用 Zstandard magic 定位（与 DSH 的 scanZstdFrames 同一思路）。
 * @module dsh-session-search
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

export const name = 'dsh-session-search'
export const inject = ['webServer']

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** DSH 会话目录：$DSH_HOME 或 ~/.dsh。 */
function sessionsRoot() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
}

/** 按 Zstandard magic 定位完整帧（DSH 的 scanZstdFrames 的同思路，简化实现）。 */
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = buffer.indexOf(ZSTD_MAGIC, offset)
    if (start === -1) break
    const next = buffer.indexOf(ZSTD_MAGIC, start + 4)
    const end = next === -1 ? buffer.length : next
    frames.push({ start, end })
    offset = next === -1 ? buffer.length : next
  }
  return frames
}

/** 解压一个 .jsonl.zstd 会话文件为完整文本（多帧拼接）。 */
function decompressSession(filePath) {
  const buffer = readFileSync(filePath)
  let full = ''
  for (const frame of scanZstdFrames(buffer)) {
    try { full += zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8') }
    catch (error) {
      console.warn('[dsh-session-search] 会话帧解压失败，已跳过该帧:', error instanceof Error ? error.message : String(error))
    }
  }
  return full
}

/** 把 content（字符串或 block 数组）展平为纯文本。 */
function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((b) => b?.type === 'text' ? b.text : (typeof b === 'string' ? b : '')).join('')
  if (content && typeof content === 'object') return textOf(content.text ?? content.content ?? '')
  return ''
}

/** 单条命中返回的最大字符数（避免整段正文塞进响应）。 */
const SNIPPET_MAX = 300
/** 关键词长度上限；搜索与客户端高亮共用同一截断规则，避免两者不一致。 */
const QUERY_MAX = 500
/** 单次搜索返回的最大命中条数（跨会话合计）。 */
const MATCH_LIMIT = 200
/** 单次搜索返回的最大会话分组数。 */
const GROUP_LIMIT = 50

/**
 * 截取命中词周边的片段（无命中词时取开头），并标注是否被截断。
 * @param {string} text - 消息正文。
 * @param {string} ql - 小写化后的关键词。
 * @returns {{ text: string, truncated: boolean }} 片段与截断标记。
 */
export function snippetOf(text, ql) {
  const source = typeof text === 'string' ? text : ''
  if (source.length <= SNIPPET_MAX) return { text: source, truncated: false }
  const at = ql ? source.toLowerCase().indexOf(ql) : -1
  if (at < 0) return { text: source.slice(0, SNIPPET_MAX), truncated: true }
  // 命中词居中：前后各留一半窗口
  const half = Math.floor(SNIPPET_MAX / 2)
  const start = Math.max(0, at - half)
  const end = Math.min(source.length, start + SNIPPET_MAX)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < source.length ? '…' : ''
  return { text: prefix + source.slice(start, end) + suffix, truncated: true }
}

/**
 * DSH chat 节点的锚点规则（与 DOM 上 `data-chat-anchor-key` 一致）：
 *   `${kind.length}:${kind}${id}`
 *
 * 已核对 DSH 源码（dsh-client-ui-conversation 的 chatNode / 各节点 definition）：
 *  - 用户消息：kind = `input-message`，id = `String(event.data.id)`
 *    且仅当 `event.data.source.kind === 'user'` 时才落为 input-message 节点
 *    （plugin / skill-catalog 等来源会落为 `context` 节点，锚点格式不同）。
 *  - 助手消息：kind = `assistant-step`，id = `${event.data.turn}:${event.data.step}`。
 */
const CHAT_NODE_KIND_INPUT = 'input-message'
const CHAT_NODE_KIND_ASSISTANT = 'assistant-step'

/**
 * 用户消息的锚点 key。
 * @param {string|number} messageId - user/message 事件的 data.id。
 * @returns {string} 与 DOM 一致的锚点。
 */
export function inputAnchorKey(messageId) {
  return `${CHAT_NODE_KIND_INPUT.length}:${CHAT_NODE_KIND_INPUT}${messageId}`
}

/**
 * 助手消息的锚点 key。
 * @param {string|number} turn - 事件的 data.turn。
 * @param {string|number} step - 事件的 data.step。
 * @returns {string} 与 DOM 一致的锚点。
 */
export function assistantAnchorKey(turn, step) {
  return `${CHAT_NODE_KIND_ASSISTANT.length}:${CHAT_NODE_KIND_ASSISTANT}${turn}:${step}`
}

/** 从一个会话的完整事件流中解析出标题 + 每条 user/ds 消息（含时间与锚点，按时间倒序）。 */
export function parseHistory(text) {
  let title = null
  const msgs = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let obj
    try { obj = JSON.parse(line) } catch { continue }
    const type = obj?.type
    const data = obj?.data ?? {}
    const time = typeof obj?.time === 'number' ? obj.time : undefined
    if (type === 'user/message') {
      const t = textOf(data.content) || textOf(data.message?.content)
      // 只有 source.kind === 'user' 才落为 input-message 节点（可被锚点定位）
      const isUserNode = data.source?.kind === 'user' && data.id != null
      const anchorKey = isUserNode ? inputAnchorKey(String(data.id)) : null
      if (t) msgs.push({ role: 'user', text: t, time, anchorKey })
    } else if (type === 'assistant/message') {
      const t = textOf(data.message?.content) || textOf(data.content)
      const hasAnchor = data.turn != null && data.step != null
      const anchorKey = hasAnchor ? assistantAnchorKey(data.turn, data.step) : null
      if (t) msgs.push({ role: 'ds', text: t, time, anchorKey })
    } else if (type === 'session/title' || type === 'title' || type === 'session/rename') {
      title = textOf(data.title ?? data.content ?? data) || title
    }
  }
  // 按时间倒序（最近的在前）；无时间的按原顺序
  msgs.sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
  return { title, msgs }
}

/** 遍历所有工作区下的会话文件。 */
function collectSessionFiles() {
  const root = sessionsRoot()
  const files = []
  if (!existsSync(root)) return files
  for (const ws of readdirSync(root)) {
    if (!ws.startsWith('--')) continue
    const wsPath = join(root, ws)
    for (const name of ['session.v4.jsonl.zstd', 'session.jsonl.zstd']) {
      const f = join(dir, name)
      if (existsSync(f)) { chosen = f; break }
    }
  }
  return files
}

/** 关键词本地全文搜索：返回按会话分组的命中（会话按最新活跃时间倒序）。 */
function searchSessions(query, partySel) {
  const ql = query.toLowerCase()
  const groups = []
  for (const { sessionId, file } of collectSessionFiles()) {
    try {
      const text = decompressSession(file)
      const parsed = parseHistory(text)
      const hits = parsed.msgs.filter((m) => {
        const hit = m.text.toLowerCase().includes(ql)
        if (!hit) return false
        if (partySel === 'all') return true
        return m.role === partySel
      })
      if (hits.length > 0) {
        // 只回片段（命中词居中），不回整段正文；并记录该会话真实命中总数
        const msgs = hits.map((m) => {
          const snip = snippetOf(m.text, ql)
          // anchorKey 是定位的唯一依据（关键词仅用于高亮）
          return { role: m.role, text: snip.text, time: m.time, truncated: snip.truncated, anchorKey: m.anchorKey ?? null }
        })
        groups.push({ sessionId, title: parsed.title, msgs, hitTotal: hits.length, lastTime: msgs[0]?.time ?? 0 })
      }
    } catch (error) {
      console.warn('[dsh-session-search] 会话读取失败，已跳过:', sessionId, error instanceof Error ? error.message : String(error))
    }
  }
  groups.sort((a, b) => (b.lastTime ?? 0) - (a.lastTime ?? 0))
  // 限制响应规模：先截会话数，再截跨会话的总命中条数
  const limitedGroups = groups.slice(0, GROUP_LIMIT)
  let remaining = MATCH_LIMIT
  const capped = []
  for (const g of limitedGroups) {
    if (remaining <= 0) break
    const kept = g.msgs.slice(0, remaining)
    remaining -= kept.length
    capped.push({ ...g, msgs: kept, capped: kept.length < g.msgs.length })
  }
  return { groups: capped, groupTotal: groups.length, matchLimit: MATCH_LIMIT, groupLimit: GROUP_LIMIT }
}

/** 无关键词：列出全部会话（标题 + user/ds 各取一条样例消息，可按对话方过滤），按会话最新活跃时间倒序。 */
function listAllSessions(partySel = 'all') {
  const groups = []
  for (const { sessionId, file } of collectSessionFiles()) {
    try {
      const text = decompressSession(file)
      const parsed = parseHistory(text)  // msgs 已按时间倒序
      const msgs = []
      if (partySel === 'all') {
        // 全部：取最近的 user 和最近的 ds，再按时间倒序合并
        const u = parsed.msgs.find((m) => m.role === 'user')
        const d = parsed.msgs.find((m) => m.role === 'ds')
        const picked = [u, d].filter(Boolean)
        picked.sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
        msgs.push(...picked)
      } else {
        const m = parsed.msgs.find((x) => x.role === partySel)
        if (m) msgs.push(m)
      }
      const lastTime = parsed.msgs[0]?.time ?? 0  // 会话最新消息时间（parseHistory 已倒序）
      groups.push({ sessionId, title: parsed.title, msgs, lastTime })
    } catch (error) {
      console.warn('[dsh-session-search] 会话读取失败，已跳过:', sessionId, error instanceof Error ? error.message : String(error))
    }
  }
  groups.sort((a, b) => (b.lastTime ?? 0) - (a.lastTime ?? 0))
  // 无关键词时同样限制响应规模（只回最新 GROUP_LIMIT 个会话，样例文本也截断）
  const capped = groups.slice(0, GROUP_LIMIT).map((g) => ({
    ...g,
    msgs: g.msgs.map((m) => {
      const snip = snippetOf(m.text, '')
      return { role: m.role, text: snip.text, time: m.time, truncated: snip.truncated, anchorKey: m.anchorKey ?? null }
    }),
  }))
  return { groups: capped, groupTotal: groups.length, groupLimit: GROUP_LIMIT }
}

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
  res.end(JSON.stringify(payload))
}

/**
 * 主机名是否是回环地址（localhost / ::1 / 127.x.x.x）。
 * @param {string} hostname - 主机名（IPv6 可带方括号）。
 * @returns {boolean} 是回环则 true。
 */
export function isLoopbackHostname(hostname) {
  if (typeof hostname !== 'string' || hostname === '') return false
  // 去掉 IPv6 方括号（URL.hostname 会保留 [::1] 形式）
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  const lowered = bare.toLowerCase()
  if (lowered === 'localhost' || lowered === '::1') return true
  // IPv6 扩展回环 0:0:0:0:0:0:0:1
  if (lowered === '0:0:0:0:0:0:0:1') return true
  const parts = lowered.split('.')
  if (parts.length !== 4 || parts[0] !== '127') return false
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * 从 Host 头解析主机名（正确处理 `[::1]:3080` 这类 IPv6 + 端口形式）。
 * @param {string} hostHeader - 原始 Host 头。
 * @returns {string} 主机名（IPv6 保留方括号）；解析失败返回空串。
 */
export function hostnameOf(hostHeader) {
  const raw = String(hostHeader ?? '').trim()
  if (raw === '') return ''
  // Host 头只允许 host[:port] / [ipv6][:port]；
  // 含路径、scheme、凭据等字符一律视为非法（否则 URL 解析会得出歧义结果）。
  if (/[/\\@?#\s]/.test(raw)) return ''
  try {
    // 借 URL 解析，避免手写 split(':') 在 `[::1]:3080` 上切出 `[`
    return new URL(`http://${raw}`).hostname
  } catch {
    return ''
  }
}

/**
 * 远程地址是否是回环（含 IPv4-mapped IPv6 形式）。
 * @param {string} address - socket.remoteAddress。
 * @returns {boolean} 是回环则 true。
 */
export function isLoopbackAddress(address) {
  if (!address) return false
  const normalized = address.replace(/^::ffff:/, '')
  if (normalized === '::1') return true
  return isLoopbackHostname(normalized)
}

export function apply(ctx) {
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-session-search',
    handler: async (req, res) => {
      // 只放行同源回环请求：本接口返回的是会话正文（高度私密），
      // 不能从外部网络读到。
      // 注：这只是一层附加防护，不是可靠鉴权（本地反向代理可令外部请求
      // 表现为回环来源）。切勿把 DSH Web 暴露到不可信网络。
      const hostName = hostnameOf(req.headers.host)
      const remote = req.socket?.remoteAddress ?? ''
      if (!isLoopbackHostname(hostName) || !isLoopbackAddress(remote)) {
        json(res, 403, { ok: false, error: 'forbidden: loopback only' })
        return
      }
      if (req.method !== 'GET') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      const url = new URL(req.url ?? '/', 'http://x')
      // 规范化查询：搜索与客户端高亮必须使用同一个字符串（同一套截断规则），
      // 否则超长输入会出现「搜到的位置」与「高亮的位置」不一致。
      const q = (url.searchParams.get('q') ?? '').trim().slice(0, QUERY_MAX)
      const party = url.searchParams.get('party') ?? 'all'
      if (!q) {
        // 无关键词：返回全部话题（标题+第一句），按对话方过滤
        const p = ['all', 'ds', 'user'].includes(party) ? party : 'all'
        // listAllSessions 返回 { groups, groupTotal, groupLimit }（已限流）
        try { json(res, 200, { ok: true, empty: true, ...listAllSessions(p) }) }
        catch (error) { json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }) }
        return
      }
      try {
        // searchSessions 返回 { groups, groupTotal, matchLimit, groupLimit }（已限流）
        const result = searchSessions(q, ['all', 'ds', 'user'].includes(party) ? party : 'all')
        // query 回传规范化后的查询串，供客户端做高亮（保证与搜索用的一致）
        json(res, 200, { ok: true, query: q, ...result })
      } catch (error) {
        json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }, 'dsh-session-search: http search endpoint')
}
