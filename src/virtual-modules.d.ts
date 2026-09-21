/**
 * Declaraciones de tipo para los módulos virtuales del host de OpenCode.
 *
 * En runtime, la TUI de OpenCode registra módulos virtuales
 * (`opentui:runtime-module:*`) que apuntan a SUS propias instancias de
 * solid-js, @opentui/solid y @opencode/plugin/tui. El plugin los importa vía
 * esos ids virtuales para que, instalado como paquete npm (dentro de un
 * node_modules), todo el código corra sobre la MISMA instancia reactiva del
 * host. Bun resuelve los bare specifiers de archivos dentro de node_modules
 * contra las copias locales (nunca contra el host), lo que duplicaría el
 * runtime de Solid y congelaría la UI.
 *
 * Estas declaraciones solo existen para el typecheck: reexportan los tipos de
 * los paquetes reales (dependencies/devDependencies del repo).
 */
declare module "opentui:runtime-module:solid-js" {
  export * from "solid-js"
}

declare module "opentui:runtime-module:%40opencode%2Fplugin%2Ftui" {
  export * from "@opencode/plugin/tui"
}

declare module "opentui:runtime-module:%40opentui%2Fsolid%2Fjsx-runtime" {
  export * from "@opentui/solid/jsx-runtime"
}
