import { ref, computed, watch } from 'vue'
import { useProjects } from './useProjects'

const STORAGE_KEY = 'swctl-active-project'
const activeProjectName = ref<string>(localStorage.getItem(STORAGE_KEY) || '')

export function useActiveProject() {
  const { projects } = useProjects()

  const activeProject = computed(() =>
    projects.value.find(p => p.name === activeProjectName.value) || null
  )

  // Auto-select first platform project if none set or current is invalid
  function ensureSelection() {
    // Empty string = "All projects" — valid if explicitly stored
    if (activeProjectName.value === '' && localStorage.getItem(STORAGE_KEY) !== null) return
    if (activeProjectName.value && projects.value.some(p => p.name === activeProjectName.value)) return
    const first = projects.value.find(p => p.type === 'platform') || projects.value[0]
    if (first) {
      activeProjectName.value = first.name
    }
  }

  function setProject(name: string) {
    activeProjectName.value = name
    localStorage.setItem(STORAGE_KEY, name)
  }

  watch(activeProjectName, (v) => localStorage.setItem(STORAGE_KEY, v))

  return { activeProjectName, activeProject, setProject, ensureSelection, projects }
}
