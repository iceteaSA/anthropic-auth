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
    api.ui.dialog.setSize('large')
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
    api.ui.dialog.setSize('large')
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

  // fallback for quota, cache, cachekeep, killswitch (interactive versions land later)
  showText(api, payload.text)
}
