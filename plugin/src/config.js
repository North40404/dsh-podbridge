// 配置：自管 settings.json。
//
// 为什么不用 `export const Config`：本地 link 安装的插件解析不到
// `@deepseek-ai/schemastery`（tick 上踩过），所以配置持久化与校验都在这里做。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 分段提示的出厂文本。清空 = 不注入。
 *
 * 两个约束决定了写法：
 *   1. 上下文宝贵 → 尽可能短（48 字）
 *   2. 绑定会话也被 DSH 界面使用 → 必须用 `[chat]` 前缀限定，
 *      否则模型在 GUI 里也会打 [[split]]（那里没人解析它）
 */
export const DEFAULT_SPLIT_PROMPT =
  '消息以 [chat] 开头时可分段：断开处独占一行写 [[split]]（≤4 条，代码块/表格内不用）；否则正常回复。'

/** 出厂默认。 */
export const DEFAULTS = Object.freeze({
  enabled: false,
  sessionId: '',
  listenPort: 8787,
  messageMaxChars: 4000,
  debounceEnabled: true,
  silenceSec: 6,
  maxWindowSec: 15,
  maxMsgs: 10,
  splitPrompt: DEFAULT_SPLIT_PROMPT,
  // ── 文件 ──
  /** 文件存放根目录；留空用默认值（见 filesDir） */
  fileDir: '',
  /** 单文件大小上限（MB） */
  maxFileMB: 25,
  /** 出站白名单开关：true=只允许白名单目录，false=允许任意路径（危险，需用户明示） */
  fileWhitelist: true,
  /** 出站白名单目录（换行分隔）。留空用默认：工作区 + 下载目录 */
  fileAllowDirs: '',
  /**
   * 是否开放 HTTP 发文件端点（POST /api/dsh-podbridge/send-file）。
   *
   * 默认关闭：它是给"工具不可见的老会话 / 脚本"用的兜底通道，
   * 正常对话用 pod_send_file 就够了。开着等于在本机管理面上多开一个
   * "能把白名单内文件推到手机"的入口，所以默认不留。
   */
  sendFileEndpoint: false,
})

/** 默认文件目录：`<目录>\pod-files`（非 Windows 退回家目录下 pod-files）。 */
export function defaultFileDir() {
  if (process.platform === 'win32') return 'D:\\Tool\\pod-files'
  return path.join(os.homedir(), 'pod-files')
}

/** 默认出站白名单目录：工作区 + 用户下载目录。 */
export function defaultAllowDirs() {
  const list = []
  const workspace = process.env.DSH_WORKSPACE
  if (workspace) list.push(workspace)
  // 进程当前目录：DSH 里通常是工作区，作为兜底的"工作区"
  try {
    list.push(process.cwd())
  } catch {
    // 忽略
  }
  // 不依赖 electron：测试环境里也能算出来
  list.push(path.join(os.homedir(), 'Downloads'))
  if (process.platform === 'win32') list.push('D:\\Downloads')
  return [...new Set(list.filter(Boolean))]
}

/** 数值型字段的取值范围。 */
const RANGES = {
  listenPort: [1, 65535],
  messageMaxChars: [50, 100000],
  silenceSec: [0, 60],
  maxWindowSec: [0, 300],
  maxMsgs: [1, 100],
  maxFileMB: [1, 1024],
}

const KNOWN = new Set(Object.keys(DEFAULTS))

/**
 * 校验并归一化一次配置补丁。
 *
 * @returns {{ok: true, value: object} | {ok: false, errors: Record<string,string>}}
 */
export function validatePatch(patch) {
  const errors = {}
  const value = {}
  for (const [key, raw] of Object.entries(patch ?? {})) {
    if (!KNOWN.has(key)) {
      errors[key] = '未知配置项'
      continue
    }
    if (key === 'enabled') {
      if (typeof raw !== 'boolean') errors[key] = '必须是 true 或 false'
      else value[key] = raw
      continue
    }
    if (key === 'sessionId') {
      if (typeof raw !== 'string') errors[key] = '必须是字符串'
      else value[key] = raw.trim()
      continue
    }
    if (key === 'splitPrompt') {
      if (typeof raw !== 'string') errors[key] = '必须是字符串'
      else if (raw.length > 2000) errors[key] = '不能超过 2000 字'
      else value[key] = raw
      continue
    }
    if (key === 'debounceEnabled') {
      if (typeof raw !== 'boolean') errors[key] = '必须是 true 或 false'
      else value[key] = raw
      continue
    }
    if (key === 'sendFileEndpoint') {
      if (typeof raw !== 'boolean') errors[key] = '必须是 true 或 false'
      else value[key] = raw
      continue
    }
    if (key === 'fileWhitelist') {
      if (typeof raw !== 'boolean') errors[key] = '必须是 true 或 false'
      else value[key] = raw
      continue
    }
    if (key === 'fileDir') {
      if (typeof raw !== 'string') errors[key] = '必须是字符串'
      else if (raw.length > 500) errors[key] = '路径过长'
      else value[key] = raw.trim()
      continue
    }
    if (key === 'fileAllowDirs') {
      if (typeof raw !== 'string') errors[key] = '必须是字符串'
      else if (raw.length > 4000) errors[key] = '目录列表过长'
      else value[key] = raw
      continue
    }
    const num = Number(raw)
    const [min, max] = RANGES[key]
    if (!Number.isInteger(num)) {
      errors[key] = '必须是整数'
    } else if (num < min || num > max) {
      errors[key] = `必须在 ${min}~${max} 之间`
    } else {
      value[key] = num
    }
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, value }
}

/**
 * 读配置。文件不存在或损坏时回落默认值，并把原因报给调用方（不静默吞）。
 */
export function loadSettings(file, log = () => {}) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') log('warn', `读取 settings.json 失败：${error?.message ?? error}`)
    return { ...DEFAULTS }
  }
  let raw
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (error) {
    log('warn', `settings.json 不是合法 JSON：${error?.message ?? error}（已回落到出厂默认）`)
    return { ...DEFAULTS }
  }
  const checked = validatePatch(raw)
  if (!checked.ok) {
    log('warn', `settings.json 校验未通过：${JSON.stringify(checked.errors)}（本次已回落到出厂默认；原文件未改动）`)
    return { ...DEFAULTS }
  }
  return { ...DEFAULTS, ...checked.value }
}

/** 原子写：先写临时文件再 rename，避免半截文件。 */
export function saveSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}
