#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

import {
  listInstances,
  createWorktree,
  smartCreate,
  viewDiff,
  execCommand,
  startStop,
  clean,
  refresh,
  githubIssues,
} from './tools.js'

import {
  readConfig,
  readInstanceDetail,
  readProjectsList,
  listInstanceUris,
} from './resources.js'

const server = new Server(
  { name: 'swctl', version: '0.3.3' },
  { capabilities: { tools: {}, resources: {} } },
)

// --- Tools ---

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'swctl_list_instances',
      description: 'List all managed worktree instances with their status, branch, domain, mode, and change summary.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project: { type: 'string', description: 'Filter by project name (optional)' },
        },
      },
    },
    {
      name: 'swctl_create_worktree',
      description: 'Create a new worktree instance for an issue or PR. Provisions the environment, installs deps, and starts the container.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          issue: { type: 'string', description: 'Issue number or identifier (e.g. "15847")' },
          branch: { type: 'string', description: 'Git branch name (auto-detected if omitted)' },
          project: { type: 'string', description: 'Project name (uses default if omitted)' },
          mode: { type: 'string', enum: ['qa', 'dev'], description: 'Mode: "qa" (read-only, fast) or "dev" (full dev setup). Default: dev' },
          plugin: { type: 'string', description: 'Plugin name for plugin-external projects' },
          deps: { type: 'string', description: 'Comma-separated dependency plugin names' },
        },
        required: ['issue'],
      },
    },
    {
      name: 'swctl_view_diff',
      description: 'View the git diff for a worktree instance, comparing its branch against the base branch. For plugin instances, diffs the plugin repo.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          issueId: { type: 'string', description: 'Instance issue ID (e.g. "15847")' },
          statOnly: { type: 'boolean', description: 'Return only the diff stat summary (no full diff). Default: false' },
        },
        required: ['issueId'],
      },
    },
    {
      name: 'swctl_exec_command',
      description: 'Execute a shell command inside an instance\'s Docker container (e.g. bin/console, composer, php).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          issueId: { type: 'string', description: 'Instance issue ID' },
          command: { type: 'string', description: 'Command to execute inside the container' },
        },
        required: ['issueId', 'command'],
      },
    },
    {
      name: 'swctl_start_stop',
      description: 'Start, stop, or restart a worktree instance container.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          issueId: { type: 'string', description: 'Instance issue ID' },
          action: { type: 'string', enum: ['start', 'stop', 'restart'], description: 'Action to perform' },
        },
        required: ['issueId', 'action'],
      },
    },
    {
      name: 'swctl_clean',
      description: 'Remove a worktree instance: stops the container, removes the worktree, and cleans up metadata.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          issueId: { type: 'string', description: 'Instance issue ID to clean' },
        },
        required: ['issueId'],
      },
    },
    {
      name: 'swctl_refresh',
      description: 'Refresh a worktree instance: pulls latest changes from remote, rebuilds if needed.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          issueId: { type: 'string', description: 'Instance issue ID to refresh' },
        },
        required: ['issueId'],
      },
    },
    {
      name: 'swctl_smart_create',
      description: 'Smart worktree creation with automatic optimization: runs pre-flight validation, analyzes branch diff to preview which steps will run or be skipped (composer install, frontend builds, database setup), creates the worktree, and reports estimated time saved. Shows a detailed create plan before execution.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          issue: { type: 'string', description: 'Issue number or identifier (e.g. "15847")' },
          branch: { type: 'string', description: 'Git branch name (auto-detected if omitted)' },
          project: { type: 'string', description: 'Project name (uses default if omitted)' },
          mode: { type: 'string', enum: ['qa', 'dev'], description: 'Mode: "qa" or "dev". Default: dev' },
          plugin: { type: 'string', description: 'Plugin name for plugin-external projects' },
          deps: { type: 'string', description: 'Comma-separated dependency plugin names' },
          context: { type: 'string', description: 'Additional context about what this issue is for (helps with suggestions)' },
        },
        required: ['issue'],
      },
    },
    {
      name: 'swctl_github_issues',
      description: 'Fetch GitHub issues and PRs assigned to you, requested for your review, or authored by you across the organization.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          org: { type: 'string', description: 'GitHub organization (default: from config or "shopware")' },
        },
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  switch (name) {
    case 'swctl_list_instances':
      return listInstances(args as any || {})
    case 'swctl_create_worktree':
      return createWorktree(args as any)
    case 'swctl_view_diff':
      return viewDiff(args as any)
    case 'swctl_exec_command':
      return execCommand(args as any)
    case 'swctl_start_stop':
      return startStop(args as any)
    case 'swctl_clean':
      return clean(args as any)
    case 'swctl_refresh':
      return refresh(args as any)
    case 'swctl_smart_create':
      return smartCreate(args as any)
    case 'swctl_github_issues':
      return githubIssues(args as any || {})
    default:
      return {
        content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
        isError: true,
      }
  }
})

// --- Resources ---

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const instanceResources = await listInstanceUris()
  return {
    resources: [
      {
        uri: 'swctl://config',
        name: 'Project Config',
        description: 'Current project configuration from .swctl.conf',
        mimeType: 'application/json',
      },
      {
        uri: 'swctl://projects',
        name: 'Projects',
        description: 'Registered projects and their types',
        mimeType: 'application/json',
      },
      ...instanceResources,
    ],
  }
})

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri

  if (uri === 'swctl://config') {
    const result = await readConfig()
    return { contents: [result] }
  }

  if (uri === 'swctl://projects') {
    const result = await readProjectsList()
    return { contents: [result] }
  }

  const instanceMatch = uri.match(/^swctl:\/\/instance\/(.+)$/)
  if (instanceMatch) {
    const result = await readInstanceDetail(instanceMatch[1])
    if (!result) {
      throw new Error(`Instance '${instanceMatch[1]}' not found`)
    }
    return { contents: [result] }
  }

  throw new Error(`Unknown resource: ${uri}`)
})

// --- Start ---

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  console.error('Failed to start swctl MCP server:', err)
  process.exit(1)
})
