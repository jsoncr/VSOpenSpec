# OpenSpec Previewer

Extensión de VSCode para previsualizar y navegar proyectos [OpenSpec](https://openspec.dev/) sin abrir los `.md` a mano.

## Características

- **Sidebar dedicado** (ícono OpenSpec en la barra de actividad) con un árbol navegable:
  - **Cambios activos** → cada cambio muestra su progreso de tareas (`8/10 · 80%`).
    - Artefactos: Propuesta, Diseño, Tareas y spec deltas.
  - **Specs activas** (por capacidad).
  - **Archivados** (cambios completados).
- **Preview renderizado** de cualquier `.md` con estilo integrado al tema (light/dark).
- **Tareas interactivas**: marca/desmarca checkboxes desde el árbol o desde el preview
  y se reescribe el `tasks.md` real.
- **Auto-refresco** al cambiar archivos dentro de `openspec/`.
- Soporta **monorepos**: detecta varias carpetas `openspec/` en el workspace.
- **Acciones por cambio** (botones inline):
  - ▶ **Ejecutar tareas pendientes**: aparece cuando el cambio tiene tareas sin
    completar. Abre la terminal integrada en la carpeta del proyecto y escribe el
    comando del agente configurado (por defecto Claude Code). Por seguridad **no se
    ejecuta**: revisas y pulsas Enter.
  - 📦 **Archivar cambio**: aparece cuando todas las tareas están completas (o no hay
    tareas). Pide confirmación y ejecuta `openspec archive`.

### Configuración

| Setting | Por defecto | Descripción |
|---|---|---|
| `openspec.applyCommand` | `claude "/openspec:apply ${changeId}"` | Comando del agente para aplicar tareas. Variables: `${changeId}`, `${cwd}`. |
| `openspec.archiveCommand` | `openspec archive ${changeId} -y` | Comando para archivar. Variables: `${changeId}`, `${cwd}`. |
| `openspec.autoRunApply` | `false` | Si es `true`, el comando de aplicar se ejecuta al instante en vez de solo escribirse. |

## Estructura OpenSpec que reconoce

```
openspec/
├── config.yaml
├── specs/<capability>/spec.md
└── changes/
    ├── <change-id>/
    │   ├── proposal.md
    │   ├── design.md
    │   ├── tasks.md
    │   └── specs/<cap>/spec.md
    └── archive/
```

## Desarrollo

```bash
npm install
npm run compile      # build único
npm run watch        # build en modo watch
```

Pulsa `F5` en VSCode para abrir una ventana de desarrollo con la extensión cargada.

## Empaquetar

```bash
npm run package
npx @vscode/vsce package   # genera el .vsix instalable
```
