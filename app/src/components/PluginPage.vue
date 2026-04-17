<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { usePlugins } from '@/composables/usePlugins'
import PluginSlot from './PluginSlot.vue'

const route = useRoute()
const { findRoute } = usePlugins()

const pluginMeta = computed(() => route.meta?.plugin as { id: string; path: string } | undefined)
const entry = computed(() => {
  const meta = pluginMeta.value
  if (!meta) return undefined
  return findRoute(meta.id, meta.path)
})
</script>

<template>
  <div class="p-6">
    <div v-if="entry" class="space-y-3">
      <h1 class="text-xl font-semibold text-white flex items-center gap-2">
        <span v-if="entry.icon">{{ entry.icon }}</span>
        {{ entry.label }}
      </h1>
      <PluginSlot :render="entry.render" :key="route.fullPath" />
    </div>
    <div v-else class="text-sm text-gray-500">
      Plugin route not found.
    </div>
  </div>
</template>
