import fs from 'fs'
import path from 'path'

export interface Workflow {
  id: string
  name: string
  description: string
}

export function listWorkflows(): Workflow[] {
  return scanWorkflowDirs()
}

function defaultWorkflows(): Workflow[] {
  return [{ id: 'shopware6', name: 'shopware6', description: 'Shopware 6 platform development' }]
}

function scanWorkflowDirs(): Workflow[] {
  const workflows: Workflow[] = []
  const seen = new Set<string>()

  const swctlPath = process.env.SWCTL_PATH || '/swctl/swctl'
  const templateDir = process.env.SWCTL_TEMPLATE_DIR || path.dirname(swctlPath)

  // Scan bundled workflows/ and ~/.config/swctl/workflows/
  const dirs = [
    path.join(templateDir, 'workflows'),
    path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '/root', '.config'), 'swctl', 'workflows'),
  ]

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || seen.has(entry.name)) continue
      const yamlPath = path.join(dir, entry.name, 'workflow.yaml')
      if (!fs.existsSync(yamlPath)) continue
      seen.add(entry.name)

      // Parse name/description from YAML (simple regex, no yaml dep needed)
      const content = fs.readFileSync(yamlPath, 'utf-8')
      const nameMatch = content.match(/^name:\s*(.+)$/m)
      const descMatch = content.match(/^description:\s*(.+)$/m)
      workflows.push({
        id: entry.name,
        name: nameMatch?.[1]?.replace(/^["']|["']$/g, '') || entry.name,
        description: descMatch?.[1]?.replace(/^["']|["']$/g, '') || '',
      })
    }
  }

  return workflows.length > 0 ? workflows : defaultWorkflows()
}
