import { Plugin } from "@opencode/plugin"

// Plugin principal (rol servidor). Toda la funcionalidad vive en la parte
// TUI (export "./tui"); este entrypoint existe para satisfacer el contrato
// de carga del servidor de opencode v2.
export default Plugin.define({
  id: "opencode-go-usage.server",
  setup() {},
})
