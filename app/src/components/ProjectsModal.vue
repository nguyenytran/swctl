<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useProjects } from '@/composables/useProjects'
import { fetchDirectories, initProjectConfig, fetchWorkflows } from '@/api'
import type { Workflow } from '@/types'

const emit = defineEmits<{ close: [] }>()
const { projects, refresh, add, remove, discover } = useProjects()

const showBrowser = ref(false)
const discovering = ref(false)
const error = ref('')

// Directory browser state
const browseHome = ref('')
const browsePath = ref('')
const browseParent = ref('')
const browseDirs = ref<Array<{ name: string; path: string; hasSwctlConf: boolean; hasGit: boolean }>>([])
const browseHasConf = ref(false)
const browseHasGit = ref(false)
const browseProjectName = ref('')
const browseBaseBranch = ref('')
const browseIsRoot = ref(false)
const browseLoading = ref(false)
const projectNameInput = ref('')

// Init form state
const showInitForm = ref(false)
// Workflow state
const workflows = ref<Workflow[]>([])
const selectedWorkflow = ref('shopware6')

onMounted(async () => {
  try {
    workflows.value = await fetchWorkflows()
    if (workflows.value.length > 0 && !workflows.value.find(w => w.id === selectedWorkflow.value)) {
      selectedWorkflow.value = workflows.value[0].id
    }
  } catch {}
})

const initForm = ref({
  name: '',
  baseBranch: 'trunk',
  phpImage: 'ghcr.io/shopware/docker-dev:php8.4-node24-caddy',
  shareNetwork: '',
  dbHost: 'database',
  dbPort: '3306',
  dbRootUser: 'root',
  dbRootPassword: 'root',
  dbNamePrefix: '',
  dbSharedName: 'shopware',
})
const initLoading = ref(false)

async function openBrowser() {
  showBrowser.value = true
  showInitForm.value = false
  error.value = ''
  await navigate()
}

async function navigate(dirPath?: string) {
  browseLoading.value = true
  showInitForm.value = false
  try {
    const data = await fetchDirectories(dirPath)
    browsePath.value = data.current
    browseParent.value = data.parent
    browseDirs.value = data.dirs
    browseHasConf.value = data.hasSwctlConf
    browseHasGit.value = data.hasGit
    browseProjectName.value = data.projectName || ''
    browseBaseBranch.value = data.baseBranch || 'trunk'
    browseIsRoot.value = data.isRoot
    if (data.isRoot || !browseHome.value) {
      browseHome.value = data.current
    }
    if (data.projectName) {
      projectNameInput.value = data.projectName
    } else {
      projectNameInput.value = ''
    }
  } catch {
    error.value = 'Failed to browse directory'
  } finally {
    browseLoading.value = false
  }
}

function openInitForm() {
  const dirName = browsePath.value.split('/').pop() || 'project'
  // Pre-fill from existing project if available
  const existingProject = projects.value[0]
  initForm.value = {
    name: dirName,
    baseBranch: browseBaseBranch.value || 'trunk',
    phpImage: 'ghcr.io/shopware/docker-dev:php8.4-node24-caddy',
    shareNetwork: existingProject ? `${existingProject.path.split('/').pop()}_default` : `${dirName}_default`,
    dbHost: 'database',
    dbPort: '3306',
    dbRootUser: 'root',
    dbRootPassword: 'root',
    dbNamePrefix: dirName.toLowerCase().replace(/[^a-z0-9]/g, ''),
    dbSharedName: 'shopware',
  }
  showInitForm.value = true
  error.value = ''
}

async function handleInit() {
  error.value = ''
  initLoading.value = true
  try {
    const res = await initProjectConfig({
      path: browsePath.value,
      workflow: selectedWorkflow.value,
      ...initForm.value,
    })
    if (!res.ok) {
      error.value = res.error || 'Failed to initialize project'
    } else {
      showInitForm.value = false
      showBrowser.value = false
      await refresh()
    }
  } catch {
    error.value = 'Failed to initialize project'
  } finally {
    initLoading.value = false
  }
}

async function selectDirectory() {
  error.value = ''
  const name = projectNameInput.value.trim() || browsePath.value.split('/').pop() || 'project'
  const res = await add({
    name,
    path: browsePath.value,
    type: 'platform',
  })
  if (!res.ok) {
    error.value = res.error || 'Failed to add project'
  } else {
    showBrowser.value = false
    browsePath.value = ''
    projectNameInput.value = ''
  }
}

async function handleRemove(name: string) {
  await remove(name)
}

async function handleDiscover() {
  discovering.value = true
  await discover()
  discovering.value = false
}

function typeColor(type: string) {
  if (type === 'platform') return 'text-blue-400'
  if (type === 'plugin-embedded') return 'text-purple-400'
  return 'text-emerald-400'
}

function pathSegments(p: string) {
  const home = browseHome.value
  if (!home || !p.startsWith(home)) return []
  const relative = p.slice(home.length).replace(/^\//, '')
  if (!relative) return []
  const parts = relative.split('/').filter(Boolean)
  return parts.map((name, i) => ({
    name,
    path: home + '/' + parts.slice(0, i + 1).join('/'),
  }))
}
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 bg-black/60 flex items-center justify-center z-50" @click.self="emit('close')">
      <div class="bg-surface border border-border rounded-lg w-full max-w-2xl p-6 shadow-2xl">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-lg font-bold text-white">Projects</h2>
          <div class="flex gap-2">
            <button
              class="text-xs px-3 py-1.5 bg-surface-hover text-gray-300 rounded border border-border hover:text-white transition-colors"
              :disabled="discovering"
              @click="handleDiscover"
            >
              {{ discovering ? 'Scanning...' : 'Auto-discover' }}
            </button>
            <button
              class="text-xs px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors"
              @click="showBrowser ? (showBrowser = false, showInitForm = false) : openBrowser()"
            >
              {{ showBrowser ? 'Cancel' : '+ Add' }}
            </button>
          </div>
        </div>

        <!-- Directory browser -->
        <div v-if="showBrowser" class="mb-4 bg-surface-dark rounded border border-border overflow-hidden">
          <!-- Current path breadcrumbs -->
          <div class="px-3 py-2 border-b border-border flex items-center gap-1 text-xs overflow-x-auto">
            <span class="text-gray-500 shrink-0">~</span>
            <template v-for="(seg, i) in pathSegments(browsePath)" :key="seg.path">
              <span class="text-gray-600 shrink-0">/</span>
              <button
                class="shrink-0 transition-colors"
                :class="i === pathSegments(browsePath).length - 1 ? 'text-white font-medium' : 'text-gray-400 hover:text-white'"
                @click="navigate(seg.path)"
              >{{ seg.name }}</button>
            </template>
            <span v-if="browseLoading" class="text-gray-600 ml-2">...</span>
          </div>

          <!-- Action bar: existing swctl project -->
          <div v-if="browseHasConf" class="px-3 py-2 border-b border-emerald-600/30 bg-emerald-600/10 flex items-center justify-between gap-3">
            <div class="flex items-center gap-2 min-w-0">
              <span class="text-emerald-400 text-xs shrink-0">swctl project found</span>
              <input
                v-model="projectNameInput"
                class="bg-surface border border-border rounded px-2 py-1 text-xs text-white w-32 focus:outline-none focus:border-blue-500"
                placeholder="Project name"
              />
            </div>
            <button
              class="px-3 py-1 text-xs bg-emerald-600 hover:bg-emerald-500 text-white rounded shrink-0 transition-colors"
              @click="selectDirectory"
            >Add this project</button>
          </div>

          <!-- Action bar: git repo without swctl config -->
          <div v-else-if="browseHasGit && !showInitForm" class="px-3 py-2 border-b border-blue-600/30 bg-blue-600/10 flex items-center justify-between gap-3">
            <span class="text-blue-400 text-xs">Git repository — no swctl config</span>
            <button
              class="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded shrink-0 transition-colors"
              @click="openInitForm"
            >Initialize project</button>
          </div>

          <!-- Init form -->
          <div v-if="showInitForm" class="px-3 py-3 border-b border-blue-600/30 bg-blue-600/5 space-y-3">
            <div class="text-xs text-blue-400 font-medium">Initialize swctl project</div>
            <div v-if="workflows.length > 0">
              <label class="block text-xs text-gray-500 mb-0.5">Workflow</label>
              <select
                v-model="selectedWorkflow"
                class="w-full bg-surface border border-border rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
              >
                <option v-for="wf in workflows" :key="wf.id" :value="wf.id">
                  {{ wf.name }}{{ wf.description ? ` — ${wf.description}` : '' }}
                </option>
              </select>
            </div>
            <div class="grid grid-cols-2 gap-2">
              <div>
                <label class="block text-xs text-gray-500 mb-0.5">Project name</label>
                <input v-model="initForm.name" class="w-full bg-surface border border-border rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500" />
              </div>
              <div>
                <label class="block text-xs text-gray-500 mb-0.5">Base branch</label>
                <input v-model="initForm.baseBranch" class="w-full bg-surface border border-border rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500" />
              </div>
            </div>
            <div>
              <label class="block text-xs text-gray-500 mb-0.5">PHP Image</label>
              <input v-model="initForm.phpImage" class="w-full bg-surface border border-border rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500" />
            </div>
            <div class="grid grid-cols-2 gap-2">
              <div>
                <label class="block text-xs text-gray-500 mb-0.5">Docker network</label>
                <input v-model="initForm.shareNetwork" class="w-full bg-surface border border-border rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500" />
              </div>
              <div>
                <label class="block text-xs text-gray-500 mb-0.5">DB host</label>
                <input v-model="initForm.dbHost" class="w-full bg-surface border border-border rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500" />
              </div>
            </div>
            <div class="grid grid-cols-3 gap-2">
              <div>
                <label class="block text-xs text-gray-500 mb-0.5">DB user</label>
                <input v-model="initForm.dbRootUser" class="w-full bg-surface border border-border rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500" />
              </div>
              <div>
                <label class="block text-xs text-gray-500 mb-0.5">DB password</label>
                <input v-model="initForm.dbRootPassword" type="password" class="w-full bg-surface border border-border rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500" />
              </div>
              <div>
                <label class="block text-xs text-gray-500 mb-0.5">DB prefix</label>
                <input v-model="initForm.dbNamePrefix" class="w-full bg-surface border border-border rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500" />
              </div>
            </div>
            <div class="flex justify-end gap-2">
              <button
                class="px-3 py-1 text-xs text-gray-400 hover:text-white transition-colors"
                @click="showInitForm = false"
              >Cancel</button>
              <button
                class="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors"
                :disabled="initLoading || !initForm.name.trim()"
                @click="handleInit"
              >{{ initLoading ? 'Creating...' : 'Create config & register' }}</button>
            </div>
          </div>

          <!-- Directory listing -->
          <div class="max-h-56 overflow-y-auto">
            <button
              v-if="!browseIsRoot"
              class="w-full text-left px-3 py-1.5 text-sm text-gray-400 hover:bg-surface-hover hover:text-white transition-colors flex items-center gap-2"
              @click="navigate(browseParent)"
            >
              <span class="text-gray-600">..</span>
            </button>
            <button
              v-for="dir in browseDirs"
              :key="dir.path"
              class="w-full text-left px-3 py-1.5 text-sm hover:bg-surface-hover transition-colors flex items-center gap-2"
              :class="dir.hasSwctlConf ? 'text-emerald-400' : dir.hasGit ? 'text-blue-400' : 'text-gray-300'"
              @click="navigate(dir.path)"
            >
              <span class="text-xs opacity-60">{{ dir.hasSwctlConf ? '&#9679;' : '&#9702;' }}</span>
              <span>{{ dir.name }}</span>
              <span v-if="dir.hasSwctlConf" class="text-xs text-emerald-600 ml-auto">swctl</span>
              <span v-else-if="dir.hasGit" class="text-xs text-gray-600 ml-auto">git</span>
            </button>
            <p v-if="!browseDirs.length && !browseLoading" class="text-xs text-gray-600 text-center py-3">No subdirectories</p>
          </div>

          <p v-if="error" class="px-3 py-2 text-xs text-red-400 border-t border-border">{{ error }}</p>
        </div>

        <!-- Project list -->
        <div class="space-y-1 max-h-72 overflow-y-auto">
          <div
            v-for="p in projects"
            :key="p.name"
            class="flex items-center justify-between px-3 py-2.5 rounded hover:bg-surface-hover transition-colors group"
          >
            <div class="min-w-0">
              <span class="text-sm text-white font-medium">{{ p.name }}</span>
              <span class="ml-2 text-xs" :class="typeColor(p.type)">{{ p.type }}</span>
              <p class="text-xs text-gray-500 mt-0.5 truncate">{{ p.path }}</p>
            </div>
            <button
              class="text-xs text-red-400 opacity-0 group-hover:opacity-100 hover:text-red-300 transition-all shrink-0 ml-3"
              @click="handleRemove(p.name)"
            >
              Remove
            </button>
          </div>
          <p v-if="!projects.length" class="text-sm text-gray-500 text-center py-4">No projects registered.</p>
        </div>

        <div class="flex justify-end mt-4">
          <button class="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors" @click="emit('close')">Close</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
