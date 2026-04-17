import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import { usePlugins } from '@/composables/usePlugins'
import './style.css'

async function bootstrap() {
  // Load plugins before mounting so their routes are registered and navigable
  try {
    await usePlugins().init(router)
  } catch (err) {
    console.warn('[swctl] plugin init failed:', err)
  }
  createApp(App).use(router).mount('#app')
}

bootstrap()
