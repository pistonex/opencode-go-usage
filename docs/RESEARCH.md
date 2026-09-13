# Investigación — saldo y límites de OpenCode Go en el sidebar

Objetivo original: mostrar en el panel izquierdo de opencode (a) el **saldo
activo** cargado en la cuenta y (b) si está habilitado **usar el saldo**
después de alcanzar los límites de la suscripción ("Use balance").

**Decisión (confirmada con el usuario):** el saldo y el toggle no están en
ninguna API pública; el plugin muestra el **uso de la suscripción** con datos
reales y actúa como recordatorio del estado "use balance". No se hace scraping
del console.

## Hallazgos verificados

### Entorno

- opencode instalado: `v1.18.30` en `~/.opencode/bin/opencode`
- Config global: `~/.config/opencode/` (`opencode.json`, `plugins/`)
- Cuentas (`~/.local/share/opencode/account.json`):
  ```json
  { "version": 2,
    "accounts": {
      "<id>.f23b03315001LWNXT9SNbNSg8r": { "serviceID": "opencode",
        "credential": { "type": "api", "key": "sk-…" } },
      "<id>.f23b03315002d0ezJEZqTb7jZg": { "serviceID": "opencode-go",
        "credential": { "type": "api", "key": "sk-…" } }
    },
    "active": { "opencode": "…", "opencode-go": "…" } }
  ```
  Ambas cuentas comparten la misma API key.
- Source del release clonado en `/tmp/opencode-src` (tag `v1.18.30`).

### Feature: OpenCode Go + Zen balance

- **Go** = suscripción $10/mes con límites de uso (`rolling`, semanal,
  mensual). Docs: `packages/web/src/content/docs/go.mdx` y `zen.mdx`.
- **"Use balance"**: toggle en el console. Cuando el límite de Go se agota,
  si está activo, las peticiones se cobran contra el **saldo Zen** en vez de
  devolver 429. Solo visible/editable en `https://opencode.ai/auth`.
- De ser contestado, el código de facturación vive en
  `packages/console/core/src/schema/billing.sql.ts` (`BillingTable`).
  - `balance` — bigint, **micro-céntimos** (USD = `balance / 1e8`;
    `formatBalance` en `routes/workspace/common.tsx`)
  - `lite.useBalance?: boolean` — el toggle "Use balance" de Go.

### Endpoint público (único con datos de suscripción)

`GET https://opencode.ai/zen/go/v1/usage` — `Authorization: Bearer <key>`
(key de la cuenta `opencode-go`).

Implementación: `routes/zen/go/v1/usage.ts`. Devuelve `{ usage: { rolling,
weekly, monthly } }` donde cada uno es:

```json
{ "status": "ok" | "rate-limited", "percent": 0–100,
  "resetsAt": "ISO fecha de reset" }
```

**Respuesta real en producción (13/09/2026):**

```json
{ "usage": {
    "rolling": { "status": "ok", "percent": 0, "resetsAt": "…" },
    "weekly":  { "status": "ok", "percent": 4, "resetsAt": "…" },
    "monthly": { "status": "rate-limited", "percent": 100,
                 "resetsAt": "2026-09-23T03:44:20.699Z" } } }
```

- Con una key inválida → `401 { type: "error", error: { type: "AuthError" } }`
- Sin suscripción Go → `403 EntitlementError "Subscription required"`
- **No** expone balance ni useBalance.

### Qué N0 expone balance/useBalance

Grep exhaustivo de endpoints que leen `authorization` en el source:
`routes/zen/v1/{models,responses,chat/completions}`,
`routes/zen/go/v1/{usage,responses,chat/completions}` y
`routes/api/support/actions/*`. Los datos de saldo se leen solo en server
actions del webapp con sesión de navegador (`validateUser`), p. ej.
`queryBillingInfo` y `queryLiteSubscription` vía `_server/query/billing.*`.

Conclusión: **no hay API key pública que devuelva balance ni `useBalance`**.
Para mostrarlos habría que simular la sesión web del console (frágil, se
descartó) o que opencode publique el dato.

### API de plugins TUI (v1.18.30)

- Tipos: `@opencode-ai/plugin/dist/tui.d.ts` y
  `packages/plugin/src/tui.ts`.
- Módulo de plugin: `{ id?, tui, server? }` (export default).
  `TuiPlugin = (api, options, meta) => Promise<void>`.
- Slots: `api.slots.register({ order, slots: { sidebar_content(ctx, props) {
  return <JSX/> } } })` → devuelve `() => void` (dispose).
- Slots de sesión: `sidebar_title`, `sidebar_content` (multi-plugin, dentro
  del scroll), `sidebar_footer` (`single_winner`, interno con `order: 100`).
- Ejemplos reales:
  - `packages/tui/src/feature-plugins/sidebar/footer.tsx`
  - `packages/tui/src/plugin/slots.tsx` (registro)
  - `.opencode/plugins/tui-smoke.tsx` del repo (contrato completo de plugin
    TUI externo: JSX `@opentui/solid`, `{ id, tui }`)
- Plano del sidebar: `packages/tui/src/routes/session/sidebar.tsx`
  (ancho 42; `sidebar_content` en línea 85, `sidebar_footer` líneas 90–98).

## Arquitectura del plugin

`src/opencode-go-usage.tsx`:

1. `readGoApiKey()` → lee `account.json`, cuenta `serviceID === "opencode-go"`.
2. `fetchUsage(signal)` → `GET /zen/go/v1/usage` con Bearer. Normaliza a
   `{ ok: true, usage } | { ok: false, error }`. Nunca loguea la key.
3. `useUsage(api)` → `createResource` + `setInterval(REFRESH_MS)` (refetch),
   abort señalado con `api.lifecycle.signal`, limpieza con `onCleanup`.
4. `UsageView` → renders en `sidebar_content` (order 500): cabecera,
   3 barras (color éxito/error según estado), bloque de aviso si algún límite
   está `rate-limited` con enlace al console.

## Trabajo futuro

- Si opencode publica un endpoint de balance/`useBalance`, añadir al mismo
  slot una línea "saldo: $X · use balance: sí/no".
- Conectarse a `api.event.on("session.idle")` para refrescar al volver a
  inactivo (menos peticiones).
- Localizar el host TUI externo (`TuiPluginHost.start` en
  `packages/tui/src/app.tsx`) para confirmar el exacto glob de carga
  (`*.tsx` vs `*.ts`) y poder aportar también el build `.js`.