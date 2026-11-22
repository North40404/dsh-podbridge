// 配对与凭证。
//
// 规则见《Pod 桥接协议 v1》第三章：
//   · 配对码 6 位、5 分钟有效、一次性
//   · 换来的 token 长期有效，直到管理员吊销
//
// 凭证落盘（clients.json），否则插件一重载所有客户端都要重新配对。
// 每个凭证还会记 lastSeenAt，供设置页展示"最近使用"。

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const CODE_TTL_MS = 5 * 60_000
/** lastSeenAt 的落盘节流：避免每个请求都写盘。 */
const PERSIST_DELAY_MS = 5000

/** 对外只暴露指纹，不暴露 token 本身。 */
function fingerprint(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 8)
}

export function createAuth({ file, clock, log = () => {} }) {
  /** token -> { deviceName, createdAt, lastSeenAt } */
  let tokens = {}
  /** 当前有效的配对码（内存即可：重启后重新生成） */
  let code = null
  let persistTimer = null

  try {
    const text = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
    if (parsed && typeof parsed === 'object' && parsed.tokens && typeof parsed.tokens === 'object') {
      tokens = parsed.tokens
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') log('warn', `读取 clients.json 失败：${error?.message ?? error}（按无客户端处理）`)
  }

  function persistNow() {
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ tokens }, null, 2), 'utf8')
      fs.renameSync(tmp, file)
    } catch (error) {
      log('warn', `写 clients.json 失败：${error?.message ?? error}`)
    }
  }

  /** lastSeenAt 变化不立即落盘，攒 5 秒写一次。 */
  function schedulePersist() {
    if (persistTimer) return
    persistTimer = setTimeout(persistNow, PERSIST_DELAY_MS)
    persistTimer.unref?.()
  }

  /** 生成一次性配对码（6 位数字）。 */
  function issueCode() {
    const value = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
    code = { value, expiresAt: clock.now() + CODE_TTL_MS, usedAt: 0 }
    return { code: value, expiresAt: code.expiresAt }
  }

  /**
   * 用配对码换 token。
   * @returns {{ok:true, token:string} | {ok:false, error:string}}
   */
  function redeem(inputCode, deviceName) {
    const given = String(inputCode ?? '').trim()
    if (!code) return { ok: false, error: 'no_code' }
    if (code.usedAt) return { ok: false, error: 'code_used' }
    if (clock.now() > code.expiresAt) return { ok: false, error: 'code_expired' }
    if (given !== code.value) return { ok: false, error: 'invalid_code' }

    code.usedAt = clock.now()
    const token = crypto.randomBytes(24).toString('base64url')
    tokens[token] = {
      deviceName: String(deviceName ?? '').slice(0, 40),
      createdAt: clock.now(),
      lastSeenAt: clock.now(),
    }
    persistNow()
    return { ok: true, token }
  }

  /** token 是否有效；有效时顺手更新 lastSeenAt。 */
  function verify(token) {
    const key = String(token ?? '')
    if (!Object.prototype.hasOwnProperty.call(tokens, key)) return false
    const entry = tokens[key]
    if (!entry || typeof entry !== 'object') return false
    const now = clock.now()
    if (!entry.lastSeenAt || now - entry.lastSeenAt > 30_000) {
      entry.lastSeenAt = now
      schedulePersist()
    }
    return true
  }

  /** 已配对设备列表（只给指纹，不给 token）。 */
  function list() {
    return Object.entries(tokens)
      .map(([token, info]) => ({
        id: fingerprint(token),
        deviceName: typeof info?.deviceName === 'string' ? info.deviceName : '',
        createdAt: Number(info?.createdAt) || 0,
        lastSeenAt: Number(info?.lastSeenAt) || 0,
      }))
      .sort((a, b) => (b.lastSeenAt || b.createdAt) - (a.lastSeenAt || a.createdAt))
  }

  /** 按指纹吊销一个设备。返回被删掉的 token（用于断开它的连接），找不到返回 null。 */
  function revoke(id) {
    const want = String(id ?? '')
    for (const token of Object.keys(tokens)) {
      if (fingerprint(token) !== want) continue
      delete tokens[token]
      persistNow()
      return token
    }
    return null
  }

  /** 当前已配对设备数量。 */
  function count() {
    return Object.keys(tokens).length
  }

  /** 吊销全部客户端。 */
  function revokeAll() {
    tokens = {}
    persistNow()
    return true
  }

  return { issueCode, redeem, verify, list, revoke, count, revokeAll, fingerprint }
}
