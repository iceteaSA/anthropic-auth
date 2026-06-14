/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from '@opencode-ai/plugin/tui'
import type { OpenDialogPayload } from '../rpc/protocol.js'

export function openCommandDialog(
  api: TuiPluginApi,
  payload: OpenDialogPayload,
) {
  api.ui.dialog.replace(() => (
    <box flexDirection='column' padding={1}>
      <text>{payload.text}</text>
    </box>
  ))
}
