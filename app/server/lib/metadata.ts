import fs from 'fs'
import path from 'path'

const STATE_DIR = process.env.SWCTL_STATE_DIR || path.join(process.env.HOME || '/root', '.local/state/swctl')
const INSTANCES_DIR = path.join(STATE_DIR, 'instances')

export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx < 0) continue
    const key = trimmed.slice(0, eqIdx)
    let val = trimmed.slice(eqIdx + 1)
    if (val.startsWith("$'") && val.endsWith("'")) {
      val = val.slice(2, -1).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\'/g, "'").replace(/\\\\/g, '\\')
    } else if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
      val = val.slice(1, -1)
    }
    result[key] = val
  }
  return result
}

export function readAllInstances() {
  const instances: any[] = []
  if (!fs.existsSync(INSTANCES_DIR)) return instances

  for (const project of fs.readdirSync(INSTANCES_DIR)) {
    const projectDir = path.join(INSTANCES_DIR, project)
    if (!fs.statSync(projectDir).isDirectory()) continue
    for (const file of fs.readdirSync(projectDir)) {
      if (!file.endsWith('.env')) continue
      try {
        const content = fs.readFileSync(path.join(projectDir, file), 'utf8')
        const m = parseEnvFile(content)
        instances.push({
          issue: m.ISSUE || '',
          issueId: m.ISSUE_ID || file.replace('.env', ''),
          project: m.PROJECT || '',
          projectSlug: m.PROJECT_SLUG || project,
          branch: m.BRANCH || '',
          baseRef: m.BASE_REF || '',
          mode: m.SWCTL_MODE || 'dev',
          domain: m.DOMAIN || '',
          appUrl: m.APP_URL || '',
          worktreePath: m.WORKTREE_PATH || '',
          dbName: m.DB_NAME || '',
          dbState: m.DB_STATE || '',
          composeProject: m.COMPOSE_PROJECT || '',
          createdAt: m.CREATED_AT || '',
          projectType: m.PROJECT_TYPE || 'platform',
          pluginName: m.PLUGIN_NAME || '',
          linkedPlugins: m.LINKED_PLUGINS ? m.LINKED_PLUGINS.split(',').filter(Boolean) : [],
          platformWorktreePath: m.PLATFORM_WORKTREE_PATH || '',
          platformIssueId: m.PLATFORM_ISSUE_ID || '',
          status: m.STATUS || 'complete',
          failedAt: m.FAILED_AT || '',
          claudeSessionId: m.CLAUDE_SESSION_ID || '',
          claudeResolveStatus: m.CLAUDE_RESOLVE_STATUS || '',
          claudeResolveStep: m.CLAUDE_RESOLVE_STEP || '',
          claudeResolveCost: m.CLAUDE_RESOLVE_COST || '0',
          changes: {
            migration: parseInt(m.MIGRATION_CHANGES) || 0,
            entity: parseInt(m.ENTITY_CHANGES) || 0,
            admin: parseInt(m.ADMIN_CHANGES) || 0,
            storefront: parseInt(m.STOREFRONT_CHANGES) || 0,
            composer: parseInt(m.COMPOSER_CHANGES) || 0,
            package: parseInt(m.PACKAGE_CHANGES) || 0,
            backend: parseInt(m.BACKEND_CHANGES) || 0,
            frontend: parseInt(m.FRONTEND_CHANGES) || 0,
          },
        })
      } catch {
        // skip
      }
    }
  }
  return instances
}
