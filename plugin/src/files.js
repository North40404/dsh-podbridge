// 文件存储。
//
// 存盘策略（参考 dsh-qqbot 的做法）：
//   · 文件落盘后，**只在文本里给出绝对路径**，由模型用自己的工具去读
//   · 不把二进制塞进 prompt 的 content 块 —— 简单、通用、不依赖 content 块的能力
//
// 命名：`<id>__<净化后的原名>`，id 形如 `20261119-ab12cd`
// 找文件时按 id 前缀扫描目录（量小，够用），避免再维护一份索引。

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}

export function mimeOf(name) {
  return MIME_BY_EXT[path.extname(String(name ?? '')).toLowerCase()] ?? 'application/octet-stream'
}

/** 文件名净化：去路径、去非法字符，保留中文等 Unicode；防止路径穿越。 */
export function sanitizeName(input) {
  const base = path.basename(String(input ?? '')).normalize('NFC')
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()
  return cleaned.length > 0 ? cleaned.slice(0, 120) : 'file'
}

function humanSize(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

export function createFiles({ dir, maxBytes, clock, log = () => {} }) {
  const root = path.resolve(dir)

  function ensureDir() {
    fs.mkdirSync(root, { recursive: true })
    return root
  }

  /** 存一段字节，返回元信息。 */
  function save(buffer, originalName) {
    ensureDir()
    const name = sanitizeName(originalName)
    const id = `${new Date(clock.now()).toISOString().slice(0, 10).replace(/-/g, '')}-${crypto
      .randomBytes(3)
      .toString('hex')}`
    const filePath = path.join(root, `${id}__${name}`)
    fs.writeFileSync(filePath, buffer)
    return { id, name, size: buffer.length, mime: mimeOf(name), path: filePath }
  }

  /** 按 id 找已存文件；找不到返回 null。 */
  function find(id) {
    const want = String(id ?? '')
    if (!/^[0-9]{8}-[0-9a-f]{6}$/.test(want)) return null
    let entries = []
    try {
      entries = fs.readdirSync(root)
    } catch {
      return null
    }
    const hit = entries.find((entry) => entry.startsWith(`${want}__`))
    if (!hit) return null
    const filePath = path.join(root, hit)
    try {
      const stat = fs.statSync(filePath)
      const name = hit.slice(want.length + 2)
      return { id: want, name, size: stat.size, mime: mimeOf(name), path: filePath }
    } catch {
      return null
    }
  }

  /** 文本里给模型看的附件说明。 */
  function describe(meta) {
    return `[附件] ${path.resolve(meta.path)}（${meta.mime}，${humanSize(meta.size)}）`
  }

  return { root, ensureDir, save, find, describe, maxBytes, humanSize }
}
