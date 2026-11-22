// dsh-podbridge —— Pod App 与 DSH 会话之间的桥接（Host 侧）。
//
// 边界：
//   · 桥接拥有**消息路径**；dsh-tick 拥有触发路径；两者互不知道
//   · 桥接不向客户端下发任何界面；客户端自带 UI
//   · 与客户端的唯一契约是《Pod 桥接协议 v1》
//
// 传输选择：用 SSE + POST 而不是 WebSocket。
//   原因：link 安装的插件解析不到 `ws` 依赖（profile 里没有这个包），
//   而 Node 自带 http 足够实现"服务端推 + 客户端发"。协议语义完全一致。

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { DEFAULTS, defaultAllowDirs, defaultFileDir, loadSettings, saveSettings, validatePatch } from './src/config.js'
import { createAuth } from './src/auth.js'
import { createHub } from './src/hub.js'
import { createFiles } from './src/files.js'  // 文件存盘
import { extractText, renderBatch, renderInbound, splitBubbles } from './src/envelope.js'

export const name = 'podbridge'

// sessionController 可缺省：缺席时消息收不了，但设置页仍能用（不整插件失活）。
export const inject = []

const TIME_ZONE = 'Asia/Shanghai'
const PROMPT_TIMEOUT_MS = 15_000
const BODY_LIMIT = 64 * 1024
/** 让设置页能跨源调用的响应头（与 tick 一致）。 */
const CONFIG_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization,x-file-name',
  'cache-control': 'no-store',
}

function systemClock() {
  return { now: () => Date.now() }
}

export function apply(ctx) {
  const clock = systemClock()
  const dataDir = path.join(os.homedir(), '.dsh', 'dsh-podbridge-data')
  fs.mkdirSync(dataDir, { recursive: true })

  const LOG_FILE = path.join(dataDir, 'bridge.log')
  /** 日志上限：超过就轮转成 bridge.log.1（只保留一份备份）。 */
  const LOG_MAX_BYTES = 2 * 1024 * 1024
  let logCheckedAt = 0

  function rotateLogIfNeeded() {
    const now = Date.now()
    if (now - logCheckedAt < 60_000) return
    logCheckedAt = now
    try {
      if (fs.statSync(LOG_FILE).size < LOG_MAX_BYTES) return
      const backup = `${LOG_FILE}.1`
      fs.rmSync(backup, { force: true })
      fs.renameSync(LOG_FILE, backup)
    } catch {
      // 轮转失败不影响写日志
    }
  }

  function log(level, message) {
    rotateLogIfNeeded()
    const line = `${new Date().toISOString()} [${level}] ${message}`
    try {
      fs.appendFileSync(LOG_FILE, `${line}\n`)
    } catch {
      // 日志失败不影响主流程
    }
    if (level === 'warn' || level === 'error') console.warn(`[podbridge] ${message}`)
  }

  const SETTINGS_FILE = path.join(dataDir, 'settings.json')
  const CLIENTS_FILE = path.join(dataDir, 'clients.json')

  let settings = loadSettings(SETTINGS_FILE, log)
  const auth = createAuth({ file: CLIENTS_FILE, clock, log })

  // 消息编号持久化：桥接重启后接着数，避免和客户端缓存里的旧 seq 撞号
  const HUB_STATE_FILE = path.join(dataDir, 'hub-state.json')
  let persistedSeq = 0
  try {
    const parsed = JSON.parse(fs.readFileSync(HUB_STATE_FILE, 'utf8'))
    persistedSeq = Math.max(0, Number(parsed?.lastSeq) || 0)
  } catch {
    // 首次运行或文件损坏：从 0 开始
  }
  let seqSaveTimer = null
  function saveSeq(value) {
    if (seqSaveTimer) return
    seqSaveTimer = setTimeout(() => {
      seqSaveTimer = null
      try {
        fs.writeFileSync(HUB_STATE_FILE, JSON.stringify({ lastSeq: value }), 'utf8')
      } catch (error) {
        log('warn', `写 hub-state.json 失败：${error?.message ?? error}`)
      }
    }, 1000)
    seqSaveTimer.unref?.()
  }
  const hub = createHub({ clock, initialSeq: persistedSeq, onSeq: saveSeq })

  /** 文件存储：配置改了目录/上限后重建。 */
  function makeFiles() {
    return createFiles({
      dir: String(settings.fileDir ?? '').trim() || defaultFileDir(),
      maxBytes: Math.max(1, Number(settings.maxFileMB) || 25) * 1024 * 1024,
      clock,
      log,
    })
  }
  let files = makeFiles()

  /**
   * 归档会话集合。
   *
   * `sessionController.list` 不排除归档会话，唯一来源是
   * `workspaceController.follow()` 的 baseline 帧（结构：`{type:'baseline', value:{archivedSessionIds}}`）。
   * 这里按需拉一次并缓存 30 秒——设置页打开频率很低，不值得常驻订阅。
   */
  const ARCHIVE_CACHE_MS = 30_000
  let archivedCache = { at: 0, ids: new Set() }

  async function archivedSessionIds() {
    const now = clock.now()
    if (now - archivedCache.at < ARCHIVE_CACHE_MS) return archivedCache.ids

    const workspaceController = ctx.get('workspaceController')
    if (typeof workspaceController?.follow !== 'function') return archivedCache.ids

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    let iterator
    try {
      // 手动迭代，只取 baseline 一帧。不用 for await：从它里面 return 会先调
      // iterator.return()，紧随其后的 abort 可能让流内部挂起的 promise 拒绝而无人接管。
      iterator = workspaceController.follow(controller.signal)[Symbol.asyncIterator]()
      const first = await iterator.next()
      if (first?.done) return archivedCache.ids
      const frame = first.value
      if (frame?.type !== 'baseline') return archivedCache.ids
      const ids = new Set((frame.value?.archivedSessionIds ?? []).map(String))
      archivedCache = { at: now, ids }
      return ids
    } catch (error) {
      log('warn', `读取归档集合失败（沿用上次结果）：${error?.message ?? error}`)
      return archivedCache.ids
    } finally {
      try {
        await iterator?.return?.()
      } catch {
        // 迭代器已结束
      }
      clearTimeout(timer)
      controller.abort()
    }
  }

  // ── HTTP 小工具 ────────────────────────────────────────────────────────
  function sendJson(res, status, body) {
    try {
      if (res.headersSent || res.writableEnded) return
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...CONFIG_CORS })
      res.end(JSON.stringify(body))
    } catch (error) {
      log('warn', `写回响应失败（客户端可能已断开）：${error?.message ?? error}`)
    }
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > BODY_LIMIT) {
          reject(new Error('请求体过大'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (chunks.length === 0) return resolve({})
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch {
          reject(new Error('请求体不是合法 JSON'))
        }
      })
      req.on('error', reject)
    })
  }

  function bearer(req) {
    const header = String(req.headers.authorization ?? '')
    return header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  }

  // ── 限流：每 IP 每分钟 ──────────────────────────────────────────────────
  const RATE_PER_MIN = 60
  const PAIR_PER_MIN = 10
  const rateHits = new Map()

  function allowRate(ip, limit) {
    const now = clock.now()
    const cutoff = now - 60_000
    const list = (rateHits.get(ip) ?? []).filter((at) => at > cutoff)
    if (list.length >= limit) {
      rateHits.set(ip, list)
      return false
    }
    list.push(now)
    rateHits.set(ip, list)
    return true
  }

  function clientIp(req) {
    return String(req.socket?.remoteAddress ?? 'unknown')
  }

  // ── 投递到会话 ─────────────────────────────────────────────────────────
  /** @returns {Promise<{ok: boolean, error?: string}>} */
  async function deliverToSession(text, requestId) {
    const sessionController = ctx.get('sessionController')
    if (typeof sessionController?.prompt !== 'function') {
      return { ok: false, error: 'sessionController 不可用' }
    }
    if (!settings.sessionId) return { ok: false, error: '未绑定会话' }
    try {
      await sessionController.prompt(
        {
          sessionId: settings.sessionId,
          requestId,
          mode: 'queue',
          content: [{ type: 'text', text }],
          clientTimeZone: TIME_ZONE,
        },
        AbortSignal.timeout(PROMPT_TIMEOUT_MS),
      )
      return { ok: true }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  // ── 入站聚合（设计需求 3.4）────────────────────────────────────────────
  // 满足任一条件就把攒下的消息合成一次投递：
  //   · 静默 silenceSec 秒（每条新消息重置）
  //   · 窗口总时长 maxWindowSec 秒
  //   · 攒满 maxMsgs 条
  // 目的：先发表情再打字时，不会出现"表情回一句、后面的话又回一句"。
  const inbound = { items: [], windowStartAt: 0, timer: null, flushing: false }

  function clearInboundTimer() {
    if (inbound.timer) {
      clearTimeout(inbound.timer)
      inbound.timer = null
    }
  }

  // ── 分段约定：注册到「绑定的那个 agent」的系统提示 ──────────────────────
  //
  // 为什么不用 prompt 里附一句：上下文压缩会把那条说明压掉，模型随后就"忘了"约定。
  // 系统提示的 section **每一步都会重新装配**，压缩不掉。
  //
  // 为什么不用全局 section：`systemPrompt.section()` 注册在调用者作用域，
  // 插件在根作用域注册就会污染所有会话（包括开发会话）。
  // 为什么不用 `system-prompt/assemble` 瀑布：它是**按作用域过滤**派发的，
  // 根作用域监听收不到 agent 的装配；要 hook 就得注册到 agent.ctx，
  // 那和直接注册 section 是同一件事、同一生命周期。
  const SPLIT_SECTION_NAME = 'podbridge-split'
  let splitSectionReady = false
  /** 注册返回的 disposer：卸载时必须调用，否则 section 会留在 agent 作用域里。 */
  let splitSectionDisposer = null

  function disposeSplitSection() {
    try {
      splitSectionDisposer?.()
    } catch {
      // 作用域可能已随 agent 销毁
    }
    splitSectionDisposer = null
    splitSectionReady = false
  }

  function registerSplitSection(agent) {
    if (splitSectionReady) return
    const text = String(settings.splitPrompt ?? '').trim()
    if (!text) return // 管理员清空了提示 → 不注入
    const target = agent?.ctx?.systemPrompt
    if (!target || typeof target.section !== 'function') return
    try {
      splitSectionDisposer = target.section({
        name: SPLIT_SECTION_NAME,
        order: 900,
        text,
      }) ?? null
      splitSectionReady = true
      log('info', `分段提示已注册到绑定会话（${text.length} 字，压缩后仍有效）`)
    } catch (error) {
      const message = String(error?.message ?? error)
      if (message.includes('already registered')) {
        // 上一代插件实例注册的 section 会在 agent 作用域里残留（旧版本没保存 disposer）。
        // 它不致命：功能仍在，只是文本是注册那一刻的版本；agent 重建后自然清理。
        log('warn', '分段提示已存在（上一代实例残留），本次沿用旧文本；重启 DSH 或会话重建后会用新文本')
      } else {
        log('warn', `分段提示注册失败：${message}`)
      }
    }
  }

  function ensureSplitSection() {
    if (splitSectionReady) return
    const agents = ctx.get('agents')
    registerSplitSection(agents?.get?.(settings.sessionId))
  }

  /** 配置里的提示文本变了 → 先撤旧的再注册新的。 */
  function refreshSplitSection() {
    const agents = ctx.get('agents')
    const agent = agents?.get?.(settings.sessionId)
    disposeSplitSection()
    registerSplitSection(agent)
  }

  // 会话恢复/新建时补挂：agent 可能在插件加载之后才出现
  const offAgentCreated = ctx.on('agent/created', (agent) => {
    if (agent?.id === settings.sessionId) registerSplitSection(agent)
  })

  // 回退用：拿不到 agent 作用域时，本进程第一条投递附一次说明（仍然用可配置文本）
  let hintDelivered = false

  async function flushInbound(trigger) {
    clearInboundTimer()
    if (inbound.flushing) return
    const items = inbound.items
    inbound.items = []
    inbound.windowStartAt = 0
    if (items.length === 0) return

    inbound.flushing = true
    try {
      if (!settings.enabled) {
        hub.publish('system', '桥接已关闭，消息未投递')
        return
      }
      ensureSplitSection()
      let text = renderBatch(items, { gapSec: settings.silenceSec })
      const fallback = String(settings.splitPrompt ?? '').trim()
      if (!splitSectionReady && !hintDelivered && fallback) {
        text += `\n（桥接说明，仅此一次：${fallback}）`
        hintDelivered = true
      }
      const requestId = items[0].clientMsgId || `pod_${Date.now()}`
      const result = await deliverToSession(text, requestId)
      if (!result.ok) {
        log('warn', `投递失败：${result.error}`)
        hub.publish('system', `投递失败：${result.error}`)
        return
      }
      log('info', `聚合投递（${trigger}）：${items.length} 条 → ${text.slice(0, 50)}`)
    } catch (error) {
      log('warn', `聚合投递异常：${error?.message ?? error}`)
    } finally {
      inbound.flushing = false
    }
  }

  function scheduleInbound() {
    clearInboundTimer()
    const now = clock.now()
    const silence = Math.max(0, settings.silenceSec) * 1000
    let delay = silence
    if (settings.maxWindowSec > 0) {
      const windowLeft = inbound.windowStartAt + settings.maxWindowSec * 1000 - now
      if (windowLeft <= 0) {
        void flushInbound('window')
        return
      }
      delay = Math.min(delay, windowLeft)
    }
    if (delay <= 0) {
      void flushInbound('immediate')
      return
    }
    inbound.timer = setTimeout(() => {
      void flushInbound('silence')
    }, delay)
    inbound.timer.unref?.()
    if (inbound.items.length >= settings.maxMsgs) void flushInbound('count')
  }

  function queueInbound(text, clientMsgId, attachments = []) {
    if (inbound.items.length === 0) inbound.windowStartAt = clock.now()
    // 附件跟着消息一起进聚合缓冲：文本 + 附件在同一次投递里给模型
    inbound.items.push({ text, at: clock.now(), clientMsgId, attachments })
    // 记下入队与窗口起点，便于事后核对"静默到底从哪条算起"
    const offset = ((clock.now() - inbound.windowStartAt) / 1000).toFixed(1)
    log('info', `入队 #${inbound.items.length}（窗口 +${offset}s）：${text.slice(0, 30)}`)
    scheduleInbound()
  }

  // ── 客户端服务面（自有端口）────────────────────────────────────────────
  /** 已处理的 clientMsgId → 时间；只用于去重（防 bug 循环刷屏）。 */
  const seen = new Map()
  const SEEN_TTL_MS = 60 * 60_000

  async function handleClientRequest(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CONFIG_CORS)
      res.end()
      return
    }

    if (url.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        enabled: settings.enabled,
        bound: Boolean(settings.sessionId),
        clients: hub.clientCount(),
        lastSeq: hub.lastSeq(),
      })
      return
    }

    if (url.pathname === '/pair' && req.method === 'POST') {
      if (!allowRate(clientIp(req), PAIR_PER_MIN)) {
        log('warn', `配对请求过于频繁：${clientIp(req)}`)
        sendJson(res, 429, { ok: false, error: 'rate_limited' })
        return
      }
      const body = await readJson(req)
      const result = auth.redeem(body.code, body.deviceName)
      if (!result.ok) {
        sendJson(res, 401, { ok: false, error: result.error })
        return
      }
      log('info', `配对成功：${String(body.deviceName ?? '').slice(0, 40) || '未命名设备'}`)
      sendJson(res, 200, { ok: true, token: result.token, chatId: 'private' })
      return
    }

    if (url.pathname === '/events' && req.method === 'GET') {
      const token = bearer(req) || String(url.searchParams.get('token') ?? '')
      if (!auth.verify(token)) {
        sendJson(res, 401, { ok: false, error: 'invalid_token' })
        return
      }
      handleEvents(req, res, url, token)
      return
    }

    if (url.pathname === '/history' && req.method === 'GET') {
      const token = bearer(req) || String(url.searchParams.get('token') ?? '')
      if (!auth.verify(token)) {
        sendJson(res, 401, { ok: false, error: 'invalid_token' })
        return
      }
      const items = hub.history({
        beforeSeq: Number(url.searchParams.get('beforeSeq') ?? 0),
        limit: Number(url.searchParams.get('limit') ?? 50),
      })
      sendJson(res, 200, { ok: true, items })
      return
    }

    // 上传：裸字节 + 头部带文件名。不用 multipart，客户端和桥接都省事。
    if (url.pathname === '/upload' && req.method === 'POST') {
      const token = bearer(req)
      if (!auth.verify(token)) {
        sendJson(res, 401, { ok: false, error: 'invalid_token' })
        return
      }
      if (!allowRate(clientIp(req), RATE_PER_MIN)) {
        sendJson(res, 429, { ok: false, error: 'too_many_requests' })
        return
      }
      const rawName = req.headers['x-file-name']
      const name = rawName ? decodeURIComponent(String(rawName)) : 'file'
      const chunks = []
      let size = 0
      let tooLarge = false
      await new Promise((resolve) => {
        req.on('data', (chunk) => {
          if (tooLarge) return
          size += chunk.length
          if (size > files.maxBytes) {
            tooLarge = true
            // 读干净再回，避免连接被重置
            return
          }
          chunks.push(chunk)
        })
        req.on('end', resolve)
        req.on('error', resolve)
      })
      if (tooLarge) {
        sendJson(res, 413, { ok: false, error: 'file_too_large', maxMB: settings.maxFileMB })
        return
      }
      const meta = files.save(Buffer.concat(chunks), name)
      log('info', `收到文件 ${meta.name}（${files.humanSize(meta.size)}）→ ${meta.path}`)
      sendJson(res, 200, { ok: true, id: meta.id, name: meta.name, size: meta.size, mime: meta.mime })
      return
    }

    // 下载：客户端取回 agent 发来的文件
    if (url.pathname.startsWith('/files/') && req.method === 'GET') {
      // 浏览器 <img src> 带不了自定义头，只能把 token 放查询串，这里必须两种都认
      const token = bearer(req) || String(url.searchParams.get('token') ?? '')
      if (!auth.verify(token)) {
        sendJson(res, 401, { ok: false, error: 'invalid_token' })
        return
      }
      const id = decodeURIComponent(url.pathname.slice('/files/'.length))
      const meta = files.find(id)
      if (!meta) {
        sendJson(res, 404, { ok: false, error: 'file_not_found' })
        return
      }
      try {
        const data = fs.readFileSync(meta.path)
        res.writeHead(200, {
          'content-type': meta.mime,
          'content-length': String(data.length),
          'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
          'cache-control': 'no-store',
        })
        res.end(data)
      } catch (error) {
        sendJson(res, 500, { ok: false, error: 'read_failed' })
      }
      return
    }
    if (url.pathname === '/send' && req.method === 'POST') {
      const token = bearer(req)
      if (!auth.verify(token)) {
        sendJson(res, 401, { ok: false, error: 'invalid_token' })
        return
      }
      if (!allowRate(clientIp(req), RATE_PER_MIN)) {
        log('warn', `发送过于频繁：${clientIp(req)}`)
        hub.publish('system', '发送过于频繁，本条未投递')
        sendJson(res, 200, { ok: true, queued: false })
        return
      }
      const body = await readJson(req)
      const text = String(body.text ?? '').trim()
      const clientMsgId = String(body.clientMsgId ?? '')

      // 附件：只认已上传的 id，防止客户端伪造任意路径
      const attachments = []
      for (const raw of Array.isArray(body.attachments) ? body.attachments : []) {
        const meta = files.find(raw?.id ?? raw)
        if (!meta) {
          sendJson(res, 400, { ok: false, error: 'unknown_attachment' })
          return
        }
        attachments.push({ ...meta, describe: files.describe(meta) })
      }

      if (text === '' && attachments.length === 0) {
        sendJson(res, 400, { ok: false, error: 'empty' })
        return
      }
      if (clientMsgId && seen.has(clientMsgId)) {
        log('info', `重复 ${clientMsgId}，已忽略`)
        sendJson(res, 200, { ok: true, duplicate: true })
        return
      }
      if (clientMsgId) seen.set(clientMsgId, clock.now())
      for (const [id, at] of seen) {
        if (clock.now() - at > SEEN_TTL_MS) seen.delete(id)
      }

      if (!settings.enabled) {
        hub.publish('system', '桥接已关闭，消息未投递')
        sendJson(res, 200, { ok: true, delivered: false })
        return
      }
      if (text.length > settings.messageMaxChars) {
        hub.publish('system', `消息超过 ${settings.messageMaxChars} 字，未投递`)
        sendJson(res, 200, { ok: true, delivered: false })
        return
      }

      // 先回显：所有在线设备立刻看到自己发的消息（附件也要带上，否则图片消息回显成空）
      hub.publish('user', text, { attachments })

      if (!settings.debounceEnabled) {
        const delivered = await deliverToSession(renderInbound(text), clientMsgId || `pod_${Date.now()}`)
        if (!delivered.ok) {
          log('warn', `投递失败：${delivered.error}`)
          hub.publish('system', `投递失败：${delivered.error}`)
          sendJson(res, 200, { ok: true, delivered: false })
          return
        }
        log('info', `已投递 ${clientMsgId || '(no id)'}：${text.slice(0, 40)}`)
        sendJson(res, 200, { ok: true, delivered: true })
        return
      }

      // 聚合模式：先进缓冲，窗口结束后统一投递
      queueInbound(text, clientMsgId, attachments)
      sendJson(res, 200, { ok: true, queued: true })
      return
    }

    sendJson(res, 404, { ok: false, error: 'not_found' })
  }

  /** SSE：握手 + 补拉 + 保持连接。 */
  function handleEvents(req, res, url, token) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      ...CONFIG_CORS,
    })
    res.write(': connected\n\n')

    const since = Number(url.searchParams.get('since') ?? 0)
    res.write(
      `data: ${JSON.stringify({
        type: 'welcome',
        chatId: 'private',
        lastSeq: hub.lastSeq(),
        serverTime: clock.now(),
      })}\n\n`,
    )

    const backlog = hub.backlogSince(since)
    if (backlog === null) {
      res.write(
        `data: ${JSON.stringify({
          type: 'msg',
          message: { chatId: 'private', seq: hub.lastSeq(), role: 'system', text: '部分历史缺失', at: clock.now() },
        })}\n\n`,
      )
    } else {
      for (const message of backlog) {
        res.write(`data: ${JSON.stringify({ type: 'msg', message })}\n\n`)
      }
    }

    hub.addClient(res, token)
    log('info', `客户端接入，当前 ${hub.clientCount()} 个`)

    // 心跳注释：防止中间代理掐断空闲连接
    const timer = setInterval(() => {
      try {
        res.write(': ping\n\n')
      } catch {
        clearInterval(timer)
      }
    }, 25_000)

    const cleanup = () => {
      if (closed) return
      closed = true
      clearInterval(timer)
      hub.removeClient(res)
      log('info', `客户端断开，当前 ${hub.clientCount()} 个`)
    }
    let closed = false
    req.on('close', cleanup)
    res.on('close', cleanup)
  }

  // ── 自有 HTTP 服务 ──────────────────────────────────────────────────────
  let server = null
  let listeningPort = 0

  function startServer() {
    if (server) return
    server = http.createServer((req, res) => {
      handleClientRequest(req, res).catch((error) => {
        log('warn', `请求处理异常：${error?.message ?? error}`)
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      })
    })
    // 重载插件时旧监听可能还没释放（Windows 上尤其明显），重试几次
    let listenRetries = 0
    server.on('error', (error) => {
      if (error?.code === 'EADDRINUSE' && listenRetries < 5) {
        listenRetries += 1
        log('warn', `端口 ${settings.listenPort} 被占用，${listenRetries} 次重试…`)
        setTimeout(() => {
          try {
            server.listen(settings.listenPort, '0.0.0.0')
          } catch {
            // 下次 error 事件再试
          }
        }, 400 * listenRetries)
        return
      }
      log('error', `监听 ${settings.listenPort} 失败：${error?.message ?? error}`)
    })
    server.listen(settings.listenPort, '0.0.0.0', () => {
      listeningPort = settings.listenPort
      log('info', `桥接服务已启动：http://0.0.0.0:${listeningPort}`)
    })
  }

  function stopServer() {
    if (!server) return
    hub.closeAll('server-shutdown')
    // 关键：SSE 是长连接，只 close() 会一直等连接结束，端口释放不掉，
    // 重载插件时新实例就会 EADDRINUSE。先强制断开所有连接。
    const closing = server
    try {
      closing.closeAllConnections?.()
    } catch {
      // 老版本 Node 没有这个方法，退回普通 close
    }
    closing.close()
    server = null
    listeningPort = 0
  }

  // 服务**始终监听**：总开关只控制"要不要投递"，不控制能不能连。
  // 否则关着开关时客户端连配对都做不了，而配对恰恰是开启前的准备工作。
  startServer()

  // 出站工具：让模型能把本地文件发到客户端
  registerSendFileTool()

  // ── 管理面（DSH 设置页用）──────────────────────────────────────────────
  const CONFIG_PATH = '/api/dsh-podbridge/config'
  const SESSIONS_PATH = '/api/dsh-podbridge/sessions'
  const CODE_PATH = '/api/dsh-podbridge/pairing-code'
  const CLIENTS_PATH = '/api/dsh-podbridge/clients'
  const REVOKE_ONE_PATH = '/api/dsh-podbridge/revoke-one'
  const REVOKE_PATH = '/api/dsh-podbridge/revoke'

  function currentConfig() {
    return {
      enabled: settings.enabled,
      sessionId: settings.sessionId,
      listenPort: settings.listenPort,
      messageMaxChars: settings.messageMaxChars,
      debounceEnabled: settings.debounceEnabled,
      silenceSec: settings.silenceSec,
      maxWindowSec: settings.maxWindowSec,
      maxMsgs: settings.maxMsgs,
      splitPrompt: settings.splitPrompt,
    }
  }

  function runtimeView() {
    return {
      listening: Boolean(server),
      port: listeningPort,
      clients: hub.clientCount(),
      lastSeq: hub.lastSeq(),
      tokens: auth.count(),
      anyArchived: archivedCache.ids.size,
    }
  }

  const scoped = ctx.inject(['webServer'], (s) => {
    s.effect(() =>
      s.webServer.register({
        kind: 'exact',
        path: CONFIG_PATH,
        handler: async (req, res) => {
          try {
            if (req.method === 'OPTIONS') {
              res.writeHead(204, CONFIG_CORS)
              res.end()
              return
            }
            if (req.method === 'GET') {
              sendJson(res, 200, { ok: true, config: currentConfig(), defaults: { ...DEFAULTS }, runtime: runtimeView() })
              return
            }
            if (req.method === 'POST') {
              const patch = await readJson(req)
              const checked = validatePatch(patch)
              if (!checked.ok) {
                sendJson(res, 400, { ok: false, errors: checked.errors })
                return
              }
              const previous = { ...settings }
              const next = { ...settings, ...checked.value }
              // 换端口 / 换总开关要重启服务
              const needRestart =
                next.enabled !== previous.enabled || next.listenPort !== previous.listenPort
              const rebind = next.sessionId !== previous.sessionId
              const promptChanged = next.splitPrompt !== previous.splitPrompt
              const fileSettingsChanged =
                next.fileDir !== previous.fileDir || next.maxFileMB !== previous.maxFileMB
              settings = next
              saveSettings(SETTINGS_FILE, settings)
              // 换文件目录或上限 → 重建存储实例（旧文件仍在旧目录，不迁移）
              if (fileSettingsChanged) files = makeFiles()
              if (needRestart) {
                stopServer()
                startServer()
              }
              // 换绑定或改提示文本 → 旧 section 撤掉、按新值重挂
              if (rebind) {
                hintDelivered = false
                // 换绑定 → 工作区缓存立刻失效，否则白名单会继续用旧会话的 cwd
                cwdCache = { at: 0, value: '' }
              }
              if (rebind || promptChanged) refreshSplitSection()
              log('info', `配置已更新：${Object.keys(checked.value).join(',') || '(无变化)'}`)
              sendJson(res, 200, { ok: true, config: currentConfig(), runtime: runtimeView() })
              return
            }
            sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
          } catch (error) {
            log('warn', `配置接口异常：${error?.message ?? error}`)
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      }),
    )

    s.effect(() =>
      s.webServer.register({
        kind: 'exact',
        path: SESSIONS_PATH,
        handler: async (req, res) => {
          try {
            const sessionController = ctx.get('sessionController')
            if (typeof sessionController?.list !== 'function') {
              sendJson(res, 503, { ok: false, error: 'sessionController 不可用' })
              return
            }
            const signal = AbortSignal.timeout(8000)
            const value = await sessionController.list({}, signal)
            const archived = await archivedSessionIds()
            const rawItems = Array.isArray(value?.items) ? value.items : []
            let archivedCount = 0
            const items = rawItems
              // 空白占位会话与子代理会话不作为绑定目标
              .filter((item) => item && item.blank !== true && item.origin !== 'subagent')
              .filter((item) => {
                if (!archived.has(String(item.sessionId))) return true
                archivedCount += 1
                return false
              })
              .map((item) => {
                // 标题没有独立字段，只能从投影里按 key 名匹配
                const values =
                  item.projections && typeof item.projections.values === 'object' && item.projections.values
                    ? item.projections.values
                    : {}
                const titleKey = Object.keys(values).find(
                  (key) => /title/i.test(key) && typeof values[key] === 'string' && values[key].trim(),
                )
                const cwd = typeof item.cwd === 'string' ? item.cwd : ''
                return {
                  sessionId: String(item.sessionId),
                  title: titleKey ? values[titleKey] : '',
                  cwd,
                  updatedAt: Number(item.updatedAt) || 0,
                  running: item.running === true,
                }
              })
              .sort((a, b) => b.updatedAt - a.updatedAt)
            sendJson(res, 200, { ok: true, items, archivedCount, total: rawItems.length })
          } catch (error) {
            log('warn', `会话列表失败：${error?.message ?? error}`)
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      }),
    )

    s.effect(() =>
      s.webServer.register({
        kind: 'exact',
        path: CODE_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
            return
          }
          const code = auth.issueCode()
          log('info', '已生成配对码')
          sendJson(res, 200, { ok: true, ...code })
        },
      }),
    )

    s.effect(() =>
      s.webServer.register({
        kind: 'exact',
        path: CLIENTS_PATH,
        handler: async (req, res) => {
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
            return
          }
          sendJson(res, 200, { ok: true, items: auth.list() })
        },
      }),
    )

    s.effect(() =>
      s.webServer.register({
        kind: 'exact',
        path: REVOKE_ONE_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
            return
          }
          const body = await readJson(req)
          const token = auth.revoke(body?.id)
          if (!token) {
            sendJson(res, 404, { ok: false, error: 'device_not_found' })
            return
          }
          const closed = hub.closeByToken(token, 'revoked')
          log('info', `已吊销设备 ${body?.id}${closed ? `（断开 ${closed} 个连接）` : ''}`)
          sendJson(res, 200, { ok: true, closed })
        },
      }),
    )

    s.effect(() =>
      s.webServer.register({
        kind: 'exact',
        path: REVOKE_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
            return
          }
          auth.revokeAll()
          hub.closeAll('revoked')
          log('info', '已吊销全部客户端凭证')
          sendJson(res, 200, { ok: true })
        },
      }),
    )
  })

  // ── 出站：pod_send_file 工具 ──────────────────────────────────────────
  // 让模型能把本地文件发到 Pod App。
  // 安全：路径白名单（默认开），列表来自配置；**模型无法修改配置**，
  // 关闭白名单只能在设置页由人操作。
  /** 绑定会话的工作目录（默认白名单要用它）。60 秒缓存，失败不缓存。 */
  let cwdCache = { at: 0, value: '' }
  async function boundSessionCwd() {
    if (!settings.sessionId) return ''
    if (clock.now() - cwdCache.at < 60_000) return cwdCache.value
    try {
      const sc = ctx.get('sessionController')
      if (typeof sc?.list !== 'function') return ''
      const value = await sc.list({}, AbortSignal.timeout(5000))
      const item = (value?.items ?? []).find((one) => String(one?.sessionId) === String(settings.sessionId))
      cwdCache = { at: clock.now(), value: typeof item?.cwd === 'string' ? item.cwd : '' }
      if (!item) log('warn', '绑定会话不在列表里: ' + settings.sessionId)
      return cwdCache.value
    } catch (error) {
      log('warn', `取会话工作区失败：${error?.message ?? error}`)
      return ''
    }
  }
  function registerSendFileTool() {
    // tools 服务可能晚于 apply，用 inject 等待它；已就绪时走直接路径
    const direct = ctx.get?.('tools')
    if (direct?.register) {
      mountTool(direct)
      return
    }
    ctx.inject?.(['tools'], (s) => mountTool(s.get('tools')))
  }

  function mountTool(tools) {
    if (!tools?.register) {
      log('warn', 'tools 服务不可用，pod_send_file 未注册')
      return
    }
    tools.register({
      name: 'pod_send_file',
      // 延迟加载：完整 schema 不常驻每轮请求，需要时才展开
      deferLoading: true,
      description: '把本地文件发给用户的 Pod App。路径必须绝对；超出白名单会被拒绝。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '绝对路径' },
          caption: { type: 'string', description: '可选说明' },
        },
        required: ['file_path'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            fileName: { type: 'string' },
            fileSize: { type: 'integer' },
            fileId: { type: 'string' },
          },
          required: ['fileName', 'fileSize', 'fileId'],
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: `已发送 ${value?.fileName ?? '文件'}` }],
      },
      async execute(args) {
        const target = String(args?.file_path ?? '').trim()
        if (!target) throw new Error('pod_send_file: file_path 不能为空')

        const abs = path.resolve(target)
        if (!fs.existsSync(abs)) throw new Error(`pod_send_file: 文件不存在：${abs}`)
        const stat = fs.statSync(abs)
        if (!stat.isFile()) throw new Error(`pod_send_file: 不是文件：${abs}`)
        if (stat.size > files.maxBytes) {
          throw new Error(`pod_send_file: 文件超过上限（${files.humanSize(stat.size)} > ${files.humanSize(files.maxBytes)}）`)
        }

        // 白名单：默认只允许配置里的目录
        if (settings.fileWhitelist) {
          const configured = String(settings.fileAllowDirs ?? '')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
          // 没配置就用默认：工作区 + 下载目录；工作区取绑定会话的 cwd
          const base = configured.length > 0 ? configured : defaultAllowDirs()
          const sessionCwd = await boundSessionCwd()
          // 文件目录本身永远允许：那是我们自己存的，把收到的文件再发回去是常见需求
          const allow = [...new Set([...base, ...(sessionCwd ? [sessionCwd] : []), files.root])].map((line) => path.resolve(line))
          const allowed = allow.some((dir) => abs === dir || abs.startsWith(dir + path.sep))
          if (!allowed) {
            throw new Error(
              `pod_send_file: 路径不在白名单内（${allow.join('、') || '未配置'}）。` +
                '需要发送其它目录的文件时，请让用户到桥接设置页调整白名单。',
            )
          }
        }

        // 复制进文件目录，客户端按 id 下载
        const meta = files.save(fs.readFileSync(abs), path.basename(abs))
        const caption = String(args?.caption ?? '').trim()
        hub.publish('agent', caption, { attachments: [{ id: meta.id, name: meta.name, size: meta.size, mime: meta.mime }] })
        log('info', `已发送文件 ${meta.name} → 客户端`)
        return { fileName: meta.name, fileSize: meta.size, fileId: meta.id }
      },
    }, {
      // 只对「绑定的那个会话」可见：其它会话看不到也调不到，零 token 成本
      when: (context) => {
        const id = String(settings.sessionId ?? '')
        return id !== '' && String(context?.agent?.id ?? '') === id
      },
    })
    log('info', 'pod_send_file 工具已注册（仅绑定会话可见）')
  }
  // ── 归档会话集合（订阅一次，持续更新）──────────────────────────────────
  // 归档集合改为按需拉取（见 archivedSessionIds），这里不再常驻订阅。

  // ── 出站：会话事件 → 客户端 ────────────────────────────────────────────
  // 不逐字流式：只消费 assistant/message（整条），符合设计需求 3.2。
  // 诊断：每种事件类型只记一次，便于确认订阅是否真的收到事件
  const seenEventTypes = new Set()
  let loggedMismatch = false
  const offSessionEvent = ctx.on('session/event', (session, event) => {
    const type = String(event?.type ?? '?')
    if (!seenEventTypes.has(type)) {
      seenEventTypes.add(type)
      log('info', `收到会话事件类型：${type}（session=${session?.id ?? '?'}）`)
    }
    if (!session || String(session.id) !== String(settings.sessionId)) {
      if (!loggedMismatch) {
        loggedMismatch = true
        log('warn', `会话不匹配：事件来自 ${session?.id ?? '?'}，绑定的是 ${settings.sessionId}`)
      }
      return
    }
    if (!settings.enabled) return
    if (event?.type !== 'assistant/message') return
    const text = extractText(event.data?.message?.content)
    if (!text) {
      log('warn', 'assistant/message 里没取到文本')
      return
    }
    log('info', `推送回复（${text.length} 字，客户端 ${hub.clientCount()} 个）`)
    for (const bubble of splitBubbles(text, 2000)) hub.publish('agent', bubble)
  })

  // 注：`system-prompt/assemble` 瀑布是**按作用域过滤**派发的，根作用域监听收不到
  // agent 的装配；要 hook 必须注册到 agent.ctx，与直接注册 section 等价。
  // 所以这里不挂 waterfall，改用 agent 作用域的 section（见 registerSplitSection）。

  ctx.effect(() => () => {
    try {
      offSessionEvent?.()
    } catch {
      // 已释放
    }
    try {
      offAgentCreated?.()
    } catch {
      // 已释放
    }
    disposeSplitSection()
    clearInboundTimer()
    if (inbound.items.length > 0) log('info', `卸载时丢弃 ${inbound.items.length} 条未投递消息（聚合缓冲不落盘）`)
    inbound.items = []
    stopServer()
    log('info', '已卸载，服务已停止')
  })
}
