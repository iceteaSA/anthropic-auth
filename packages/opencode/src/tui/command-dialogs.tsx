/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from '@opencode-ai/plugin/tui'
import type { OpenDialogPayload } from '../rpc/protocol.js'

type ApplyFn = (
  command: OpenDialogPayload['command'],
  args: string,
) => Promise<{ text: string }>

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
        current={enabled ? 'on' : 'off'}
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

  // fallback for quota (display-only)
  showText(api, payload.text)
}
