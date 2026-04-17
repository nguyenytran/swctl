# swctl UI Plugins

swctl's web UI is extensible via local plugins. A plugin is a folder
containing a manifest (`swctl-plugin.json`) and an ESM entry, placed in any
directory listed in `SWCTL_PLUGINS_DIR`. Plugins can add:

- **Tabs** in the instance detail view
- **Actions** on each worktree row
- **Widgets** on the dashboard
- **Routes** in the top-nav (full-page views)

## Plugin roots

`SWCTL_PLUGINS_DIR` is a **colon-separated list** of directories (same
convention as `PATH`). swctl scans every listed directory and aggregates
all valid plugins.

**Default when `swctl ui start` is run from the repo:**
```
$HOME/.swctl/plugins : $SWCTL_SCRIPT_DIR/examples/plugins
```

The **first** path in the list wins if the same plugin id exists in
multiple roots — so a personal copy in `~/.swctl/plugins/` always overrides
the bundled one in the repo. Shadowed duplicates are logged on the server
at startup.

### Paths must live under `$HOME`

The swctl-ui container bind-mounts `$HOME` read-write, which covers both
default paths. If you point `SWCTL_PLUGINS_DIR` at a directory outside
`$HOME`, add a matching volume to `docker-compose.ui.yml` yourself.

## Directory layout

```
<plugin-root>/hello/
├── swctl-plugin.json      # manifest
└── index.js               # ESM module — default export = plugin object
```

The directory name **must match** the `id` in the manifest.

## Manifest (`swctl-plugin.json`)

```json
{
  "id": "hello",
  "name": "Hello World",
  "version": "1.0.0",
  "entry": "index.js",
  "description": "Reference plugin",
  "author": "you"
}
```

Required: `id`, `entry`. The rest are informational.

## Entry file (`index.js`)

Any native ESM module. Default-export an object matching the shape below.
Use plain DOM APIs, or bring your own framework — swctl imposes nothing.

```js
export default {
  id: 'hello',
  tabs: [ /* PluginTab[] */ ],
  actions: [ /* PluginAction[] */ ],
  widgets: [ /* PluginWidget[] */ ],
  routes: [ /* PluginRoute[] */ ],
}
```

### Tabs

Appear in `InstanceDetail` alongside Logs / Console / Diff / Info.

```ts
interface PluginTab {
  id: string
  label: string
  icon?: string
  render: (container: HTMLElement, ctx: PluginContext) => (() => void) | void
  condition?: (instance: Instance) => boolean  // show tab only when truthy
}
```

### Actions

Buttons added to each instance row's action column.

```ts
interface PluginAction {
  id: string
  label: string
  scope: 'instance'                              // MVP supports 'instance' only
  icon?: string
  handler: (ctx: PluginContext) => void | Promise<void>
  condition?: (instance: Instance) => boolean
}
```

### Widgets

Panels rendered on the Dashboard at named locations:

- `dashboard-sidebar` — grid above the instance list
- `dashboard-bottom` — stack below the instance list

```ts
interface PluginWidget {
  id: string
  location: 'dashboard-sidebar' | 'dashboard-bottom'
  title?: string
  render: (container: HTMLElement, ctx: PluginContext) => (() => void) | void
}
```

### Routes

Full-page views added to the top nav.

```ts
interface PluginRoute {
  path: string           // leading slash optional; "/hello" or "hello"
  label: string
  icon?: string
  render: (container: HTMLElement, ctx: PluginContext) => (() => void) | void
}
```

## Context (`ctx`)

Passed to every render/handler:

```ts
interface PluginContext {
  instance?: Instance               // present for tabs & instance-scoped actions
  api: {
    exec(issueId, cmd): Promise<{ ok, output, exitCode }>
    fetch(path, init?): Promise<any>     // GET /api/... by default
    startInstance(id): Promise<any>
    stopInstance(id): Promise<any>
    restartInstance(id): Promise<any>
    refreshInstances(): Promise<void>
  }
  events: {
    on(event, handler): () => void       // subscribe to swctl events; returns unsubscribe
  }
  ui: {
    toast(msg, kind?): void
    confirm(msg): Promise<boolean>
  }
  instances: Ref<Instance[]>             // reactive list, shared with the app
  activeProject: Ref<string | null>      // currently-selected project name
}
```

## Render contract

`render(container, ctx)` may return a **cleanup function**. swctl invokes it
when the slot unmounts (tab switch, modal close, route change), so you can
cancel timers, streams, and listeners.

```js
render: (el, ctx) => {
  const timer = setInterval(() => { el.textContent = new Date().toISOString() }, 1000)
  return () => clearInterval(timer)
}
```

## Server-side

The swctl UI server:
- `GET /api/plugins/list` — returns all manifests found in the plugins root
- `GET /api/plugins/:id/:path` — serves static files from a plugin directory

Override the plugin roots with `SWCTL_PLUGINS_DIR=/path/a:/path/b` (colon-separated).

## Security

**Plugins run as trusted code** in the main browser context — they have full
DOM access, cookies, and API access. Only install plugins from sources you trust.
swctl does not sandbox plugins; they are code you chose to run locally.

## Example

See [`examples/plugins/hello/`](../examples/plugins/hello/) for a minimal
working plugin that exercises all four extension points.

When you run `swctl ui start` from the repo, `examples/plugins/` is
automatically on the plugin search path — no copy needed. Just reload the
UI.

If you'd rather install the example for your user (so it stays available
when running an installed swctl CLI, not the repo one):
```bash
mkdir -p ~/.swctl/plugins
cp -r examples/plugins/hello ~/.swctl/plugins/
```
