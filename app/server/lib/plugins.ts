import fs from 'fs'
import os from 'os'
import path from 'path'

export interface PluginManifest {
  id: string
  name: string
  version: string
  entry: string
  description?: string
  author?: string
}

/**
 * Returns the list of plugin root directories. `SWCTL_PLUGINS_DIR` accepts
 * a single path or a colon-separated list (`PATH` convention). Each listed
 * directory is scanned for plugin subdirectories; when the same plugin id
 * appears in multiple roots, the first one wins.
 *
 * Default when unset: `~/.swctl/plugins`.
 */
export function pluginsRoots(): string[] {
  const raw = process.env.SWCTL_PLUGINS_DIR
  if (!raw) return [path.join(os.homedir(), '.swctl', 'plugins')]
  return raw.split(':').map((s) => s.trim()).filter(Boolean)
}

/**
 * Back-compat: returns the first plugin root. New code should use
 * `pluginsRoots()`.
 */
export function pluginsRoot(): string {
  return pluginsRoots()[0]
}

/**
 * Scan all plugin root directories and return the manifests of valid plugins.
 * A valid plugin is a subdirectory containing:
 *   - swctl-plugin.json (with id, name, version, entry)
 *   - the entry file (must exist on disk)
 *
 * When the same plugin id is present in multiple roots, the first root
 * (earliest in `SWCTL_PLUGINS_DIR`) wins. A warning is logged for shadows.
 */
export function listPlugins(): PluginManifest[] {
  const roots = pluginsRoots()
  const seen = new Map<string, PluginManifest>()

  for (const root of roots) {
    if (!fs.existsSync(root)) continue

    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = path.join(root, entry.name)
      const manifestPath = path.join(dir, 'swctl-plugin.json')
      if (!fs.existsSync(manifestPath)) continue

      let raw: string
      try { raw = fs.readFileSync(manifestPath, 'utf-8') } catch { continue }

      let parsed: any
      try { parsed = JSON.parse(raw) } catch {
        console.warn(`[plugins] invalid JSON in ${manifestPath}`)
        continue
      }

      const { id, name, version, entry: entryFile, description, author } = parsed
      if (typeof id !== 'string' || !id) {
        console.warn(`[plugins] ${manifestPath}: missing/invalid "id"`)
        continue
      }
      if (typeof entryFile !== 'string' || !entryFile) {
        console.warn(`[plugins] ${manifestPath}: missing "entry"`)
        continue
      }

      // Ensure entry file exists and is inside the plugin dir (prevent traversal)
      const entryAbs = path.resolve(dir, entryFile)
      if (!entryAbs.startsWith(dir + path.sep)) {
        console.warn(`[plugins] ${id}: entry "${entryFile}" escapes plugin directory`)
        continue
      }
      if (!fs.existsSync(entryAbs)) {
        console.warn(`[plugins] ${id}: entry file not found: ${entryAbs}`)
        continue
      }

      // id must match directory name to keep URL resolution simple & safe
      if (id !== entry.name) {
        console.warn(`[plugins] directory "${entry.name}" contains plugin id "${id}" (mismatch; skipping)`)
        continue
      }

      if (seen.has(id)) {
        console.warn(`[plugins] "${id}" found in ${dir} is shadowed by an earlier root; ignoring`)
        continue
      }

      seen.set(id, {
        id,
        name: typeof name === 'string' && name ? name : id,
        version: typeof version === 'string' && version ? version : '0.0.0',
        entry: entryFile,
        description: typeof description === 'string' ? description : undefined,
        author: typeof author === 'string' ? author : undefined,
      })
    }
  }

  const plugins = Array.from(seen.values())
  plugins.sort((a, b) => a.id.localeCompare(b.id))
  return plugins
}

/**
 * Resolve a file path inside a plugin directory, searching each plugin root
 * in order. Returns the first match, or null if the plugin/file doesn't
 * exist in any root or the requested file escapes its plugin directory.
 */
export function resolvePluginFile(pluginId: string, file: string): string | null {
  // Strip leading slashes from the file parameter
  const cleanFile = file.replace(/^\/+/, '')
  if (!cleanFile) return null

  // Reject plugin IDs that are anything other than a safe slug
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(pluginId)) return null

  for (const root of pluginsRoots()) {
    const dir = path.join(root, pluginId)
    const abs = path.resolve(dir, cleanFile)

    // Ensure resolved path is inside the plugin directory
    if (!abs.startsWith(dir + path.sep) && abs !== dir) continue
    if (!fs.existsSync(abs)) continue
    if (!fs.statSync(abs).isFile()) continue

    return abs
  }

  return null
}

/**
 * Best-effort content-type resolution for plugin assets.
 */
export function mimeForFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  switch (ext) {
    case '.js':   return 'application/javascript; charset=utf-8'
    case '.mjs':  return 'application/javascript; charset=utf-8'
    case '.css':  return 'text/css; charset=utf-8'
    case '.json': return 'application/json; charset=utf-8'
    case '.html': return 'text/html; charset=utf-8'
    case '.svg':  return 'image/svg+xml'
    case '.png':  return 'image/png'
    case '.jpg':  return 'image/jpeg'
    case '.jpeg': return 'image/jpeg'
    case '.gif':  return 'image/gif'
    case '.webp': return 'image/webp'
    case '.ico':  return 'image/x-icon'
    case '.woff': return 'font/woff'
    case '.woff2':return 'font/woff2'
    case '.ttf':  return 'font/ttf'
    case '.map':  return 'application/json; charset=utf-8'
    default:      return 'application/octet-stream'
  }
}
