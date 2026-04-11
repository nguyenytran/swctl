import { ref } from 'vue'
import type { Project, ProjectConfig } from '@/types'
import { fetchProjects, fetchConfig, addProject, removeProject, discoverPlugins } from '@/api'

const projects = ref<Project[]>([])
const config = ref<ProjectConfig>({})

export function useProjects() {
  async function refresh() {
    const [p, c] = await Promise.all([fetchProjects(), fetchConfig()])
    projects.value = p
    config.value = c
  }

  async function add(data: { name: string; path: string; type: string; parent?: string; pluginDir?: string }) {
    const res = await addProject(data)
    if (res.ok) await refresh()
    return res
  }

  async function remove(name: string) {
    const res = await removeProject(name)
    if (res.ok) await refresh()
    return res
  }

  async function discover() {
    const res = await discoverPlugins()
    if (res.ok) projects.value = res.projects
    return res
  }

  return { projects, config, refresh, add, remove, discover }
}
