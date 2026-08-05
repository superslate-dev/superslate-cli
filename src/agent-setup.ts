import * as prompts from '@clack/prompts'
import {mkdir, readFile, rename, stat, writeFile} from 'node:fs/promises'
import {dirname, join, resolve} from 'node:path'
import {runCaptured, which} from './runtime.js'

export type AgentClient = 'codex' | 'claude' | 'cursor'

export interface AgentSetupArguments {
  clients?: AgentClient[]
  yes: boolean
  dryRun: boolean
  help: boolean
}

const CLIENTS: AgentClient[] = ['codex', 'claude', 'cursor']
const SERVER_NAME = 'superslate-docs'
const CODEX_START = '# superslate-agent-context:start'
const CODEX_END = '# superslate-agent-context:end'

function takeValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value.`)
  return value
}

export function parseAgentSetupArguments(argv: string[]): AgentSetupArguments {
  const parsed: AgentSetupArguments = {yes: false, dryRun: false, help: false}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--clients') {
      const values = takeValue(argv, index++, argument)
        .split(',')
        .map(value => value.trim())
        .filter(Boolean)
      const invalid = values.filter(value => !CLIENTS.includes(value as AgentClient))
      if (invalid.length > 0) throw new Error(`Unknown agent client: ${invalid.join(', ')}`)
      parsed.clients = [...new Set(values as AgentClient[])]
    } else if (argument === '--yes' || argument === '-y') parsed.yes = true
    else if (argument === '--dry-run') parsed.dryRun = true
    else if (argument === '--help' || argument === '-h') parsed.help = true
    else throw new Error(`Unknown agent setup option: ${argument}`)
  }
  return parsed
}

export function agentSetupUsage(cliName: string): string {
  return `Usage: ${cliName} agent setup [options]

Connect local coding clients to this checkout's read-only superslate documentation server.

Options:
  --clients <list>  Comma-separated clients: codex,claude,cursor
  --yes              Configure every detected client without prompting
  --dry-run          Show the selected configuration without changing client settings
  -h, --help         Show this help`
}

async function pathExists(path: string): Promise<boolean> {
  return Boolean(await stat(path).catch(() => undefined))
}

export async function findAgentRepositoryRoot(start = process.cwd()): Promise<string> {
  let current = resolve(start)
  while (true) {
    if (
      (await pathExists(join(current, 'AGENTS.md'))) &&
      (await pathExists(join(current, 'packages/agent-context/package.json'))) &&
      (await pathExists(join(current, 'agent-tooling/manifest.json')))
    ) {
      return current
    }
    const parent = dirname(current)
    if (parent === current) throw new Error('Run agent setup inside a superslate repository.')
    current = parent
  }
}

export function serverCommand(root: string): {command: string; args: string[]} {
  return {command: 'pnpm', args: ['--dir', resolve(root), 'superslate:mcp']}
}

function codexManagedBlock(root: string): string {
  const server = serverCommand(root)
  const args = server.args.map(argument => JSON.stringify(argument)).join(', ')
  return `${CODEX_START}
[mcp_servers.${SERVER_NAME}]
command = ${JSON.stringify(server.command)}
args = [${args}]
required = false
enabled_tools = ["search_docs", "get_repository_map", "plan_change", "get_invariants", "get_verification"]
${CODEX_END}`
}

export function mergeCodexConfig(existing: string, root: string): string {
  const managed = codexManagedBlock(root)
  const start = existing.indexOf(CODEX_START)
  const end = existing.indexOf(CODEX_END)
  if (start >= 0 || end >= 0) {
    if (start < 0 || end < start)
      throw new Error('Codex config has an incomplete superslate block.')
    const after = end + CODEX_END.length
    return `${existing.slice(0, start).trimEnd()}\n\n${managed}${existing.slice(after)}`.trimStart()
  }
  if (/^\[mcp_servers\.(?:superslate-docs|superslate_docs|"superslate-docs")\]$/m.test(existing)) {
    throw new Error(
      'Codex already has an unmanaged superslate-docs server; remove or rename it first.',
    )
  }
  return `${existing.trimEnd()}${existing.trim() ? '\n\n' : ''}${managed}\n`
}

interface CursorConfig {
  mcpServers?: Record<string, unknown>
  [key: string]: unknown
}

export function mergeCursorConfig(existing: string | undefined, root: string): string {
  let config: CursorConfig = {}
  if (existing?.trim()) {
    try {
      const parsed = JSON.parse(existing) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Cursor MCP configuration must be a JSON object.')
      }
      config = parsed as CursorConfig
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error('Cursor MCP configuration is invalid JSON.')
      throw error
    }
  }

  const servers = config.mcpServers ?? {}
  const current = servers[SERVER_NAME]
  const desired = serverCommand(root)
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(desired)) {
    throw new Error(
      'Cursor already has a different superslate-docs server; remove or rename it first.',
    )
  }
  config.mcpServers = {...servers, [SERVER_NAME]: desired}
  return `${JSON.stringify(config, null, 2)}\n`
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), {recursive: true})
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, content, {mode: 0o600})
  await rename(temporary, path)
}

async function capture(
  command: string[],
  cwd: string,
): Promise<{
  exitCode: number
  stdout: string
  stderr: string
}> {
  return runCaptured(command, {cwd})
}

async function addGitInfoExcludes(root: string, paths: string[]): Promise<boolean> {
  const result = await capture(['git', 'rev-parse', '--git-path', 'info/exclude'], root)
  if (result.exitCode !== 0) return false
  const rawPath = result.stdout.trim()
  if (!rawPath) return false
  const excludePath = resolve(root, rawPath)
  const existing = await readFile(excludePath, 'utf8').catch(() => '')
  const missing = paths.filter(path => !existing.split(/\r?\n/).includes(path))
  if (missing.length === 0) return true
  const prefix = existing && !existing.endsWith('\n') ? '\n' : ''
  const marker = '# superslate local agent configuration'
  const heading = existing.split(/\r?\n/).includes(marker) ? '' : `${marker}\n`
  await atomicWrite(excludePath, `${existing}${prefix}${heading}${missing.join('\n')}\n`)
  return true
}

async function configureCodex(root: string): Promise<string> {
  const path = join(root, '.codex/config.toml')
  const existing = await readFile(path, 'utf8').catch(() => '')
  await atomicWrite(path, mergeCodexConfig(existing, root))
  const excluded = await addGitInfoExcludes(root, ['.codex/config.toml'])
  return excluded
    ? 'Configured project-local .codex/config.toml (excluded from Git).'
    : 'Configured project-local .codex/config.toml; review Git status before committing it.'
}

async function configureCursor(root: string): Promise<string> {
  const path = join(root, '.cursor/mcp.json')
  const existing = await readFile(path, 'utf8').catch(() => undefined)
  await atomicWrite(path, mergeCursorConfig(existing, root))
  const excluded = await addGitInfoExcludes(root, ['.cursor/mcp.json'])
  return excluded
    ? 'Configured project-local .cursor/mcp.json (excluded from Git).'
    : 'Configured project-local .cursor/mcp.json; review Git status before committing it.'
}

async function configureClaude(root: string): Promise<string> {
  if (!which('claude')) throw new Error('Claude Code CLI is not installed or not on PATH.')
  const existing = await capture(['claude', 'mcp', 'get', SERVER_NAME], root)
  if (existing.exitCode === 0) {
    const combined = `${existing.stdout}\n${existing.stderr}`
    if (combined.includes('superslate:mcp') && combined.includes(root)) {
      return 'Claude Code already has the matching local server.'
    }
    throw new Error('Claude Code already has a different superslate-docs server; remove it first.')
  }

  const server = serverCommand(root)
  const result = await capture(
    ['claude', 'mcp', 'add', SERVER_NAME, '--scope', 'local', '--', server.command, ...server.args],
    root,
  )
  if (result.exitCode !== 0) {
    const output = result.stderr.trim() || result.stdout.trim()
    throw new Error(`Claude Code MCP setup failed${output ? `: ${output}` : '.'}`)
  }
  return 'Configured Claude Code local project scope.'
}

async function smokeServer(root: string): Promise<void> {
  const result = await capture(
    ['pnpm', '--dir', root, 'superslate:mcp', '--check', '--root', root],
    root,
  )
  if (result.exitCode !== 0) {
    const output = result.stderr.trim() || result.stdout.trim()
    throw new Error(`superslate MCP self-check failed${output ? `: ${output}` : '.'}`)
  }
  const report = JSON.parse(result.stdout) as {ok?: boolean; tools?: number}
  if (!report.ok || report.tools !== 5) throw new Error('superslate MCP self-check was incomplete.')
}

function detectedClients(): AgentClient[] {
  return CLIENTS.filter(client => {
    if (client === 'cursor') return Boolean(which('cursor'))
    return Boolean(which(client))
  })
}

async function chooseClients(parsed: AgentSetupArguments): Promise<AgentClient[] | undefined> {
  if (parsed.clients) {
    if (parsed.clients.length === 0) throw new Error('--clients must select at least one client.')
    return parsed.clients
  }
  const detected = detectedClients()
  if (parsed.yes) {
    if (detected.length === 0) {
      throw new Error('No supported client was detected. Pass --clients codex,claude,cursor.')
    }
    return detected
  }
  if (!process.stdin.isTTY) {
    throw new Error('Interactive setup needs a terminal. Pass --clients and --yes instead.')
  }

  const selected = await prompts.multiselect<AgentClient>({
    message: 'Connect which local coding clients?',
    required: true,
    options: CLIENTS.map(client => ({
      value: client,
      label: client === 'claude' ? 'Claude Code' : `${client[0]!.toUpperCase()}${client.slice(1)}`,
      hint: detected.includes(client) ? 'detected' : 'not detected on PATH',
    })),
    initialValues: detected,
  })
  if (prompts.isCancel(selected)) {
    prompts.cancel('No agent clients were configured.')
    return undefined
  }
  return selected
}

function dryRunDescription(client: AgentClient, root: string): string {
  if (client === 'codex') return mergeCodexConfig('', root).trim()
  if (client === 'cursor') return mergeCursorConfig(undefined, root).trim()
  const server = serverCommand(root)
  return [
    'claude',
    'mcp',
    'add',
    SERVER_NAME,
    '--scope',
    'local',
    '--',
    server.command,
    ...server.args,
  ]
    .map(value => (value.includes(' ') ? JSON.stringify(value) : value))
    .join(' ')
}

export async function runAgentSetup(argv: string[], cliName: string): Promise<void> {
  const parsed = parseAgentSetupArguments(argv)
  if (parsed.help) {
    process.stdout.write(`${agentSetupUsage(cliName)}\n`)
    return
  }
  const root = await findAgentRepositoryRoot()
  const clients = await chooseClients(parsed)
  if (!clients) return

  prompts.intro('superslate local agent context')
  if (parsed.dryRun) {
    for (const client of clients) {
      prompts.log.info(`${client}\n${dryRunDescription(client, root)}`)
    }
    prompts.outro('Dry run complete. No client configuration was changed.')
    return
  }

  const progress = prompts.spinner()
  progress.start('Testing the local MCP server')
  await smokeServer(root)
  progress.stop('Local MCP server passed its protocol self-check')

  for (const client of clients) {
    const result =
      client === 'codex'
        ? await configureCodex(root)
        : client === 'cursor'
          ? await configureCursor(root)
          : await configureClaude(root)
    prompts.log.success(`${client}: ${result}`)
  }
  prompts.log.info('Restart configured clients, then ask: “Use plan_change for my next feature.”')
  prompts.outro('superslate agent context is ready.')
}
