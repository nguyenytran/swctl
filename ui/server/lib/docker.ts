import http from 'http'

interface ContainerStatus {
  state: string
  status: string
  id: string
}

export function getContainerStatuses(): Promise<Record<string, ContainerStatus>> {
  return new Promise((resolve) => {
    const filter = JSON.stringify({ label: ['swctl.managed=true'] })
    const reqPath = `/containers/json?all=true&filters=${encodeURIComponent(filter)}`

    const req = http.request({ socketPath: '/var/run/docker.sock', path: reqPath, method: 'GET' }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try {
          const containers = JSON.parse(data)
          const map: Record<string, ContainerStatus> = {}
          for (const c of containers) {
            const project = c.Labels?.['com.docker.compose.project'] || ''
            map[project] = {
              state: c.State || 'unknown',
              status: c.Status || '',
              id: c.Id?.slice(0, 12) || '',
            }
          }
          resolve(map)
        } catch {
          resolve({})
        }
      })
    })
    req.on('error', () => resolve({}))
    req.end()
  })
}
