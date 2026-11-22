# dsh-podbridge 交接

> 开发交接笔记：面向维护者，记录决策过程、验证证据与踩坑。使用者看 `README.md` 即可。


| 项 | 值 |
| --- | --- |
| 状态 | **桥接 v1 功能完成**（2026-11-19 02:35） |
| 测试 | 19 项全过（`node --test --test-isolation=none test/`） |
| 设计文档 | 《dsh-podbridge 设计需求》《Pod 桥接协议 v1》《Pod App 设计需求》 |
| 尚未开始 | **Pod App 本体**、组网、iOS |

---

## 一、一句话状态

桥接已经能把 Pod App 的消息投进一个 DSH 会话，并把回复推回客户端。
设置页、配对、聚合、分段、限流、历史、日志轮转全部可用，**未做任何 UI 客户端**。

---

## 二、代码在哪

| 位置 | 用途 |
|---|---|
| `<目录>\dsh-podbridge` | **部署副本**（DSH 实际加载的） |
| `work_workspace/podbridge-stage` | **工作副本**（就地编辑，改完整体复制过去） |

部署步骤：

```powershell
Copy-Item -Path '<工作区>' `
          -Destination '<目录>\dsh-podbridge' -Recurse -Force
```

然后 `plugin_manager` 对 `dsh-podbridge` 执行 `set_bundle` 关→开（热重载，无需重启 DSH）。

**profile 侧已就绪**（不要重复配置）：

- `~/.dsh/profiles/desktop/package.json`：`bundles` 含 `dsh-podbridge`，`dependencies` 含 `link:<目录>/dsh-podbridge`
- `~/.dsh/profiles/desktop/node_modules/dsh-podbridge` → junction 指向 `<目录>\dsh-podbridge`

---

## 三、运行时事实

| 项 | 值 |
|---|---|
| 数据目录 | `~/.dsh/dsh-podbridge-data` |
| 配置文件 | `settings.json`（自管，不用 schemastery） |
| 客户端凭证 | `clients.json`（token → 设备名/创建时间，**落盘**，重载不失效） |
| 日志 | `bridge.log`；超过 2MB 轮转为 `bridge.log.1`（只留一份） |
| 默认端口 | **8787**（可配置；改端口会重启服务） |
| 设置页位置 | 设置 → **Pod 桥接**（order 8） |

---

## 四、接口清单

### 4.1 服务面（给 Pod App）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 存活、开关、绑定、在线数、lastSeq |
| POST | `/pair` | `{code, deviceName}` → `{token}` |
| GET | `/events?since=&token=` | **SSE 推送**（也接受 `Authorization: Bearer`） |
| POST | `/send` | `{clientMsgId, text}` → `{ok, queued}` |
| GET | `/history?beforeSeq=&limit=&token=` | 分页历史 |

### 4.2 管理面（给设置页）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/api/dsh-podbridge/config` | 读/写配置 |
| GET | `/api/dsh-podbridge/sessions` | 会话列表（排除归档、空白占位、子代理） |
| GET | `/api/dsh-podbridge/clients` | 已配对设备（只给指纹） |
| POST | `/api/dsh-podbridge/pairing-code` | 生成一次性配对码 |
| POST | `/api/dsh-podbridge/revoke-one` | 按设备指纹吊销一台（只断它的连接） |
| POST | `/api/dsh-podbridge/revoke` | 吊销全部 |

### 4.3 帧

上行 `hello` / `send` / `history` / `ping`；下行 `welcome` / `msg` / `history` / `pong` / `closed`。
**没有** `ack` / `error` / `status`——被拒绝时发 `role=system` 的 `msg`。详见《Pod 桥接协议 v1》。

---

### 4.4 三种「解除配对」的范围

| 操作 | 位置 | 影响 |
|---|---|---|
| 忘记凭证 | Pod App → 设置 | 只删本机凭证；服务端仍认这个 token |
| 移除某设备 | 桥接设置页 → 已配对设备 | 删该 token + 断开它的连接，其它设备无感 |
| 吊销全部客户端 | 桥接设置页 → 状态 | 全部删除并断开，所有设备都要重新配对 |

只在本机点「忘记凭证」不等于作废——token 泄露过的话仍然可用。

---

## 五、关键实现决定（含原因）

| 决定 | 原因 |
|---|---|
| **传输用 SSE + POST，不用 WebSocket** | profile 里没有 `ws` 包，link 安装的插件解析不到依赖；协议语义不变 |
| **投递用 `sessionController.prompt({mode:'queue'})`** | 宿主自己排队，回合进行中不打断，不需要自己 `whenIdle` |
| **出站只吃 `assistant/message`，不逐字** | 逐字要处理增量拼接/重试重置/断线续传，收益不抵复杂度 |
| **分段由模型打标 `[[split]]`** | `splitBubbles()` 按行切分，代码块内不生效，超长兜底拆 |
| **分段提示注册到 `agent.ctx.systemPrompt.section()`** | 每轮重装配 → 压缩不掉；注册在 agent 作用域 → 不污染其它会话 |
| **提示文本带「消息以 [chat] 开头时」条件** | 绑定会话同时被 DSH 界面使用，无条件则模型在 GUI 里也会打标 |
| **入站聚合：静默 6s / 窗口 15s / 攒满 10 条** | 静默从最后一条算起；窗口从第一条算；三者谁先到用谁 |
| **不做回执、不做消息状态机** | 客户端只有"…"气泡（15 秒超时），回复的有无即状态 |
| **`clientMsgId` 去重（内存 1 小时）** | 防客户端 bug 循环刷屏；不合并同文本消息 |

---

## 六、踩过的坑（都实测过）

1. **`map()` 回调漏 `return` = 一半功能静默失效**：附件的图片分支有 `return makeNode(...)`，
   文件分支建了卡片、挂了点击事件却忘了 `return card` —— 表现是"图片能显示、文件卡片完全不出现"，
   而且不报错。**同一函数里有多个分支时，逐个确认都有返回值。**
2. **WebView 不自带下载能力**：`<a download>` 在 WebView 里不触发保存，无法显示的类型（apk/zip）
   点击后毫无反应；`.txt` 因为被内联打开，看起来"正常"，掩盖了问题。
   宿主必须实现 `DownloadManager` 接管（本项目通过 `PodShell.downloadFile()` 暴露给页面）。
3. **工具可见性在 agent 创建时固定**：插件注册之后新建的会话才有该工具；老会话看不到，
   插件重载也不会补上。所以"给模型用的工具"要同时准备一条 HTTP 兜底路径。
4. **Windows 批处理必须 CRLF，且 .vbs 不能带 BOM**：用脚本生成 .bat 时默认是 LF，
   cmd 会把整个文件当一行执行——`@echo off` 之后全被吞掉，现象是**一个全黑的窗口、什么都没发生**。
   .vbs 反过来：带 UTF-8 BOM 会报"无效字符 800A0408"。两个都要 CRLF + 无 BOM（.vbs 还要纯 ASCII）。
2. **`start /min` 不等于隐藏窗口**：它只是最小化。控制台程序的日志若走文件，
   窗口里永远是黑的，用户会看到一个莫名的黑框。要真隐藏得用
   `WScript.Shell.Run(..., 0, False)`。
3. **Windows 写的 .sh 直接喂给远端 bash 会因 CRLF 报 `：https 页面请求 http 会被拦，
   界面上只显示"未连接"，日志里连请求都没有。`127.0.0.1` 被豁免，
   所以 USB 正常、换公网 IP 才炸——这个对比极易误判为网络故障。
4. **PowerShell 5.1 读无 BOM 的 UTF-8 .ps1 会按 ANSI 解码**：中文变乱码并导致语法错误。
   .ps1/.vbs 里要么只用 ASCII，要么写 UTF-8 带 BOM（.vbs 带 BOM 反而报"无效字符"）。
5. **PowerShell 传空字符串参数会被吞掉**：`ssh-keygen -N ''` 变成少一个参数（Too many arguments）。
   要传空参数得用 Node 的 `spawnSync` 之类，或写到临时脚本里。
6. **ssh-keygen 在工作区写 .pub 会报 Bad file descriptor**：换到 TEMP 或工作区外目录即可。
7. **CORS 漏加自定义头（第二次踩）**：给上传加 `x-file-type` 头却没进
   `access-control-allow-headers`，预检失败，浏览器只报"上传失败"。
   **加任何自定义请求头，必须同步加进 CORS 白名单**。
8. **Android WebView 没有默认文件选择器**：不实现 `onShowFileChooser`，
   页面里所有 `<input type="file">` 全部无声失效；这不需要任何存储权限。
9. **Android WebView 没有 Notification API**：`typeof Notification === 'undefined'`，
   必须走原生通知桥；设置页的能力判断要认这个桥。
10. **表情不能过 canvas**：经裁剪/转码的 GIF 会变成静态 JPEG。表情必须原样存原始 Blob。
11. **Kotlin 块注释可嵌套**：注释里写 `/local/*` 会开出第二层注释，导致文件后半段全被吞掉，
   报错却是"某某未解析"。写路径时别在注释里留 `/*`。
12. **WebView 的 shouldInterceptRequest 拿不到 POST body**：想用 HTTP 拦截实现文件写入是行不通的，
   必须走 `addJavascriptInterface`（字节 base64 传）。
13. **手机与电脑连不通时先看二层**：`ping 网关` 都失败说明 Wi-Fi 有客户端隔离，
   与防火墙无关。开发期用 `adb reverse tcp:8787 tcp:8787` 绕开。
14. **`system-prompt/assemble` 是按作用域派发的**——根作用域监听（即使带 `{global:true}`）也收不到 agent 的装配。要 hook 必须注册到 `agent.ctx`，与直接注册 section 等价。
15. **section 注册会残留在 agent 作用域里**——插件重载后旧注册还在，新的会报 `already registered`。必须保存 `section()` 返回的 disposer 并在卸载时调用。
16. **归档集合的字段在 `frame.value` 里**：`{type:'baseline', value:{archivedSessionIds}}`，不是 `frame.archivedSessionIds`。且 `sessionController.list` 不过滤归档。
17. **PowerShell 发 JSON 会毁中文**——`Invoke-RestMethod -Body $string` 会把中文变 `?`。必须用 `[Text.Encoding]::UTF8.GetBytes($json)` + `charset=utf-8`。
18. **`Start-Process` 会拆散带空格的参数**——`curl -H "Authorization: Bearer x"` 会变成两个参数。用 URL 里的 `token=` 避开。
19. **子进程随工具调用结束被回收**——`Start-Process curl` 在下一个 pwsh 调用时已死。抓 SSE 必须在**同一个命令**里完成。
20. **.NET 文件 API 的相对路径按进程 cwd 解析**，不是 PowerShell 当前位置。一律用绝对路径。
21. **浏览器记不住用户选的文件路径**：发出的文件若不存副本，历史里只能重新下载，离线直接看不到。
22. **IndexedDB 统计容量不能 `getAll()`**：blob 与元数据同表时，统计会反序列化所有文件，几 GB 就卡死（QQ 清理缓存慢同理）。必须分表，只读元数据。
23. **迁移逻辑不能写在 `onsuccess` 里**：那会每次打开数据库都全量扫描；要放在 `onupgradeneeded` 且限定 `oldVersion`。
24. **界面文案要解耦**：不要写"会从桥接重新拉取（缓冲 50 条）"这类实现细节——换个桥接实现就是假的。只描述客户端自己知道的事。
25. **客户端有内核基线（Chrome 88）**：老安卓 WebView 会白屏。已在 `index.html` 用普通脚本做检测并给提示；
    改前端语法/样式时注意不要无意抬高基线。

26. **Electron preload 在本机会被静默跳过**：页面正常加载、不报 `preload-error`，但 preload 完全没执行。
    试过加诊断、关 `sandbox`、改路径都无效。结论：**壳与界面的能力走同源 HTTP 接口**，不做 preload，
    出错时有状态码可查。
27. **`String.replace` 会静默不匹配**：引号嵌套容易失败而不报错，改文案的脚本必须显式断言。
28. **`Set-Content -Encoding UTF8` 会写 BOM**，DSH 读 `package.json` 直接失败（`Unexpected token '\uFEFF'`）。
   改 package.json 必须用 `[System.IO.File]::WriteAllText(path, text, UTF8Encoding($false))`。
29. **客户端渲染错误不会冒烟**：用了未定义的 `formatTime`，页面白屏，而语法检查与单测全过。
   现在有 `podbridge-render-check.mjs`（桩 React 渲染一遍，缺关键文案或抛异常就失败），改完必跑。

---

30. **SSE 路由里 token 未传参**：`handleEvents` 用了外层 `token` 却没接参数，请求一进来就抛异常、连接立刻断——表现为"界面显示已连接，但一条消息都收不到"。
31. **消息 seq 不能只在内存里数**：重启后从 1 重来，和客户端缓存里的旧 seq 撞号，客户端按 seq 去重 → 新消息全被当重复丢弃。现已落盘 `hub-state.json`。
32. **客户端去重键不能只看 seq**：用 `seq + at + 文本前缀`，否则编号一重复就误判。
33. **`/files/<id>` 必须接受查询串 token**：`<img src>` 加不了 Authorization 头，只认头会让所有图片 401 裂开。
34. **自定义请求头要同步进 CORS**：`x-file-name` 不在 allow-headers 里，上传前的 OPTIONS 预检失败，浏览器只报 `Failed to fetch`。
35. **`Node.append(null)` 会插入字符串 "null"**：`makeNode` 过滤 null，直接 `append` 不会。

## 七、已知限制

| 限制 | 影响 | 处理 |
|---|---|---|
| 聚合缓冲只在内存 | 6 秒窗口内插件重载 → 消息丢失，客户端无从察觉 | 已写进设计文档 7.1，接受 |
| 消息不落盘 | 重启后 `/history` 只剩本次进程产生的内容 | 设计上接受（客户端有自己的缓存） |
| `closed` 帧无人处理 | 服务端会发，客户端还没实现 | 属于 Pod App 的工作 |
| 旧 section 残留 | 我迭代期间注册的 `podbridge-split` 还在某个 agent 作用域里，改文本要等会话重建 | 新装用户无此问题 |
| **绑定会话的全部输出都会推送** | 该会话里 agent 的所有 assistant 文本都会进 App，包括工作内容 | 已决定暂不过滤；建议给桥接绑一个**专用聊天会话**（qqbot 就是自己建专用会话，所以没这问题） |
| 会话列表依赖投影取标题 | 标题没有独立字段，从 `projections.values` 里按 key 名匹配；DSH 改投影结构时会失效（表现为下拉项无名称） | 过滤条件同时看 `blank` 与 `origin=subagent`，否则会把占位会话也列出来 |

## 八、怎么快速验一遍

```powershell
# 1. 开桥接并绑定（把 sid 换成目标会话）
Invoke-RestMethod -Uri 'http://127.0.0.1:<GUI端口>/api/dsh-podbridge/config' -Method Post `
  -ContentType 'application/json' -Body '{"enabled":true,"sessionId":"<sid>","silenceSec":1}'

# 2. 配对
$code = (Invoke-RestMethod -Uri 'http://127.0.0.1:<GUI端口>/api/dsh-podbridge/pairing-code' -Method Post).code
$pair = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/pair' -Method Post `
  -ContentType 'application/json' -Body "{`"code`":`"$code`",`"deviceName`":`"test`"}"

# 3. 抓 SSE + 发消息（必须在同一个命令里，否则 curl 会被回收）
# 4. 看 ~/.dsh/dsh-podbridge-data/bridge.log 里的「入队 #n」与「聚合投递」
```

GUI 端口每个会话不同，用运行时上下文里的 URL；桥接端口默认 8787。

---

## 九、下一步

1. **Pod App**：先做网页版（`pod-app/web`），浏览器里跑通再包壳（Windows=Electron，Android=Capacitor）
2. **组网**：先用局域网，功能验证完再配 frp / Tailscale
3. 桥接侧只剩小事：`closed` 帧的客户端配合（属于 App）、消息落盘（可不做）
\r': command not found`**：
   行尾成了 ``，某些行会被拼错。跨平台脚本要么写完转 LF，要么远端正则里去 ``。
2. **frp 两端版本不一致时先对齐**：本机已有 0.65.0、服务器装的是 0.61.0，
   最终把服务器升到 0.65.0。协议通常兼容，但排错时会多一个变量。
3. **frp 的 `port unavailable` 表示服务器端端口被占**：切方案时旧 SSH 隧道没断，
   新 frpc 抢不到 18787，现象是 frpc 连上了但代理起不来。
4. **WebView 的 Mixed Content 是静默失败**：https 页面请求 http 会被拦，
   界面上只显示"未连接"，日志里连请求都没有。`127.0.0.1` 被豁免，
   所以 USB 正常、换公网 IP 才炸——这个对比极易误判为网络故障。
2. **PowerShell 5.1 读无 BOM 的 UTF-8 .ps1 会按 ANSI 解码**：中文变乱码并导致语法错误。
   .ps1/.vbs 里要么只用 ASCII，要么写 UTF-8 带 BOM（.vbs 带 BOM 反而报"无效字符"）。
3. **PowerShell 传空字符串参数会被吞掉**：`ssh-keygen -N ''` 变成少一个参数（Too many arguments）。
   要传空参数得用 Node 的 `spawnSync` 之类，或写到临时脚本里。
4. **ssh-keygen 在工作区写 .pub 会报 Bad file descriptor**：换到 TEMP 或工作区外目录即可。
5. **CORS 漏加自定义头（第二次踩）**：给上传加 `x-file-type` 头却没进
   `access-control-allow-headers`，预检失败，浏览器只报"上传失败"。
   **加任何自定义请求头，必须同步加进 CORS 白名单**。
6. **Android WebView 没有默认文件选择器**：不实现 `onShowFileChooser`，
   页面里所有 `<input type="file">` 全部无声失效；这不需要任何存储权限。
7. **Android WebView 没有 Notification API**：`typeof Notification === 'undefined'`，
   必须走原生通知桥；设置页的能力判断要认这个桥。
8. **表情不能过 canvas**：经裁剪/转码的 GIF 会变成静态 JPEG。表情必须原样存原始 Blob。
9. **Kotlin 块注释可嵌套**：注释里写 `/local/*` 会开出第二层注释，导致文件后半段全被吞掉，
   报错却是"某某未解析"。写路径时别在注释里留 `/*`。
10. **WebView 的 shouldInterceptRequest 拿不到 POST body**：想用 HTTP 拦截实现文件写入是行不通的，
   必须走 `addJavascriptInterface`（字节 base64 传）。
11. **手机与电脑连不通时先看二层**：`ping 网关` 都失败说明 Wi-Fi 有客户端隔离，
   与防火墙无关。开发期用 `adb reverse tcp:8787 tcp:8787` 绕开。
12. **`system-prompt/assemble` 是按作用域派发的**——根作用域监听（即使带 `{global:true}`）也收不到 agent 的装配。要 hook 必须注册到 `agent.ctx`，与直接注册 section 等价。
13. **section 注册会残留在 agent 作用域里**——插件重载后旧注册还在，新的会报 `already registered`。必须保存 `section()` 返回的 disposer 并在卸载时调用。
14. **归档集合的字段在 `frame.value` 里**：`{type:'baseline', value:{archivedSessionIds}}`，不是 `frame.archivedSessionIds`。且 `sessionController.list` 不过滤归档。
15. **PowerShell 发 JSON 会毁中文**——`Invoke-RestMethod -Body $string` 会把中文变 `?`。必须用 `[Text.Encoding]::UTF8.GetBytes($json)` + `charset=utf-8`。
16. **`Start-Process` 会拆散带空格的参数**——`curl -H "Authorization: Bearer x"` 会变成两个参数。用 URL 里的 `token=` 避开。
17. **子进程随工具调用结束被回收**——`Start-Process curl` 在下一个 pwsh 调用时已死。抓 SSE 必须在**同一个命令**里完成。
18. **.NET 文件 API 的相对路径按进程 cwd 解析**，不是 PowerShell 当前位置。一律用绝对路径。
19. **浏览器记不住用户选的文件路径**：发出的文件若不存副本，历史里只能重新下载，离线直接看不到。
20. **IndexedDB 统计容量不能 `getAll()`**：blob 与元数据同表时，统计会反序列化所有文件，几 GB 就卡死（QQ 清理缓存慢同理）。必须分表，只读元数据。
21. **迁移逻辑不能写在 `onsuccess` 里**：那会每次打开数据库都全量扫描；要放在 `onupgradeneeded` 且限定 `oldVersion`。
22. **界面文案要解耦**：不要写"会从桥接重新拉取（缓冲 50 条）"这类实现细节——换个桥接实现就是假的。只描述客户端自己知道的事。
23. **客户端有内核基线（Chrome 88）**：老安卓 WebView 会白屏。已在 `index.html` 用普通脚本做检测并给提示；
    改前端语法/样式时注意不要无意抬高基线。

24. **Electron preload 在本机会被静默跳过**：页面正常加载、不报 `preload-error`，但 preload 完全没执行。
    试过加诊断、关 `sandbox`、改路径都无效。结论：**壳与界面的能力走同源 HTTP 接口**，不做 preload，
    出错时有状态码可查。
25. **`String.replace` 会静默不匹配**：引号嵌套容易失败而不报错，改文案的脚本必须显式断言。
26. **`Set-Content -Encoding UTF8` 会写 BOM**，DSH 读 `package.json` 直接失败（`Unexpected token '\uFEFF'`）。
   改 package.json 必须用 `[System.IO.File]::WriteAllText(path, text, UTF8Encoding($false))`。
27. **客户端渲染错误不会冒烟**：用了未定义的 `formatTime`，页面白屏，而语法检查与单测全过。
   现在有 `podbridge-render-check.mjs`（桩 React 渲染一遍，缺关键文案或抛异常就失败），改完必跑。

---

28. **SSE 路由里 token 未传参**：`handleEvents` 用了外层 `token` 却没接参数，请求一进来就抛异常、连接立刻断——表现为"界面显示已连接，但一条消息都收不到"。
29. **消息 seq 不能只在内存里数**：重启后从 1 重来，和客户端缓存里的旧 seq 撞号，客户端按 seq 去重 → 新消息全被当重复丢弃。现已落盘 `hub-state.json`。
30. **客户端去重键不能只看 seq**：用 `seq + at + 文本前缀`，否则编号一重复就误判。
31. **`/files/<id>` 必须接受查询串 token**：`<img src>` 加不了 Authorization 头，只认头会让所有图片 401 裂开。
32. **自定义请求头要同步进 CORS**：`x-file-name` 不在 allow-headers 里，上传前的 OPTIONS 预检失败，浏览器只报 `Failed to fetch`。
33. **`Node.append(null)` 会插入字符串 "null"**：`makeNode` 过滤 null，直接 `append` 不会。

## 七、已知限制

| 限制 | 影响 | 处理 |
|---|---|---|
| 聚合缓冲只在内存 | 6 秒窗口内插件重载 → 消息丢失，客户端无从察觉 | 已写进设计文档 7.1，接受 |
| 消息不落盘 | 重启后 `/history` 只剩本次进程产生的内容 | 设计上接受（客户端有自己的缓存） |
| `closed` 帧无人处理 | 服务端会发，客户端还没实现 | 属于 Pod App 的工作 |
| 旧 section 残留 | 我迭代期间注册的 `podbridge-split` 还在某个 agent 作用域里，改文本要等会话重建 | 新装用户无此问题 |
| **绑定会话的全部输出都会推送** | 该会话里 agent 的所有 assistant 文本都会进 App，包括工作内容 | 已决定暂不过滤；建议给桥接绑一个**专用聊天会话**（qqbot 就是自己建专用会话，所以没这问题） |
| 会话列表依赖投影取标题 | 标题没有独立字段，从 `projections.values` 里按 key 名匹配；DSH 改投影结构时会失效（表现为下拉项无名称） | 过滤条件同时看 `blank` 与 `origin=subagent`，否则会把占位会话也列出来 |

## 八、怎么快速验一遍

```powershell
# 1. 开桥接并绑定（把 sid 换成目标会话）
Invoke-RestMethod -Uri 'http://127.0.0.1:<GUI端口>/api/dsh-podbridge/config' -Method Post `
  -ContentType 'application/json' -Body '{"enabled":true,"sessionId":"<sid>","silenceSec":1}'

# 2. 配对
$code = (Invoke-RestMethod -Uri 'http://127.0.0.1:<GUI端口>/api/dsh-podbridge/pairing-code' -Method Post).code
$pair = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/pair' -Method Post `
  -ContentType 'application/json' -Body "{`"code`":`"$code`",`"deviceName`":`"test`"}"

# 3. 抓 SSE + 发消息（必须在同一个命令里，否则 curl 会被回收）
# 4. 看 ~/.dsh/dsh-podbridge-data/bridge.log 里的「入队 #n」与「聚合投递」
```

GUI 端口每个会话不同，用运行时上下文里的 URL；桥接端口默认 8787。

---

## 九、下一步

1. **Pod App**：先做网页版（`pod-app/web`），浏览器里跑通再包壳（Windows=Electron，Android=Capacitor）
2. **组网**：先用局域网，功能验证完再配 frp / Tailscale
3. 桥接侧只剩小事：`closed` 帧的客户端配合（属于 App）、消息落盘（可不做）
