<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useProjects } from '@/composables/useProjects'
import { buildCreateUrl, fetchPlugins } from '@/api'
import type { useStream as UseStream } from '@/composables/useStream'
import BranchSelect from './BranchSelect.vue'

const props = defineProps<{ stream: ReturnType<typeof UseStream> }>()
const emit = defineEmits<{ close: []; created: [] }>()

const { projects, config } = useProjects()

const issue = ref('')
const branch = ref('')
const mode = ref<'dev' | 'qa'>('dev')
const selectedProject = ref('')
const selectedPlugin = ref('')
const availablePlugins = ref<string[]>([])

const platformProjects = computed(() => projects.value.filter(p => p.type === 'platform'))

const canSubmit = computed(() => issue.value.trim().length > 0 && selectedProject.value !== '')

// Load available plugins when project changes
watch(selectedProject, async (proj) => {
  selectedPlugin.value = ''
  availablePlugins.value = []
  if (!proj) return
  try {
    availablePlugins.value = await fetchPlugins(proj)
  } catch {
    availablePlugins.value = []
  }
})

function submit() {
  if (!canSubmit.value) return
  const url = buildCreateUrl({
    issue: issue.value.trim(),
    mode: mode.value,
    branch: branch.value.trim() || undefined,
    project: selectedProject.value || undefined,
    plugin: selectedPlugin.value || undefined,
  })
  props.stream.start(url)
  emit('created')
}
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 bg-black/60 flex items-center justify-center z-50" @click.self="emit('close')">
      <div class="bg-surface border border-border rounded-lg w-full max-w-2xl p-6 shadow-2xl">
        <h2 class="text-lg font-bold text-white mb-4">Create Worktree</h2>

        <form @submit.prevent="submit" class="space-y-4">
          <div>
            <label class="block text-xs text-gray-400 mb-1">Issue / Ticket ID *</label>
            <input
              v-model="issue"
              class="w-full bg-surface-dark border border-border rounded px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
              placeholder="NEXT-12345"
              autofocus
            />
          </div>

          <div class="flex gap-4">
            <div class="flex-1">
              <label class="block text-xs text-gray-400 mb-1">Project *</label>
              <select
                v-model="selectedProject"
                class="w-full bg-surface-dark border border-border rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
              >
                <option value="" disabled>Select a project</option>
                <option v-for="p in platformProjects" :key="p.name" :value="p.name">
                  {{ p.name }}
                </option>
              </select>
            </div>

            <div class="flex-1">
              <label class="block text-xs text-gray-400 mb-1">Plugin (optional)</label>
              <select
                v-model="selectedPlugin"
                :disabled="!availablePlugins.length"
                class="w-full bg-surface-dark border border-border rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors disabled:opacity-40"
              >
                <option value="">{{ availablePlugins.length ? 'Platform only' : 'No plugins found' }}</option>
                <option v-for="p in availablePlugins" :key="p" :value="p">{{ p }}</option>
              </select>
            </div>
          </div>

          <div>
            <label class="block text-xs text-gray-400 mb-1">
              Branch
              <span v-if="mode === 'dev'" class="text-gray-600">
                (defaults to feature/{{ issue.trim() || 'issue' }})
              </span>
            </label>
            <BranchSelect v-model="branch" :project="selectedProject" :plugin="selectedPlugin" />
          </div>

          <div>
            <label class="block text-xs text-gray-400 mb-1">Mode</label>
            <select
              v-model="mode"
              class="w-full bg-surface-dark border border-border rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
            >
              <option value="dev">Dev</option>
              <option value="qa">QA</option>
            </select>
          </div>

          <div class="flex justify-end gap-3 pt-2">
            <button
              type="button"
              class="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
              @click="emit('close')"
            >
              Cancel
            </button>
            <button
              type="submit"
              :disabled="!canSubmit"
              class="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm rounded transition-colors"
            >
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  </Teleport>
</template>
