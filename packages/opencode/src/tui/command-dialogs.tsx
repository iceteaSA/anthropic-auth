/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from '@opencode-ai/plugin/tui'
import type { OpenDialogPayload } from '../rpc/protocol.js'

type ApplyFn = (
  command: OpenDialogPayload['command'],
  args: string,
) => Promise<{ text: string; knobs: Record<string, unknown> }>

function showText(api: TuiPluginApi, text: string) {
  api.ui.dialog.setSize('xlarge')
  api.ui.dialog.replace(() => (
    <box flexDirection='column' padding={1} width='100%'>
      <text>{text}</text>
    </box>
  ))
}

export function openCommandDialog(
  api: TuiPluginApi,
  payload: OpenDialogPayload,
  apply: ApplyFn,
) {
  if (payload.command === 'claude-routing') {
    const current = (payload.knobs.mode as string) ?? 'main-first'
    const DialogSelect = api.ui.DialogSelect<string>
    api.ui.dialog.setSize('xlarge')
    api.ui.dialog.replace(() => (
      <DialogSelect
        title='Claude routing'
        current={current}
        options={[
          {
            title: 'Main first',
            value: 'main-first',
            description: 'Use the main account until exhausted',
          },
          {
            title: 'Fallback first',
            value: 'fallback-first',
            description: 'Prefer fallback accounts, preserve main',
          },
        ]}
        onSelect={(option) => {
          void apply('claude-routing', String(option.value)).then((r) => {
            api.ui.toast({ message: r.text })
            api.ui.dialog.clear()
          })
        }}
      />
    ))
    return
  }

  if (payload.command === 'claude-fast' || payload.command === 'claude-dump') {
    const enabled = payload.knobs.enabled === true
    const label =
      payload.command === 'claude-fast' ? 'fast mode' : 'request dump'
    const DialogConfirm = api.ui.DialogConfirm
    api.ui.dialog.setSize('xlarge')
    api.ui.dialog.replace(() => (
      <DialogConfirm
        title={`Claude ${label}`}
        message={`${payload.text}\n\n${enabled ? 'Disable' : 'Enable'} ${label}?`}
        onConfirm={() => {
          void apply(payload.command, enabled ? 'off' : 'on').then((r) => {
            api.ui.toast({ message: r.text })
            api.ui.dialog.clear()
          })
        }}
        onCancel={() => api.ui.dialog.clear()}
      />
    ))
    return
  }

  if (payload.command === 'claude-cache') {
    const enabled = payload.knobs.enabled === true
    const mode = (payload.knobs.mode as string) ?? 'hybrid'
    const currentValue = enabled ? mode : 'off'
    const DialogSelect = api.ui.DialogSelect<string>
    api.ui.dialog.setSize('xlarge')
    api.ui.dialog.replace(() => (
      <DialogSelect
        title='Claude 1h cache'
        current={currentValue}
        options={[
          { title: 'Off', value: 'off', description: 'Disable 1h cache' },
          {
            title: 'Explicit',
            value: 'explicit',
            description: 'Existing OpenCode breakpoints',
          },
          {
            title: 'Automatic',
            value: 'automatic',
            description: 'Top-level cache_control only',
          },
          {
            title: 'Hybrid',
            value: 'hybrid',
            description: 'system + messages[0] + top-level',
          },
        ]}
        onSelect={(option) => {
          if (option.value === 'off') {
            void apply('claude-cache', 'off').then((r) => {
              api.ui.toast({ message: r.text })
              api.ui.dialog.clear()
            })
            return
          }
          void apply('claude-cache', `mode ${option.value}`)
            .then(() => apply('claude-cache', 'on'))
            .then((r) => {
              api.ui.toast({ message: r.text })
              api.ui.dialog.clear()
            })
        }}
      />
    ))
    return
  }

  if (payload.command === 'claude-cachekeep') {
    const window = payload.knobs.window as
      | { startHour: number; endHour: number }
      | undefined
    const seed = window
      ? `${String(window.startHour).padStart(2, '0')}-${String(window.endHour).padStart(2, '0')}`
      : ''
    const DialogPrompt = api.ui.DialogPrompt
    api.ui.dialog.setSize('xlarge')
    api.ui.dialog.replace(() => (
      <DialogPrompt
        title='Claude cachekeep window'
        description={() => <text>{payload.text}</text>}
        placeholder="HH-HH (e.g. 08-20) or 'off'"
        value={seed}
        onConfirm={(value: string) => {
          void apply('claude-cachekeep', value.trim()).then((r) => {
            api.ui.toast({ message: r.text })
            api.ui.dialog.clear()
          })
        }}
        onCancel={() => api.ui.dialog.clear()}
      />
    ))
    return
  }

  if (payload.command === 'claude-killswitch') {
    const config = (payload.knobs.config ?? {}) as {
      enabled?: boolean
      main?: Record<string, number>
      accounts?: Record<string, Record<string, number>>
    }
    const accountIds = (payload.knobs.accountIds as string[]) ?? []
    const enabled = config.enabled === true
    const readT = (t: Record<string, number> | undefined) => {
      const fh = t?.five_hour ?? t?.['5h'] ?? 5
      const sd = t?.seven_day ?? t?.['1w'] ?? 10
      return { fh, sd }
    }
    const mainT = readT(config.main)
    const seedParts = [`main:${mainT.fh},${mainT.sd}`]
    for (const id of accountIds) {
      const t = readT(config.accounts?.[id] ?? config.main)
      seedParts.push(`${id}:${t.fh},${t.sd}`)
    }
    const seed = seedParts.join(' ')

    const openEdit = () => {
      const DialogPrompt = api.ui.DialogPrompt
      api.ui.dialog.setSize('xlarge')
      api.ui.dialog.replace(() => (
        <DialogPrompt
          title='Killswitch thresholds'
          description={() => <text>{payload.text}</text>}
          placeholder='main:5,10 work-alt:5,10'
          value={seed}
          onConfirm={(value: string) => {
            void apply('claude-killswitch', `set ${value.trim()}`).then((r) => {
              api.ui.toast({ message: r.text })
              api.ui.dialog.clear()
            })
          }}
          onCancel={() => api.ui.dialog.clear()}
        />
      ))
    }

    const DialogSelect = api.ui.DialogSelect<string>
    api.ui.dialog.setSize('xlarge')
    api.ui.dialog.replace(() => (
      <DialogSelect
        title='Claude killswitch'
        options={[
          {
            title: enabled ? 'Disable killswitch' : 'Enable killswitch',
            value: enabled ? 'off' : 'on',
            description: enabled
              ? 'Stop hard-blocking on low quota'
              : 'Hard-block requests when quota drops below thresholds',
          },
          {
            title: 'Edit thresholds…',
            value: 'edit',
            description: 'Set per-account 5h,1w cutoffs',
          },
        ]}
        onSelect={(option) => {
          if (option.value === 'edit') {
            openEdit()
            return
          }
          void apply('claude-killswitch', String(option.value)).then((r) => {
            api.ui.toast({ message: r.text })
            api.ui.dialog.clear()
          })
        }}
      />
    ))
    return
  }

  if (payload.command === 'claude-account') {
    const accounts =
      (payload.knobs.accounts as Array<{
        id: string
        label: string
        role: string
        enabled: boolean
        quotaPercent: number | null
      }>) ?? []

    const buildL1 = () => {
      const DialogSelect = api.ui.DialogSelect<string>
      api.ui.dialog.setSize('xlarge')
      api.ui.dialog.replace(() => (
        <DialogSelect
          title='Claude accounts'
          options={accounts.map((a) => {
            const pct =
              a.quotaPercent != null
                ? ` ${Math.round(a.quotaPercent)}%`
                : ' \u2013%'
            const status = !a.enabled ? ' (disabled)' : ''
            return {
              title: `${a.label} [${a.role}]${status}${pct}`,
              value: a.id,
            }
          })}
          onSelect={(option) => {
            const account = accounts.find((a) => a.id === option.value)
            if (!account) return
            if (account.role === 'main') {
              openManage(account, true)
              return
            }
            openManage(account, false)
          }}
        />
      ))
    }

    const openManage = (
      account: (typeof accounts)[number],
      isMain: boolean,
    ) => {
      const DialogSelect = api.ui.DialogSelect<string>
      const DialogConfirm = api.ui.DialogConfirm
      api.ui.dialog.setSize('xlarge')

      const options: Array<{
        title: string
        value: string
        description?: string
      }> = []
      if (!isMain) {
        const toggleLabel = account.enabled ? 'Disable' : 'Enable'
        options.push({
          title: toggleLabel,
          value: account.enabled ? 'disable' : 'enable',
          description: account.enabled
            ? 'Stop using this fallback account'
            : 'Allow this fallback account to be used',
        })
        options.push({
          title: 'Move up',
          value: 'move-up',
          description: 'Higher priority in fallback order',
        })
        options.push({
          title: 'Move down',
          value: 'move-down',
          description: 'Lower priority in fallback order',
        })
        options.push({
          title: 'Remove\u2026',
          value: 'remove',
          description: 'Delete this account permanently',
        })
      }
      options.push({ title: 'Back', value: 'back' })

      api.ui.dialog.replace(() => (
        <DialogSelect
          title={`Manage ${account.label}`}
          options={options}
          onSelect={(option) => {
            if (option.value === 'back') {
              buildL1()
              return
            }

            if (option.value === 'remove') {
              api.ui.dialog.replace(() => (
                <DialogConfirm
                  title={`Remove ${account.label}?`}
                  message={`Are you sure you want to remove the fallback account "${account.label}"?`}
                  onConfirm={() => {
                    void apply('claude-account', `remove ${account.id}`).then(
                      (r) => {
                        const updated = r.knobs.accounts as typeof accounts
                        api.ui.toast({ message: r.text })
                        if (updated && updated.length > 0) {
                          accounts.length = 0
                          accounts.push(...updated)
                        }
                        buildL1()
                      },
                    )
                  }}
                  onCancel={() => openManage(account, isMain)}
                />
              ))
              return
            }

            void apply('claude-account', `${option.value} ${account.id}`).then(
              (r) => {
                const updated = r.knobs.accounts as typeof accounts
                api.ui.toast({ message: r.text })
                if (updated && updated.length > 0) {
                  accounts.length = 0
                  accounts.push(...updated)
                  openManage(
                    updated.find((a) => a.id === account.id) ?? account,
                    isMain,
                  )
                } else {
                  openManage(account, isMain)
                }
              },
            )
          }}
        />
      ))
    }

    buildL1()
    return
  }

  // fallback for quota (display-only)
  showText(api, payload.text)
}
