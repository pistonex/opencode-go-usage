/** @jsxImportSource @opentui/solid */
import { createMemo, createResource, createSignal, onCleanup, Show, type Resource } from "solid-js"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Plugin, usePlugin } from "@opencode/plugin/tui"

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage"
const REFRESH_MS = 5 * 60 * 1000
const FETCH_TIMEOUT_MS = 10 * 1000
const BAR_WIDTH = 8
const MAX_ERROR_LEN = 80

type Language = "es" | "en"

type Strings = {
  subscription: string
  rolling: string
  weekly: string
  monthly: string
  loading: string
  unavailable: string
  noData: string
  noKey: string
  offline: string
  timeout: string
  unexpected: string
  toggleTitle: string
  languageTitle: string
}

const STRINGS: Record<Language, Strings> = {
  es: {
    subscription: "suscripción",
    rolling: "rolling",
    weekly: "semanal",
    monthly: "mensual",
    loading: "cargando…",
    unavailable: "uso no disponible",
    noData: "sin datos",
    noKey: "opencode-go no disponible",
    offline: "sin conexión",
    timeout: "tiempo de espera agotado",
    unexpected: "respuesta inesperada",
    toggleTitle: "Mostrar u ocultar el panel de uso de OpenCode Go",
    languageTitle: "Cambiar idioma ES/EN del plugin OpenCode Go",
  },
  en: {
    subscription: "subscription",
    rolling: "rolling",
    weekly: "weekly",
    monthly: "monthly",
    loading: "loading…",
    unavailable: "usage unavailable",
    noData: "no data",
    noKey: "opencode-go unavailable",
    offline: "no connection",
    timeout: "request timed out",
    unexpected: "unexpected response",
    toggleTitle: "Show or hide the OpenCode Go usage panel",
    languageTitle: "Switch ES/EN language of the OpenCode Go plugin",
  },
}

// Idioma: la opción del plugin (vía context.options) tiene prioridad, luego el
// estado reactivo (persistido en ~/.config/opencode/opencode-go-usage.json al
// cambiarlo por slash) y como fallback la autodetección del entorno (LANG).
function configFile(): string {
  return path.join(os.homedir(), ".config", "opencode", "opencode-go-usage.json")
}

function isLanguage(value: unknown): value is Language {
  return value === "es" || value === "en"
}

function detectLang(): Language {
  const env = process.env.LC_ALL ?? process.env.LC_MESSAGES ?? process.env.LANG ?? ""
  return env.toLowerCase().startsWith("es") ? "es" : "en"
}

function readLangFromConfig(): Language | null {
  try {
    const raw = JSON.parse(fs.readFileSync(configFile(), "utf8")) as { language?: string }
    return isLanguage(raw.language) ? raw.language : null
  } catch {
    return null
  }
}

function langFromOptions(options: Readonly<Record<string, unknown>> | undefined): Language | null {
  return isLanguage(options?.language) ? options.language : null
}

// Estado reactivo del idioma, para que el widget se actualice en caliente.
const [lang, setLang] = createSignal<Language>(readLangFromConfig() ?? detectLang())

function persistLang(l: Language): void {
  try {
    fs.writeFileSync(configFile(), JSON.stringify({ language: l }, null, 2) + "\n")
  } catch {
    // no fatal: el cambio se mantiene en sesión
  }
}

function toggleLang(): void {
  setLang((prev) => {
    const next: Language = prev === "es" ? "en" : "es"
    persistLang(next)
    return next
  })
}

function setLangPersist(l: Language): void {
  setLang(l)
  persistLang(l)
}

function useStrings(): Strings {
  const ctx = usePlugin()
  return STRINGS[langFromOptions(ctx.options) ?? lang()]
}

type UsageItem = {
  status: "ok" | "rate-limited"
  percent: number
  resetsAt: string
}

type Usage = {
  rolling: UsageItem
  weekly: UsageItem
  monthly: UsageItem
}

type UsageResult = { ok: true; usage: Usage } | { ok: false; error: string }

function accountFile(): string {
  return path.join(os.homedir(), ".local", "share", "opencode", "account.json")
}

function readGoApiKey(): string | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(accountFile(), "utf8")) as {
      accounts?: Record<string, { serviceID?: string; credential?: { type?: string; key?: string } }>
    }
    for (const account of Object.values(raw.accounts ?? {})) {
      if (
        account?.serviceID === "opencode-go" &&
        account?.credential?.type === "api" &&
        typeof account.credential.key === "string"
      ) {
        return account.credential.key
      }
    }
  } catch {
  }
  return undefined
}

// El mensaje de error lo controla el servidor remoto: se muestra en la TUI
// solo tras eliminar caracteres de control y truncar la longitud.
function sanitize(message: string): string {
  return message
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, MAX_ERROR_LEN)
}

async function fetchUsage(t: Strings): Promise<UsageResult> {
  const key = readGoApiKey()
  if (!key) {
    return { ok: false, error: t.noKey }
  }
  let res: Response
  try {
    res = await fetch(USAGE_URL, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      return { ok: false, error: t.timeout }
    }
    return { ok: false, error: t.offline }
  }
  const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
  if (!res.ok) {
    const message = sanitize(json?.error?.message ?? "")
    return { ok: false, error: `HTTP ${res.status}${message ? ` ${message}` : ""}` }
  }
  const usage = (json as { usage?: Usage } | null)?.usage
  if (!usage?.rolling || !usage?.weekly || !usage?.monthly) {
    return { ok: false, error: t.unexpected }
  }
  return { ok: true, usage }
}

function bar(percent: number): string {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * BAR_WIDTH)
  return "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled)
}

function resetIn(resetsAt: string): string {
  const minutes = Math.round((new Date(resetsAt).getTime() - Date.now()) / 60000)
  if (!Number.isFinite(minutes)) return "—"
  if (minutes < 60) return `${Math.max(0, minutes)}m`
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`
  return `${Math.round(minutes / 1440)}d`
}

function statusGlyph(status: UsageItem["status"]): string {
  return status === "rate-limited" ? "✕" : "✓"
}

type Row = { labelKey: keyof Pick<Strings, "rolling" | "weekly" | "monthly">; item: UsageItem }

const ROWS: Array<(usage: Usage) => Row> = [
  (u) => ({ labelKey: "rolling", item: u.rolling }),
  (u) => ({ labelKey: "weekly", item: u.weekly }),
  (u) => ({ labelKey: "monthly", item: u.monthly }),
]

// El fetcher usa el estado de colapso como fuente del recurso: mientras el
// widget está colapsado no se hace ninguna petición y al expandirlo se
// refresca de inmediato (cambio de fuente).
function useUsage(t: Strings, collapsed: { value: boolean }): Resource<UsageResult> {
  const [usage, { refetch }] = createResource<UsageResult, string>(
    () => (collapsed.value ? "collapsed" : "visible"),
    async (state) => {
      if (state === "collapsed") return { ok: false, error: "" }
      return fetchUsage(t)
    },
  )
  const timer = setInterval(() => {
    if (!collapsed.value) refetch()
  }, REFRESH_MS)
  onCleanup(() => clearInterval(timer))
  return usage
}

function UsageView(props: { sessionID: string; collapsed: { value: boolean } }) {
  const context = usePlugin()
  const theme = () => context.theme
  const t = useStrings()
  const usage = useUsage(t, props.collapsed)

  const rows = createMemo(() => {
    const value = usage()
    return value?.ok ? ROWS.map((fn) => fn(value.usage)) : []
  })
  const loading = createMemo(() => usage() === undefined)
  const errorText = createMemo(() => {
    const value = usage()
    return value !== undefined && !value.ok && value.error ? value.error : undefined
  })

  return (
    <box
      flexDirection="column"
      gap={1}
      backgroundColor={theme().background.surface.overlay}
      border
      borderColor={theme().border.default}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
    >
      <box flexDirection="row" gap={1} justifyContent="space-between">
        <text fg={theme().text.default}>
          <b>⬖ OpenCode Go</b>
        </text>
        <text fg={theme().text.subdued}>
          {t.subscription} {props.collapsed.value ? "▸" : "▾"}
        </text>
      </box>

      <Show when={!props.collapsed.value}>
        <Show
          when={usage()?.ok}
          fallback={
            <box flexDirection="column" gap={1}>
              <text fg={theme().text.subdued}>
                <span style={{ fg: theme().text.feedback.warning.default }}>⬖</span> {t.unavailable}
              </text>
              <Show when={loading()}>
                <text fg={theme().text.subdued}>{t.loading}</text>
              </Show>
              <Show when={errorText()} keyed>
                {(message: string) => <text fg={theme().text.feedback.error.default}>{message}</text>}
              </Show>
            </box>
          }
        >
          <Show when={rows().length > 0}>
            <box flexDirection="column" gap={1}>
              {rows().map((row) => {
                const p = row.item.percent
                const color =
                  row.item.status === "rate-limited"
                    ? theme().text.feedback.error.default
                    : theme().text.feedback.success.default
                const label = Number.isInteger(p) ? String(p) : String(p.toFixed(1))
                return (
                  <box flexDirection="row" gap={1}>
                    <text flexShrink={0} width={9} fg={theme().text.subdued}>
                      {t[row.labelKey]}
                    </text>
                    <text flexShrink={0} fg={color}>
                      {bar(p)}
                    </text>
                    <text flexShrink={0} fg={color}>
                      {label}%
                    </text>
                    <text flexShrink={0} fg={color}>
                      {statusGlyph(row.item.status)}
                    </text>
                    <text flexShrink={0} fg={theme().text.subdued}>
                      ↻ {resetIn(row.item.resetsAt)}
                    </text>
                  </box>
                )
              })}
            </box>
          </Show>

          <Show when={rows().length === 0 && usage()?.ok}>
            <text fg={theme().text.subdued}>{t.noData}</text>
          </Show>
        </Show>
      </Show>
    </box>
  )
}

export default Plugin.define({
  id: "opencode-go-usage",
  setup(context) {
    const [collapsed, setCollapsed] = context.storage.store("ui", {
      initial: { value: false },
    })

    const toggle = () => {
      setCollapsed((d) => {
        d.value = !d.value
      })
    }

    const resolveLang = () => langFromOptions(context.options) ?? lang()
    const strings = () => STRINGS[resolveLang()]

    // Los keymaps solo pueden registrarse dentro de un componente que se
    // renderiza (bajo el Keymap.Provider); por eso la capa se registra en la
    // contribución del slot "app" (patrón de la doc) y no en setup.
    const unregs = [
      context.ui.slot({
        append: "sidebar.content",
        render: ({ sessionID }) => <UsageView sessionID={sessionID} collapsed={collapsed} />,
      }),
      context.ui.slot({
        append: "app",
        render: () => {
          context.keymap.layer(() => ({
            mode: "global",
            commands: [
              {
                id: "opencode-go-usage.toggle",
                title: strings().toggleTitle,
                group: "OpenCode Go",
                palette: true,
                slash: { name: "opencode-go" },
                run: toggle,
              },
              {
                id: "opencode-go-usage.language",
                title: strings().languageTitle,
                group: "OpenCode Go",
                palette: true,
                slash: { name: "opencode-go-lang", arguments: true },
                run: (input) => {
                  const a = (input ?? "").trim().toLowerCase()
                  if (a === "en" || a === "es") setLangPersist(a)
                  else toggleLang()
                },
              },
            ],
          }))
          return null
        },
      }),
    ]

    return () => {
      unregs.forEach((unreg) => unreg())
    }
  },
})
