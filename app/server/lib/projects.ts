import fs from 'fs'
import path from 'path'

const STATE_DIR = process.env.SWCTL_STATE_DIR || path.join(process.env.HOME || '/root', '.local/state/swctl')
const PROJECTS_FILE = path.join(STATE_DIR, 'projects.conf')

export interface Project {
  name: string
  type: string
  path: string
  parent: string | null
  pluginDir: string | null
  workflow: string | null
}

export function readProjects(): Project[] {
  if (!fs.existsSync(PROJECTS_FILE)) return []
  const content = fs.readFileSync(PROJECTS_FILE, 'utf8')
  return content
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('#'))
    .map((line) => {
      const parts = line.split('\t')
      const [name, type, projPath, parent, pluginDir] = parts
      const workflow = parts[5] || '-'
      return {
        name,
        type,
        path: projPath,
        parent: parent === '-' ? null : parent,
        pluginDir: pluginDir === '-' ? null : pluginDir,
        workflow: workflow === '-' ? null : workflow,
      }
    })
    .filter((p) => p.name)
}

export function addProjectEntry(entry: {
  name: string
  type: string
  path: string
  parent?: string
  pluginDir?: string
  workflow?: string
}): { ok: boolean; error?: string } {
  const projects = readProjects()
  if (projects.some((p) => p.name === entry.name)) {
    return { ok: false, error: `Project '${entry.name}' already registered.` }
  }
  if (!entry.name || !entry.path || !entry.type) {
    return { ok: false, error: 'Name, path, and type are required.' }
  }
  if (!entry.path.startsWith('/')) {
    return { ok: false, error: 'Path must be absolute.' }
  }
  const validTypes = ['platform', 'plugin-embedded', 'plugin-external']
  if (!validTypes.includes(entry.type)) {
    return { ok: false, error: `Invalid type: ${entry.type}` }
  }
  if (entry.type !== 'platform' && !entry.parent) {
    return { ok: false, error: 'Plugin projects require a parent.' }
  }
  const line = [
    entry.name,
    entry.type,
    entry.path,
    entry.parent || '-',
    entry.pluginDir || '-',
    entry.workflow || '-',
  ].join('\t')
  fs.appendFileSync(PROJECTS_FILE, line + '\n')
  return { ok: true }
}

export function removeProjectEntry(name: string): { ok: boolean; error?: string } {
  if (!fs.existsSync(PROJECTS_FILE)) return { ok: false, error: 'No projects file.' }
  const lines = fs.readFileSync(PROJECTS_FILE, 'utf8').split('\n')
  const filtered = lines.filter((l) => !l.startsWith(name + '\t'))
  if (filtered.length === lines.length) {
    return { ok: false, error: `Project '${name}' not found.` }
  }
  fs.writeFileSync(PROJECTS_FILE, filtered.join('\n'))
  return { ok: true }
}

export function readProjectConfig(): Record<string, string> {
  const PROJECT_ROOT = process.env.PROJECT_ROOT || '/project'
  const confPath = path.join(PROJECT_ROOT, '.swctl.conf')
  if (!fs.existsSync(confPath)) return {}
  const result: Record<string, string> = {}
  for (const line of fs.readFileSync(confPath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx < 0) continue
    const key = trimmed.slice(0, eqIdx)
    let val = trimmed.slice(eqIdx + 1).replace(/^["']|["']$/g, '')
    result[key] = val
  }
  return result
}
