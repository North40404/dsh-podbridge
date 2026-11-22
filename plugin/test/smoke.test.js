import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { DEFAULTS, loadSettings, saveSettings, validatePatch } from '../src/config.js'
import { createAuth } from '../src/auth.js'
import { createHub } from '../src/hub.js'
import { extractText, renderBatch, renderInbound, splitBubbles } from '../src/envelope.js'

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'podbridge-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function clockAt(start, stepMs = 0) {
  let now = start
  return { now: () => (stepMs ? (now += stepMs) : now), set: (value) => { now = value } }
}

test('配置：默认值完整', () => {
  assert.equal(DEFAULTS.enabled, false)
  assert.equal(DEFAULTS.listenPort, 8787)
})

test('配置：未知键与越界都被拒', () => {
  assert.equal(validatePatch({ nope: 1 }).ok, false)
  assert.equal(validatePatch({ listenPort: 0 }).ok, false)
  assert.equal(validatePatch({ listenPort: 70000 }).ok, false)
  assert.equal(validatePatch({ enabled: 'yes' }).ok, false)
})

test('配置：合法补丁被接受并归一化', () => {
  const result = validatePatch({ enabled: true, listenPort: '9000', sessionId: '  abc  ' })
  assert.equal(result.ok, true)
  assert.equal(result.value.listenPort, 9000)
  assert.equal(result.value.sessionId, 'abc')
})

test('配置：损坏文件回落默认并留告警', (t) => {
  const dir = tmpDir(t)
  const file = path.join(dir, 'settings.json')
  fs.writeFileSync(file, '{ not json')
  const warnings = []
  const loaded = loadSettings(file, (level, message) => warnings.push(message))
  assert.deepEqual(loaded, { ...DEFAULTS })
  assert.equal(warnings.length, 1)
})

test('配置：存档再读出保持一致', (t) => {
  const dir = tmpDir(t)
  const file = path.join(dir, 'settings.json')
  saveSettings(file, { ...DEFAULTS, enabled: true, sessionId: 's1' })
  const loaded = loadSettings(file)
  assert.equal(loaded.enabled, true)
  assert.equal(loaded.sessionId, 's1')
})

test('配对：码用一次即失效', (t) => {
  const dir = tmpDir(t)
  const clock = clockAt(1_000_000)
  const auth = createAuth({ file: path.join(dir, 'clients.json'), clock })
  const issued = auth.issueCode()
  assert.match(issued.code, /^\d{6}$/)

  const first = auth.redeem(issued.code, 'phone')
  assert.equal(first.ok, true)
  assert.equal(auth.verify(first.token), true)

  const second = auth.redeem(issued.code, 'phone')
  assert.equal(second.ok, false)
  assert.equal(second.error, 'code_used')
})

test('配对：过期码被拒', (t) => {
  const dir = tmpDir(t)
  const clock = clockAt(1_000_000)
  const auth = createAuth({ file: path.join(dir, 'clients.json'), clock })
  const issued = auth.issueCode()
  clock.set(issued.expiresAt + 1)
  const result = auth.redeem(issued.code, 'phone')
  assert.equal(result.ok, false)
  assert.equal(result.error, 'code_expired')
})

test('配对：错误码被拒；吊销后 token 失效', (t) => {
  const dir = tmpDir(t)
  const clock = clockAt(1_000_000)
  const auth = createAuth({ file: path.join(dir, 'clients.json'), clock })
  const issued = auth.issueCode()
  assert.equal(auth.redeem('000000' === issued.code ? '111111' : '000000', 'x').ok, false)
  const ok = auth.redeem(issued.code, 'x')
  assert.equal(ok.ok, true)
  auth.revokeAll()
  assert.equal(auth.verify(ok.token), false)
  assert.equal(auth.count(), 0)
})

test('中枢：seq 单调递增且可补拉', () => {
  const clock = clockAt(1_000_000)
  const hub = createHub({ clock })
  hub.publish('user', 'a')
  hub.publish('agent', 'b')
  assert.equal(hub.lastSeq(), 2)

  const backlog = hub.backlogSince(1)
  assert.equal(backlog.length, 1)
  assert.equal(backlog[0].text, 'b')
})

test('中枢：补拉缺口返回 null', () => {
  const clock = clockAt(1_000_000)
  const hub = createHub({ clock })
  // 缓冲上限 500：灌 600 条后，最旧的是 seq 101
  for (let i = 0; i < 600; i += 1) hub.publish('user', `m${i}`)
  // 新客户端（since=0）拿到最近一批，不算缺口
  assert.ok(Array.isArray(hub.backlogSince(0)))
  // 老客户端停在 seq 5，中间的已被挤出 → 缺口
  assert.equal(hub.backlogSince(5), null)
  // 停在 seq 100（刚好紧邻最旧 101）→ 能补齐
  assert.equal(hub.backlogSince(100).length, 500)
})

test('入站：加 [chat] 前缀并保留原文', () => {
  assert.equal(renderInbound('  在吗 '), '[chat] 在吗')
})

test('聚合：单条仍用普通前缀', () => {
  assert.equal(renderBatch([{ text: '在吗' }], { gapSec: 6 }), '[chat] 在吗')
})

test('聚合：多条合并成编号列表', () => {
  const text = renderBatch([{ text: '[表情]' }, { text: '在吗' }], { gapSec: 6 })
  assert.match(text, /^\[chat\] 用户连发 2 条（间隔 <6 秒）：/)
  assert.match(text, /1\. \[表情\]/)
  assert.match(text, /2\. 在吗/)
})

test('聚合：空数组返回空串', () => {
  assert.equal(renderBatch([]), '')
})

test('出站：只取 text 块', () => {
  const text = extractText([
    { type: 'text', text: '第一段' },
    { type: 'tool-call', id: 'x', name: 'y', arguments: '{}' },
    { type: 'text', text: '第二段' },
  ])
  assert.equal(text, '第一段第二段')
})

test('分段：按 [[split]] 切开并剔除标记', () => {
  const bubbles = splitBubbles('在的\n[[split]]\n我看看\n[[split]]\n找到了')
  assert.deepEqual(bubbles, ['在的', '我看看', '找到了'])
})

test('分段：代码块内的标记不生效', () => {
  const source = '看这段：\n```\n[[split]]\n```\n完'
  const bubbles = splitBubbles(source)
  assert.equal(bubbles.length, 1)
  assert.match(bubbles[0], /\[\[split\]\]/)
})

test('分段：超长段落按长度兜底', () => {
  const bubbles = splitBubbles('x'.repeat(25), 10)
  assert.deepEqual(bubbles.map((b) => b.length), [10, 10, 5])
})

test('分段：空文本返回空数组', () => {
  assert.deepEqual(splitBubbles('   '), [])
})
