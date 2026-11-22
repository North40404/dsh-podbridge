// 消息中枢：分配 seq、维护最近消息、向所有已连接的客户端广播。
//
// 传输是 SSE（见 index.js），但这里的语义与《Pod 桥接协议 v1》完全一致：
// 每个客户端拿到的都是同一份 {seq, chatId, role, text, at}。

/** 内存里保留多少条历史，用于重连补拉。 */
const BUFFER_SIZE = 500

export function createHub({ clock, chatId = 'private', initialSeq = 0, onSeq = () => {} }) {
  /** 所有消息，按 seq 递增；超出容量时丢最旧。 */
  const buffer = []
  /** 已连接的 SSE 响应对象 -> 它用的 token（用于按设备断开）。 */
  const clients = new Map()
  // 从上次的编号继续，而不是从 0 重来：
  // 否则桥接一重启，新消息的 seq 会和客户端缓存里的旧消息撞号，
  // 客户端会把它当成"重复"丢掉（表现为重启后收不到任何新消息）。
  let seq = Math.max(0, Number(initialSeq) || 0)

  function nextSeq() {
    seq += 1
    onSeq(seq)
    return seq
  }

  /** 按协议构造一条 message。 */
  function makeMessage(role, text) {
    return { chatId, seq: nextSeq(), role, text: String(text ?? ''), at: clock.now() }
  }

  function writeFrame(res, frame) {
    try {
      res.write(`data: ${JSON.stringify(frame)}\n\n`)
      return true
    } catch {
      return false
    }
  }

  /**
   * 广播一条消息：先入缓冲，再推给所有客户端。
   * @returns {object} 刚发出的 message
   */
  function publish(role, text, extra = {}) {
    const message = makeMessage(role, text)
    // 附件随消息一起推：客户端按 id 去 /files/<id> 取回
    if (Array.isArray(extra?.attachments) && extra.attachments.length > 0) {
      message.attachments = extra.attachments.map((item) => ({
        id: String(item.id ?? ''),
        name: String(item.name ?? ''),
        size: Number(item.size) || 0,
        mime: String(item.mime ?? 'application/octet-stream'),
      }))
    }
    buffer.push(message)
    if (buffer.length > BUFFER_SIZE) buffer.shift()
    for (const [res] of clients) {
      if (!writeFrame(res, { type: 'msg', message })) clients.delete(res)
    }
    return message
  }

  /** 补拉：`since` 之后的消息；追不上就回 null（由调用方发 system 提示）。 */
  function backlogSince(since) {
    const from = Number.isInteger(since) && since >= 0 ? since : 0
    if (from === 0) return buffer.slice(-50)
    const oldest = buffer.length > 0 ? buffer[0].seq : 0
    if (buffer.length > 0 && from + 1 < oldest) return null
    return buffer.filter((message) => message.seq > from)
  }

  /** 分页历史：`beforeSeq` 之前、最多 `limit` 条，按 seq 升序。 */
  function history({ beforeSeq, limit = 50 } = {}) {
    const before =
      Number.isInteger(beforeSeq) && beforeSeq > 0 ? beforeSeq : Number.MAX_SAFE_INTEGER
    const max = Math.min(Math.max(Number(limit) || 50, 1), 100)
    return buffer.filter((message) => message.seq < before).slice(-max)
  }

  /** 注册一个 SSE 客户端（记下它的 token，便于按设备断开）。 */
  function addClient(res, token) {
    clients.set(res, String(token ?? ''))
  }

  function removeClient(res) {
    clients.delete(res)
  }

  /** 只断开某个 token 的连接（按设备吊销时用）。 */
  function closeByToken(token, reason) {
    const want = String(token ?? '')
    let closed = 0
    for (const [res, owner] of clients) {
      if (owner !== want) continue
      writeFrame(res, { type: 'closed', reason })
      try {
        res.end()
      } catch {
        // 已断开
      }
      clients.delete(res)
      closed += 1
    }
    return closed
  }

  function clientCount() {
    return clients.size
  }

  /** 主动断开所有客户端（插件卸载/关闭开关时用）。 */
  function closeAll(reason) {
    for (const [res] of clients) {
      writeFrame(res, { type: 'closed', reason })
      try {
        res.end()
      } catch {
        // 已断开，忽略
      }
    }
    clients.clear()
  }

  return { publish, backlogSince, history, addClient, removeClient, closeByToken, clientCount, closeAll, lastSeq: () => seq }
}
