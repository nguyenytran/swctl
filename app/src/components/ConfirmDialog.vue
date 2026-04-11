<script setup lang="ts">
defineProps<{
  title: string
  message: string
  onConfirm: () => void
}>()

const emit = defineEmits<{ cancel: [] }>()
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 bg-black/60 flex items-center justify-center z-50" @click.self="emit('cancel')">
      <div class="bg-surface border border-border rounded-lg w-full max-w-sm p-6 shadow-2xl">
        <h3 class="text-base font-bold text-white mb-2">{{ title }}</h3>
        <p class="text-sm text-gray-400 mb-5">{{ message }}</p>
        <div class="flex justify-end gap-3">
          <button
            class="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
            @click="emit('cancel')"
          >
            Cancel
          </button>
          <button
            class="px-4 py-2 bg-red-600 hover:bg-red-500 text-white text-sm rounded transition-colors"
            @click="onConfirm()"
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
