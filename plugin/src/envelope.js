// 入站/出站的文本处理。
//
// 入站：把聊天消息包成模型能看清"这是谁说的、从哪来的"的一段文本。
// 出站：从 assistant 消息的 content 块里取纯文本。

/** 入站前缀：与 tick 的 `[Timer]` 对称，让模型有稳定的来源依据。 */
export const INBOUND_PREFIX = '[chat]'

/**
 * 渲染一条（或聚合后的多条）入站消息。
 *
 * 里程碑 1 只处理单条；聚合在实现 3.4 时扩展成多条列表。
 */
export function renderInbound(text) {
  return `${INBOUND_PREFIX} ${String(text ?? '').trim()}`
}

/** 从 ContentBlock[] 里取纯文本（忽略图片、工具调用等）。 */
export function extractText(content) {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out.trim()
}

/**
 * 渲染一批（聚合后的）入站消息。
 *
 * 单条 → 普通的 `[chat] 正文`；
 * 多条 → 带上"连发 N 条"的说明，逐条编号，让模型知道这是一次输入而不是几件事。
 *
 * @param {{text: string}[]} items
 * @param {{gapSec?: number}} [options]
 */
export function renderBatch(items, { gapSec = 6 } = {}) {
  if (!Array.isArray(items) || items.length === 0) return ''

  // 附件说明：每条消息的附件各自附在文本后面，模型读到的是绝对路径
  const attachmentLines = (item) => {
    const list = Array.isArray(item?.attachments) ? item.attachments : []
    return list.map((attachment) => attachment.describe ?? `[附件] ${attachment.path}`).filter(Boolean)
  }

  if (items.length === 1) {
    const blocks = [renderInbound(items[0].text), ...attachmentLines(items[0])]
    return blocks.filter((block) => String(block ?? '').trim() !== '').join('\n')
  }

  const lines = [`${INBOUND_PREFIX} 用户连发 ${items.length} 条（间隔 <${gapSec} 秒）：`]
  items.forEach((item, index) => {
    lines.push(`${index + 1}. ${String(item.text ?? '').trim()}`)
    for (const attachment of attachmentLines(item)) lines.push(`   ${attachment}`)
  })
  return lines.join('\n')
}

/**
 * 按 `[[split]]` 标记切分气泡。
 *
 * 规则见《dsh-podbridge 设计需求》3.3：
 *   · 标记独占一行、大小写不敏感
 *   · 代码围栏（```）内的标记不生效
 *   · 未打标 → 单段
 *   · 单段超过 maxChars → 兜底按长度切
 */
export function splitBubbles(text, maxChars = 2000) {
  const source = String(text ?? '')
  if (source.trim() === '') return []

  const segments = []
  let current = []
  let inFence = false
  for (const line of source.split('\n')) {
    if (/^```/.test(line.trim())) inFence = !inFence
    if (!inFence && line.trim().toLowerCase() === '[[split]]') {
      const joined = current.join('\n').trim()
      if (joined) segments.push(joined)
      current = []
      continue
    }
    current.push(line)
  }
  const tail = current.join('\n').trim()
  if (tail) segments.push(tail)

  const out = []
  for (const segment of segments.length > 0 ? segments : [source.trim()]) {
    if (segment.length <= maxChars) {
      out.push(segment)
      continue
    }
    for (let i = 0; i < segment.length; i += maxChars) out.push(segment.slice(i, i + maxChars))
  }
  return out
}
