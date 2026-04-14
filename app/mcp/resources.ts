const API_BASE = process.env.SWCTL_UI_URL || `http://localhost:${process.env.SWCTL_UI_PORT || '3000'}`

type ResourceContent = { uri: string; mimeType: string; text: string }

async function apiGet(path: string): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`)
  return res.json()
}

export async function readConfig(): Promise<ResourceContent> {
  const config = await apiGet('/api/config')
  return {
    uri: 'swctl://config',
    mimeType: 'application/json',
    text: JSON.stringify(config, null, 2),
  }
}

export async function readInstanceDetail(issueId: string): Promise<ResourceContent | null> {
  const items = await apiGet('/api/instances')
  const inst = (items as any[]).find((i: any) => i.issueId === issueId && i.kind !== 'external')
  if (!inst) return null
  return {
    uri: `swctl://instance/${issueId}`,
    mimeType: 'application/json',
    text: JSON.stringify(inst, null, 2),
  }
}

export async function readProjectsList(): Promise<ResourceContent> {
  const projects = await apiGet('/api/projects')
  return {
    uri: 'swctl://projects',
    mimeType: 'application/json',
    text: JSON.stringify(projects, null, 2),
  }
}

export async function listInstanceUris(): Promise<Array<{ uri: string; name: string; description: string; mimeType: string }>> {
  const items = await apiGet('/api/instances')
  return (items as any[])
    .filter((i: any) => i.kind !== 'external')
    .map((i: any) => ({
      uri: `swctl://instance/${i.issueId}`,
      name: `Instance #${i.issueId}`,
      description: `${i.branch} (${i.project || i.projectSlug}, ${i.mode})`,
      mimeType: 'application/json',
    }))
}
