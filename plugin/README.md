# dsh-podbridge

> 本文件随插件包分发（npm 视角）。仓库总体介绍见上层 [`README.md`](../README.md)。


把聊天客户端的消息接到一个 DSH 会话：客户端发的消息投进会话，会话的回复推回客户端。

DSH 插件（Host 侧），无第三方依赖。

---

## 它做什么

```
Pod App ──HTTP/SSE──► dsh-podbridge ──prompt/事件──► 绑定的 DSH 会话
```

- **收**：`POST /send` → 聚合成批 → `sessionController.prompt({mode:'queue'})`
- **发**：订阅 `session/event` 的 `assistant/message` → 按 `[[split]]` 拆气泡 → SSE 推送
- **不管**：UI、消息状态、已读回执（这些都是 App 的事）

与定时任务类插件的关系：**两条互不知道的线**。对方拥有触发路径（什么时候叫醒），bridge 拥有消息路径（人说了什么、怎么回），两者只共享"都往同一个会话投 prompt"这个事实。

---

## 安装

1. 把仓库放到 `<目录>\dsh-podbridge`（或任意目录）
2. profile 的 `package.json` 加依赖与 bundle：

```json
{
  "dsh": { "profile": { "bundles": [..., "dsh-podbridge"] } },
  "dependencies": { "dsh-podbridge": "link:<目录>/dsh-podbridge" }
}
```

3. 在 profile 的 `node_modules` 建 junction：

```powershell
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-podbridge" `
  -Target '<目录>\dsh-podbridge'
```

4. 重载：`plugin_manager set_bundle` 对 `dsh-podbridge` 关→开

设置页出现在 **设置 → Pod 桥接**（order 8）。

---

## 配置

自管 `settings.json`（不用 schemastery——本地 link 安装解析不到该依赖）。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | false | 总开关。**只控制是否投递，不控制能不能连**——关着也能配对 |
| `sessionId` | `''` | 绑定的 DSH 会话，必填 |
| `listenPort` | 8787 | 服务端口（改端口会重启服务） |
| `messageMaxChars` | 4000 | 单条入站上限 |
| `debounceEnabled` | true | 入站聚合开关 |
| `silenceSec` | 6 | 静默窗口（秒），每条新消息重置 |
| `maxWindowSec` | 15 | 窗口总时长上限（秒） |
| `maxMsgs` | 10 | 攒满多少条立即投递 |
| `splitPrompt` | 见下 | 注入到绑定会话系统提示的文本；空字符串 = 不注入 |

---

## 接口

### 服务面（给客户端）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 存活、开关、绑定、在线数、lastSeq |
| POST | `/pair` | `{code, deviceName}` → `{token}` |
| GET | `/events?since=&token=` | SSE 推送（也接受 `Authorization: Bearer`） |
| POST | `/send` | `{clientMsgId, text}` |
| GET | `/history?beforeSeq=&limit=&token=` | 分页历史 |

帧格式见《Pod 桥接协议 v1》。要点：**没有 `ack` / `error` / `status`**，被拒绝时发 `role=system` 的 `msg`。

### 管理面（给 DSH 设置页）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/api/dsh-podbridge/config` | 读/写配置 |
| GET | `/api/dsh-podbridge/sessions` | 会话列表（排除归档、空白占位、子代理） |
| GET | `/api/dsh-podbridge/clients` | 已配对设备（只给指纹） |
| POST | `/api/dsh-podbridge/pairing-code` | 生成 6 位一次性配对码 |
| POST | `/api/dsh-podbridge/revoke-one` | 按设备指纹吊销一台 |
| POST | `/api/dsh-podbridge/revoke` | 吊销全部 |
| POST | `/api/dsh-podbridge/send-file` | 发文件给客户端，见下 |

---

## 发文件的两种入口

`pod_send_file`（工具）与 `POST /api/dsh-podbridge/send-file`（管理端点）共用
`deliverLocalFile()`：白名单、大小上限、落盘、`hub.publish` 全在一处，不会行为漂移。

请求体（端点）：

```json
{ "path": "D:\\somewhere\\report.pdf", "caption": "可选说明" }
```

成功返回 `{ok, id, name, size, mime}`；失败 400 + `{ok:false, error}`。

**选哪个**：

- 会话是**插件注册之后**新建的 → 用工具，模型自己就能调
- 会话早于插件注册（工具对它不可见），或调用方是脚本/定时任务 → 用端点

**开关**：设置页「开放发文件端点（HTTP）」默认关闭、热生效；
关闭时端点返回 `403 endpoint_disabled`。
只有"工具看不见的老会话"或脚本才需要打开它。

**必须知道的四件事**：

1. 工具的可见性在 **agent 创建时固定**：老会话看不到它，插件重载也不会补上。
2. 工具**不要设 `deferLoading`**：延迟加载会让它不出现在模型当轮的 schema 里，等于不可达。
3. 端点挂在 **DSH web 端口**（不是桥接的 8787），打到 8787 会 404。
4. 端点**没有鉴权**，与其它管理端点一样只靠"仅监听 127.0.0.1"。
   **不要把 web 端口暴露到公网**；对外只暴露 8787（数据面，有 token）。

端点与"服务端主动推送"**都不属于 Pod 协议**，换一个桥接实现不会有它们。

---

## 解除配对

三件事，范围依次变大：

| 操作 | 位置 | 影响 |
|---|---|---|
| **忘记凭证** | Pod App → 设置 | 只删**本机**凭证；服务端仍认这个 token |
| **移除**某设备 | 桥接设置页 → 已配对设备 | 删除该设备的 token 并断开它的连接，**其它设备无感** |
| **吊销全部客户端** | 桥接设置页 → 状态 | 删除全部 token 并断开所有设备，每台都要重新配对 |

只在本机点「忘记凭证」并不等于作废——如果那个 token 曾经泄露，它仍然能用。
要真正作废，必须在桥接侧「移除」或「吊销全部」。

设备列表只显示指纹（token 的 SHA-256 前 8 位），不暴露 token 本身。

---
## 数据

目录：`~/.dsh/dsh-podbridge-data`

| 文件 | 内容 |
|---|---|
| `settings.json` | 配置 |
| `clients.json` | 已配对 token（含设备名、配对时间、最近使用） |
| `bridge.log` | 运行日志；超过 2MB 轮转为 `bridge.log.1` |

---

## 分段提示

注入到**绑定会话**的系统提示，让模型可以把一条回复拆成多个气泡：

```
消息以 [chat] 开头时可分段：断开处独占一行写 [[split]]（≤4 条，代码块/表格内不用）；否则正常回复。
```

三个设计要点：

1. **注册在 agent 作用域**（`agent.ctx.systemPrompt.section`）——只影响绑定的那个会话，不污染别的会话；section 每轮重新装配，**上下文压缩后也不会丢**。
2. **必须带 `[chat]` 条件**——同一个会话你在 DSH 界面里也会用，无条件的话模型在 DSH 里也会打 `[[split]]`，而那里没人解析它。
3. 文本可在设置页随意改写，改成空字符串即关闭分段。

> 为什么不 hook `system-prompt/assemble` 瀑布：它**按作用域过滤**派发，根作用域监听收不到 agent 的装配；要 hook 就得注册到 `agent.ctx`，与直接注册 section 等价。

---

## 已知限制

- **绑定会话的所有输出都会推送**：那个会话里 agent 的所有 assistant 文本都会进 App。若会话兼作工作用途，建议给桥接绑一个**专用聊天会话**。
- **聚合缓冲只在内存**：6 秒窗口内插件重载会丢消息，客户端无从察觉（没有回执机制）。
- **消息不落盘**：重启后 `/history` 只剩本次进程产生的内容。
- **旧 section 残留**：上一代插件实例注册的 section 在 agent 重载后会报 `already registered`，需等会话重建或重启 DSH 才彻底换成新文本。
- 限流：每 IP 每分钟 60 条，配对 10 次/分钟。

---

## 开发

```bash
node --test --test-isolation=none test/    # 19 项单测
```

改完代码后：复制到部署目录 → `plugin_manager set_bundle` 关→开，无需重启 DSH。

设计文档在 `docs/`（协议、桥接设计、客户端设计、交接）。
