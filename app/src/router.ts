import { createRouter, createWebHashHistory } from 'vue-router'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/dashboard' },

    // Dashboard routes
    { path: '/dashboard', name: 'dashboard', component: () => import('@/components/Dashboard.vue') },
    { path: '/dashboard/batch-create', name: 'dashboard-batch-create', component: () => import('@/components/Dashboard.vue'), meta: { modal: 'batch-create' } },
    { path: '/dashboard/projects', name: 'dashboard-projects', component: () => import('@/components/Dashboard.vue'), meta: { modal: 'projects' } },
    { path: '/dashboard/instance/:issueId', name: 'dashboard-instance', component: () => import('@/components/Dashboard.vue'), meta: { modal: 'instance' } },

    // Worktrees routes
    { path: '/worktrees', name: 'worktrees', component: () => import('@/components/WorktreeOverview.vue') },
    { path: '/worktrees/batch-create', name: 'worktrees-batch-create', component: () => import('@/components/WorktreeOverview.vue'), meta: { modal: 'batch-create' } },
  ],
})

export default router
