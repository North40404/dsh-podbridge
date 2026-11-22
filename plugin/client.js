// dsh-podbridge · Client 半：设置页（总开关 + 绑定会话 + 配对码 + 客户端状态）。
//
// 形状与 dsh-tick 一致：
//   · window.__ModuleLoader__.load 注册惰性工厂，id = 包名；
//   · ctx.slots.inject('settings.section', () => ctx.slots.register(...))；
//   · apply 必须 fail-soft。
//
// 只跟桥接的**管理面**说话（/api/dsh-podbridge/*），与聊天协议无关。

window.__ModuleLoader__.load({
  id: 'dsh-podbridge',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 粗略 token 估算：中文≈1 token/字，其余≈1/4。只为给用户一个量级感，不是精确值。 */
    function roughTokens(text) {
      const s = String(text ?? '')
      const cjk = (s.match(/[\u4e00-\u9fff]/g) ?? []).length
      const rest = s.length - cjk
      return Math.round(cjk + rest / 4)
    }

    /** 时间戳 -> MM/DD HH:mm；无效值显示破折号。 */
    function formatTime(ms) {
      const value = Number(ms)
      if (!Number.isFinite(value) || value <= 0) return '—'
      const date = new Date(value)
      const pad = (n) => String(n).padStart(2, '0')
      return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }
    const CONFIG_PATH = '/api/dsh-podbridge/config'
    const SESSIONS_PATH = '/api/dsh-podbridge/sessions'
    const CODE_PATH = '/api/dsh-podbridge/pairing-code'
    const REVOKE_PATH = '/api/dsh-podbridge/revoke'
    const CLIENTS_PATH = '/api/dsh-podbridge/clients'
    const REVOKE_ONE_PATH = '/api/dsh-podbridge/revoke-one'

    const styles = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '4px 0' },
      row: { display: 'flex', flexDirection: 'column', gap: '4px' },
      actions: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px', flexWrap: 'wrap' },
      label: { fontSize: '13px', fontWeight: 600 },
      hint: { fontSize: '12px', color: 'var(--dsw-alias-text-secondary, #6b7280)' },
      error: { fontSize: '12px', color: 'var(--dsw-alias-text-danger, #dc2626)' },
      status: { fontSize: '12px', color: 'var(--dsw-alias-text-secondary, #6b7280)' },
      shortInput: { width: '180px', padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border, #d1d5db)' },
      button: { padding: '6px 12px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border, #d1d5db)', cursor: 'pointer' },
      code: { fontFamily: 'monospace', fontSize: '20px', letterSpacing: '4px', fontWeight: 700 },
      info: { fontSize: '12px', lineHeight: '1.6' },
      deviceList: { display: 'flex', flexDirection: 'column', gap: '6px' },
      deviceRow: { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0', borderBottom: '1px solid var(--dsw-alias-border, #e5e7eb)' },
      deviceMain: { flex: 1, minWidth: 0 },
      deviceName: { fontSize: '13px', fontWeight: 600 },
      deviceId: { fontWeight: 400, color: 'var(--dsw-alias-text-secondary, #6b7280)' },
    }

    /**
     * 错误边界：单个渲染异常不能让整个设置页白屏。
     * （就吃过一次亏——用了未定义的函数，页面直接空白，什么都看不到。）
     */
    class SettingsBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error }
      }
      render() {
        if (this.state.error) {
          return h('div', { style: styles.wrap },
            h('h3', { style: styles.label }, 'Pod 桥接'),
            h('div', { style: styles.error },
              `设置页渲染失败：${String(this.state.error?.message ?? this.state.error)}`),
            h('div', { style: styles.hint }, '插件本体仍在运行；修复代码后刷新页面即可恢复。'))
        }
        return this.props.children
      }
    }

    function BridgeSettingsSafe() {
      return h(SettingsBoundary, null, h(BridgeSettings))
    }
    function BridgeSettings() {
      const [config, setConfig] = React.useState(null)
      const [defaults, setDefaults] = React.useState(null)
      const [runtime, setRuntime] = React.useState(null)
      const [sessions, setSessions] = React.useState([])
      const [busy, setBusy] = React.useState(false)
      const [status, setStatus] = React.useState('')
      const [errors, setErrors] = React.useState({})
      const [code, setCode] = React.useState(null)
      const [devices, setDevices] = React.useState([])

      // 状态提示自动消失：否则上一条"点保存生效"会一直挂在那里，看起来像卡住
      const statusTimer = React.useRef(null)
      const flashStatus = React.useCallback((text, ms = 6000) => {
        if (statusTimer.current) {
          clearTimeout(statusTimer.current)
          statusTimer.current = null
        }
        setStatus(text)
        if (text && ms > 0) {
          statusTimer.current = setTimeout(() => {
            statusTimer.current = null
            setStatus('')
          }, ms)
        }
      }, [])
      React.useEffect(() => () => {
        if (statusTimer.current) clearTimeout(statusTimer.current)
      }, [])

      const loadAll = React.useCallback(async () => {
        try {
          const res = await fetch(CONFIG_PATH, { cache: 'no-store' })
          const body = await res.json().catch(() => null)
          if (!res.ok || !body?.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
          setConfig(body.config)
          setDefaults(body.defaults ?? null)
          setRuntime(body.runtime ?? null)
          const sres = await fetch(SESSIONS_PATH, { cache: 'no-store' })
          const sbody = await sres.json().catch(() => null)
          if (sres.ok && sbody?.ok) setSessions(sbody.items ?? [])
          const dres = await fetch(CLIENTS_PATH, { cache: 'no-store' })
          const dbody = await dres.json().catch(() => null)
          if (dres.ok && dbody?.ok) setDevices(dbody.items ?? [])
        } catch (err) {
          setErrors({ _: err instanceof Error ? err.message : String(err) })
        }
      }, [])

      React.useEffect(() => {
        void loadAll()
      }, [loadAll])

      const setField = (key, value) => {
        setStatus('')
        setConfig((current) => (current ? { ...current, [key]: value } : current))
      }

      const save = React.useCallback(
        async (event) => {
          event.preventDefault()
          if (busy || !config) return
          setBusy(true)
          setErrors({})
          setStatus('')
          try {
            const res = await fetch(CONFIG_PATH, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(config),
            })
            const body = await res.json().catch(() => null)
            if (!res.ok || !body?.ok) {
              setErrors(body?.errors ?? { _: body?.error ?? '保存失败' })
              return
            }
            setConfig(body.config)
            setRuntime(body.runtime ?? null)
            flashStatus('已保存，新参数立即生效。')
          } catch (err) {
            setErrors({ _: err instanceof Error ? err.message : String(err) })
          } finally {
            setBusy(false)
          }
        },
        [busy, config],
      )

      const makeCode = React.useCallback(async () => {
        setBusy(true)
        setErrors({})
        try {
          const res = await fetch(CODE_PATH, { method: 'POST' })
          const body = await res.json().catch(() => null)
          if (!res.ok || !body?.ok) throw new Error(body?.error ?? '生成失败')
          setCode(body)
          flashStatus('配对码 5 分钟内有效，仅可使用一次。')
        } catch (err) {
          setErrors({ _: err instanceof Error ? err.message : String(err) })
        } finally {
          setBusy(false)
        }
      }, [])

      const revokeOne = React.useCallback(async (device) => {
        if (busy) return
        const canConfirm = typeof window !== 'undefined' && typeof window.confirm === 'function'
        if (canConfirm && !window.confirm(`移除设备「${device.deviceName || '未命名设备'}」？\n\n它会立刻断开，需要重新配对；其它设备不受影响。`)) {
          return
        }
        setBusy(true)
        try {
          const res = await fetch(REVOKE_ONE_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: device.id }),
          })
          const body = await res.json().catch(() => null)
          if (!res.ok || !body?.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
          setStatus(`已移除设备 ${device.deviceName || device.id}`)
          await loadAll()
        } catch (err) {
          setErrors({ _: err instanceof Error ? err.message : String(err) })
        } finally {
          setBusy(false)
        }
      }, [busy, loadAll])

      const revoke = React.useCallback(async () => {

        if (busy) return
        const ok = typeof window === 'undefined' || typeof window.confirm !== 'function'
          ? true
          : window.confirm('吊销全部客户端凭证？已连接的 App 会立刻断开，需要重新配对。')
        if (!ok) return
        setBusy(true)
        try {
          await fetch(REVOKE_PATH, { method: 'POST' })
          flashStatus('已吊销。')
          setCode(null)
          await loadAll()
        } catch (err) {
          setErrors({ _: err instanceof Error ? err.message : String(err) })
        } finally {
          setBusy(false)
        }
      }, [busy, loadAll])

      if (config === null) {
        return h('div', { style: styles.wrap },
          h('h3', { style: styles.label }, 'Pod 桥接'),
          errors._
            ? h('div', { style: styles.error }, String(errors._))
            : h('div', { style: styles.hint }, '读取配置中…'))
      }

      const boundMissing = !config.sessionId

      return h(
        'form',
        { style: styles.wrap, onSubmit: save },
        h('h3', { style: styles.label }, 'Pod 桥接'),
        h('div', { style: styles.hint },
          '把手机/电脑上的 Pod App 接到一个 DSH 会话：App 发的消息投进会话，会话的回复推回 App。',
          ' 与 DSH-Tick 无关——tick 管"什么时候叫醒"，桥接管"人说了什么、怎么回"。'),

        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' } },
          h('input', {
            id: 'pod-enabled',
            type: 'checkbox',
            checked: config.enabled !== false,
            disabled: busy,
            onChange: (event) => setField('enabled', event.target.checked),
          }),
          h('label', { htmlFor: 'pod-enabled', style: styles.label }, '启用桥接'),
        ),
        h('div', { style: styles.hint },
          '关闭后手机发来的消息会被**拒绝**（不暂存），并回一条系统提示。',
          ' 勾选/取消后需要点下方「保存配置」才生效——保存即生效，不需要重载插件。'),

        h('div', { style: styles.row },
          h('label', { style: styles.label }, '绑定的 DSH 会话（必填）'),
          h('select', {
            style: { ...styles.shortInput, width: '420px' },
            value: config.sessionId ?? '',
            disabled: busy,
            onChange: (event) => setField('sessionId', event.target.value),
          },
            h('option', { value: '' }, '— 未绑定 —'),
            ...sessions.map((item) =>
              h('option', { key: item.sessionId, value: item.sessionId },
                `${item.title || '未命名会话'} · ${String(item.sessionId).slice(0, 6)}${item.running ? ' · 运行中' : ''}`),
            ),
          ),
          h('div', { style: styles.hint },
            '只列出未归档的会话。切换绑定前请先关闭总开关，并确认没有正在进行的回合。'),
          boundMissing ? h('div', { style: styles.error }, '未绑定会话时，App 发来的消息无法投递。') : null,
        ),

        h('div', { style: styles.row },
          h('label', { style: styles.label }, '监听端口'),
          h('input', {
            style: styles.shortInput,
            type: 'number',
            min: 1,
            max: 65535,
            value: config.listenPort ?? 8787,
            disabled: busy,
            onChange: (event) => setField('listenPort', event.target.value),
          }),
          h('div', { style: styles.hint }, 'Pod App 连这个端口。改端口后服务会重启，已连接的客户端需要重连。'),
        ),

        h('div', { style: styles.row },
          h('label', { style: styles.label }, '单条消息字数上限'),
          h('input', {
            style: styles.shortInput,
            type: 'number',
            min: 50,
            max: 100000,
            value: config.messageMaxChars ?? 4000,
            disabled: busy,
            onChange: (event) => setField('messageMaxChars', event.target.value),
          }),
        ),

        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' } },
          h('input', {
            id: 'pod-debounce',
            type: 'checkbox',
            checked: config.debounceEnabled !== false,
            disabled: busy,
            onChange: (event) => setField('debounceEnabled', event.target.checked),
          }),
          h('label', { htmlFor: 'pod-debounce', style: styles.label }, '消息聚合'),
        ),
        h('div', { style: styles.hint },
          '把连续发送的多条消息合成一次投递。典型场景：先发表情、再打字——',
          '不聚合就会「表情回一句、后面的话又回一句」。关闭后每条消息立即投递。'),
        config.debounceEnabled !== false
          ? h('div', { style: { display: 'flex', gap: '12px', flexWrap: 'wrap' } },
              h('div', { style: styles.row },
                h('label', { style: styles.label }, '静默（秒）'),
                h('input', {
                  style: styles.shortInput,
                  type: 'number',
                  min: 0,
                  max: 60,
                  value: config.silenceSec ?? 6,
                  disabled: busy,
                  onChange: (event) => setField('silenceSec', event.target.value),
                }),
                h('div', { style: styles.hint }, '最后一条消息之后等这么久再投递。0 = 立即投递。'),
              ),
              h('div', { style: styles.row },
                h('label', { style: styles.label }, '窗口上限（秒）'),
                h('input', {
                  style: styles.shortInput,
                  type: 'number',
                  min: 0,
                  max: 300,
                  value: config.maxWindowSec ?? 15,
                  disabled: busy,
                  onChange: (event) => setField('maxWindowSec', event.target.value),
                }),
                h('div', { style: styles.hint }, '一直不停口也最多等这么久。0 = 不设上限（不建议）。'),
              ),
              h('div', { style: styles.row },
                h('label', { style: styles.label }, '攒满条数'),
                h('input', {
                  style: styles.shortInput,
                  type: 'number',
                  min: 1,
                  max: 100,
                  value: config.maxMsgs ?? 10,
                  disabled: busy,
                  onChange: (event) => setField('maxMsgs', event.target.value),
                }),
                h('div', { style: styles.hint }, '攒够这么多条立即投递。'),
              ),
            )
          : null,

        h('hr', { style: { border: 'none', borderTop: '1px solid var(--dsw-alias-border, #e5e7eb)', margin: '6px 0' } }),

        h('div', { style: styles.row },
          h('label', { style: styles.label }, '注入的提示词'),
          h('div', { style: styles.hint },
            `这段文字注入到**绑定会话的系统提示**，每轮请求都会重新装配（上下文压缩后也不会丢）。当前 ${(config.splitPrompt ?? '').length} 字，约 ${roughTokens(config.splitPrompt)} tokens/请求。`,
          ),
          h('textarea', {
            style: { ...styles.shortInput, width: '100%', minHeight: '70px', fontFamily: 'inherit', lineHeight: 1.6 },
            value: config.splitPrompt ?? '',
            disabled: busy,
            onChange: (event) => setField('splitPrompt', event.target.value),
          }),
          h('div', { style: styles.actions },
            h('button', {
              type: 'button',
              style: styles.button,
              disabled: busy || !defaults,
              onClick: () => {
                if (!defaults) return
                setField('splitPrompt', defaults.splitPrompt ?? '')
                flashStatus('已填入默认提示词，点「保存全部配置」生效。')
              },
            }, '恢复默认提示词'),
            h('span', { style: styles.hint }, `默认 ${roughTokens(defaults?.splitPrompt)} tokens/请求`),
          ),
          h('div', { style: styles.hint },
            '**占用上下文**：系统提示会随每个请求发送，所以这段文字是**按请求计费**的（不是一次性的）。',
            '内容稳定时通常命中提示词缓存，实际开销明显低于账面；但上下文窗口里确实占着这些位置。',
            '所以：**能压就压**，不要写成一大段说明书。',
          ),
          h('div', { style: styles.hint },
            '可以随意改写——语气、额外约定都可以加；改成空字符串 = 不注入。',
          ),
          h('div', { style: styles.hint },
            '**请保留「消息以 [chat] 开头时」这个条件**：绑定会话同时也是你在 DSH 界面里聊天的那个会话，',
            '去掉条件后模型在 DSH 里也会输出 `[[split]]`，而那里没人解析它。',
          ),
          h('div', { style: styles.hint },
            '默认内容的作用：告诉模型可以按聊天节奏把一条回复拆成多个气泡。',
            '清空后回复会变成一整条长消息；模型不知道 `[[split]]` 约定时，可能把它当普通文字打出来。',
          ),
        ),

        h('hr', { style: { border: 'none', borderTop: '1px solid var(--dsw-alias-border, #e5e7eb)', margin: '6px 0' } }),

        h('div', { style: styles.actions },
          h('button', { type: 'submit', style: styles.button, disabled: busy }, busy ? '保存中…' : '保存全部配置'),
          h('button', {
            type: 'button',
            style: styles.button,
            disabled: busy || !defaults,
            onClick: () => {
              if (!defaults) return
              const canConfirm = typeof window !== 'undefined' && typeof window.confirm === 'function'
              if (
                canConfirm &&
                !window.confirm(
                  '把所有参数恢复为出厂默认吗？\n\n' +
                    '这会同时重置：\n' +
                    '· 总开关（恢复为关闭）\n' +
                    '· 绑定会话（清空）\n' +
                    '· 聚合参数（静默 6 秒 / 窗口 15 秒 / 攒满 10 条）\n' +
                    '· **注入的提示词**（恢复为默认分段约定）\n\n' +
                    '点「保存全部配置」后才会真正生效。',
                )
              ) {
                return
              }
              setConfig(defaults)
              flashStatus('已填入出厂默认值（含注入的提示词），点「保存全部配置」生效。')
            },
          }, '填入默认值'),
          status ? h('span', { style: styles.status }, status) : null,
        ),
        h('div', { style: styles.hint },
          '「填入默认值」会**同时把注入的提示词恢复为默认**；只想重置提示词的话，用上面那个「恢复默认提示词」。'),
        errors._ ? h('div', { style: styles.error }, String(errors._)) : null,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' } },
          h('input', {
            id: 'pod-send-endpoint',
            type: 'checkbox',
            checked: config.sendFileEndpoint === true,
            disabled: busy,
            onChange: (event) => setField('sendFileEndpoint', event.target.checked),
          }),
          h('label', { htmlFor: 'pod-send-endpoint', style: styles.label }, '开放发文件端点（HTTP）'),
        ),
        h('div', { style: styles.hint },
          '正常情况下 agent 用工具 `pod_send_file` 发文件，不需要这个开关。',
          '但**工具的可见性在会话创建时就固定了**——插件装好之后新建的会话才有它，',
          '已经存在的会话（包括桥接绑定的那个）看不到也调不到。'),
        h('div', { style: styles.hint },
          '勾上后可以用 HTTP 发文件：`POST /api/dsh-podbridge/send-file`，',
          'body 是 `{"path":"绝对路径","caption":"可选"}`。它和工具共用同一份白名单与大小上限。'),
        h('div', { style: styles.error },
          '注意：这个端点**没有鉴权**（和其它管理端点一样，靠「只监听 127.0.0.1」），',
          '而且挂在 DSH 的 web 端口上、不是桥接的 8787。**不要把 web 端口暴露到公网**——',
          '开着它等于允许任何能访问该端口的人把白名单内的文件推到你手机上。用完建议关掉。'),


        h('div', { style: styles.row },
          h('label', { style: styles.label }, '配对 Pod App'),
          h('div', { style: styles.actions },
            h('button', { type: 'button', style: styles.button, disabled: busy, onClick: makeCode }, '生成配对码'),
            code ? h('span', { style: styles.code }, code.code) : null,
          ),
          code
            ? h('div', { style: styles.hint },
                `有效的 ${Math.max(0, Math.round((code.expiresAt - Date.now()) / 1000))} 秒内，在 App 里输入这个 6 位码完成配对。`)
            : h('div', { style: styles.hint }, '配对码一次性有效，5 分钟过期。'),
        ),

        h('div', { style: styles.row },
          h('label', { style: styles.label }, '已配对设备'),
          devices.length === 0
            ? h('div', { style: styles.hint }, '还没有设备配对。')
            : h('div', { style: styles.deviceList },
                ...devices.map((device) =>
                  h('div', { key: device.id, style: styles.deviceRow },
                    h('div', { style: styles.deviceMain },
                      h('div', { style: styles.deviceName },
                        device.deviceName || '未命名设备',
                        h('span', { style: styles.deviceId }, ` · ${device.id}`)),
                      h('div', { style: styles.hint },
                        `配对于 ${formatTime(device.createdAt)}`,
                        device.lastSeenAt ? ` · 最近使用 ${formatTime(device.lastSeenAt)}` : ''),
                    ),
                    h('button', {
                      type: 'button',
                      style: styles.button,
                      disabled: busy,
                      onClick: () => void revokeOne(device),
                    }, '移除'),
                  ),
                ),
              ),
          h('div', { style: styles.hint },
            '「移除」只踢掉这一台设备，其它设备不受影响；它会立刻断开，需要重新配对。'),
        ),

        h('div', { style: styles.row },
          h('label', { style: styles.label }, '状态'),
          h('div', { style: styles.info },
            `服务：${runtime?.listening ? `运行中（端口 ${runtime.port}）` : '未运行'}`,
            h('br'),
            `在线客户端：${runtime?.clients ?? 0}　·　已配对设备：${runtime?.tokens ?? 0}　·　最新 seq：${runtime?.lastSeq ?? 0}`,
            h('br'),
            `归档会话（已从选择器排除）：${runtime?.anyArchived ?? 0} 个`),
          h('div', { style: styles.actions },
            h('button', { type: 'button', style: styles.button, disabled: busy, onClick: () => void loadAll() }, '刷新状态'),
            h('button', { type: 'button', style: styles.button, disabled: busy, onClick: revoke }, '吊销全部客户端'),
          ),
          h('div', { style: styles.hint },
            '「吊销全部客户端」删除服务端的**全部**凭证并断开所有设备，每台都要重新配对；',
            '只想让某一台退出，用上面那行的「移除」——那只吊销它，其它设备无感。',
          ),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          if (!ctx.slots || typeof ctx.slots.inject !== 'function') return
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: 'podbridge', order: 8, label: 'Pod 桥接' },
              BridgeSettingsSafe,
            ),
          )
        } catch (err) {
          // fail-soft：单个分组的异常不能影响整个设置页
          console.error('[dsh-podbridge] settings section registration failed', err)
        }
      },
    }
  },
})
