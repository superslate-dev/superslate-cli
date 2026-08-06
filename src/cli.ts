#!/usr/bin/env bun

import * as prompts from '@clack/prompts'
import {existsSync, readdirSync, statSync} from 'node:fs'
import {mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, stat} from 'node:fs/promises'
import {createConnection, createServer} from 'node:net'
import {fileURLToPath} from 'node:url'
import {dirname, join, relative, resolve, sep} from 'node:path'

import {CLI_NAME, LICENSE_KEY_VARIABLE} from './constants.js'
import {normalizeScope, validateAppName, validateBrandName} from './core.js'
import {
  normalizeSourceVersion,
  readLicenseKeyFromEnvironment,
  validateLicenseKey,
  type DownloadProgress,
} from './delivery.js'
import {agentSetupUsage, runAgentSetup} from './agent-setup.js'
import {runDeploymentConfigure} from './deployment-cli.js'
import {isEntrypoint, runCaptured, runInherited} from './runtime.js'
import {collectDeploymentSelection, type DeploymentPromptDefaults} from './deployment-prompts.js'
import {
  applyDeploymentSelection,
  parseDeploymentCloud,
  parseFrontendTarget,
  parseStorageProvider,
  type DeploymentSelection,
} from './deployment.js'
import {scaffold} from './scaffold.js'

export interface Arguments {
  appName?: string
  from?: string
  licenseKey?: string
  sourceVersion?: string
  scope?: string
  brandName?: string
  yes: boolean
  initializeGit?: boolean
  installDependencies?: boolean
  startDevelopment?: boolean
  setupDeployment?: boolean
  deployment: DeploymentPromptDefaults
  help: boolean
  version: boolean
}

export interface CliOptions {
  appName: string
  from?: string
  licenseKey?: string
  sourceVersion?: string
  scope: string
  brandName: string
  initializeGit: boolean
  installDependencies: boolean
  startDevelopment: boolean
  deployment?: DeploymentSelection
}

class CliCancelled extends Error {}

export function usage(): string {
  return `Usage: ${CLI_NAME} [app-name] [options]
       ${CLI_NAME} agent setup [options]
       ${CLI_NAME} deploy configure [options]

Create a buyer-owned SaaS application from your licensed ${suggestBrandName(CLI_NAME)} release.

Options:
  --license-key <key> Licence key from your purchase (or set ${LICENSE_KEY_VARIABLE})
  --source-version <version> Pin an immutable release (default: the latest you are entitled to)
  --from <path>       Use a local source checkout (maintainer/testing)
  --scope <namespace> Advanced workspace namespace override (default: derived from brand)
  --brand <name>      Display name (default: derived from app name)
  --yes               Accept recommended defaults for omitted options
  --git / --no-git    Enable or disable Git initialization (default: enabled)
  --install           Install dependencies (default: enabled)
  --no-install        Skip dependency installation
  --start             Start Postgres and development servers after creation
  --no-start          Create the application without starting it
  --cloud <provider>  Configure AWS, GCP, or Azure deployment during setup
  --storage <provider> Select r2, s3, or gcs object storage
  --no-deploy         Keep every cloud option for later deployment setup
  --frontend <target> Select native, vercel, or cloudflare frontend hosting
  --deploy-environment <name> Deployment environment (default: production)
  --region <name>      Cloud region
  --api-domain <host>  Stable production API hostname
  --frontend-domain <host> Stable production frontend hostname
  --ha / --no-ha      Enable or disable the higher-availability profile
  -v, --version       Print the CLI version
  -h, --help          Show this help

Agent tooling:
  ${agentSetupUsage(CLI_NAME)}

Deployment:
  Run pnpm deploy:configure inside a generated app to make a deferred cloud selection.`
}

function takeValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`)
  return value
}

export function parseArguments(argv: string[]): Arguments {
  const parsed: Arguments = {
    yes: false,
    deployment: {},
    help: false,
    version: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--from') parsed.from = takeValue(argv, index++, argument)
    else if (argument === '--license-key') parsed.licenseKey = takeValue(argv, index++, argument)
    else if (argument === '--source-version') {
      parsed.sourceVersion = normalizeSourceVersion(takeValue(argv, index++, argument))
    } else if (argument === '--scope') parsed.scope = takeValue(argv, index++, argument)
    else if (argument === '--brand') parsed.brandName = takeValue(argv, index++, argument)
    else if (argument === '--yes' || argument === '-y') parsed.yes = true
    else if (argument === '--git') parsed.initializeGit = true
    else if (argument === '--no-git') parsed.initializeGit = false
    else if (argument === '--install') parsed.installDependencies = true
    else if (argument === '--no-install') parsed.installDependencies = false
    else if (argument === '--start') parsed.startDevelopment = true
    else if (argument === '--no-start') parsed.startDevelopment = false
    else if (argument === '--cloud') {
      parsed.deployment.cloud = parseDeploymentCloud(takeValue(argv, index++, argument))
      parsed.setupDeployment = true
    } else if (argument === '--no-deploy') parsed.setupDeployment = false
    else if (argument === '--storage') {
      parsed.deployment.storageProvider = parseStorageProvider(takeValue(argv, index++, argument))
    } else if (argument === '--frontend') {
      parsed.deployment.frontendTarget = parseFrontendTarget(takeValue(argv, index++, argument))
    } else if (argument === '--deploy-environment') {
      parsed.deployment.environment = takeValue(argv, index++, argument)
    } else if (argument === '--region')
      parsed.deployment.region = takeValue(argv, index++, argument)
    else if (argument === '--api-domain') {
      parsed.deployment.apiDomain = takeValue(argv, index++, argument)
    } else if (argument === '--frontend-domain') {
      parsed.deployment.frontendDomain = takeValue(argv, index++, argument)
    } else if (argument === '--ha') parsed.deployment.haEnabled = true
    else if (argument === '--no-ha') parsed.deployment.haEnabled = false
    else if (argument === '--version' || argument === '-v') parsed.version = true
    else if (argument === '--help' || argument === '-h') parsed.help = true
    else if (argument?.startsWith('-')) throw new Error(`Unknown option: ${argument}`)
    else if (!parsed.appName) parsed.appName = argument
    else throw new Error(`Unexpected argument: ${argument}`)
  }
  return parsed
}

export function suggestBrandName(appName: string): string {
  const productAcronyms: Record<string, string> = {
    ai: 'AI',
    api: 'API',
    b2b: 'B2B',
    b2c: 'B2C',
    crm: 'CRM',
    saas: 'SaaS',
  }

  return appName
    .split('-')
    .map(
      segment =>
        productAcronyms[segment] ?? `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`,
    )
    .join(' ')
}

export function suggestScope(brandName: string, fallbackAppName: string): string {
  const namespace = brandName
    .normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return namespace || fallbackAppName
}

async function unwrapPrompt<T>(value: T | symbol): Promise<T> {
  if (prompts.isCancel(value)) {
    prompts.cancel('No project was created.')
    throw new CliCancelled()
  }
  return value
}

export function describeTargetConflict(appName: string): string | undefined {
  const target = resolve(process.cwd(), appName)
  if (!existsSync(target)) return undefined
  if (!statSync(target).isDirectory()) return `./${appName} already exists as a file.`
  if (readdirSync(target).length > 0) {
    return `./${appName} already exists and is not empty. Pick another name, or remove it first.`
  }
  return undefined
}

export async function collectLicenseKey(parsed: Arguments): Promise<string> {
  const supplied = parsed.licenseKey?.trim() ?? readLicenseKeyFromEnvironment()
  if (supplied) {
    const error = validateLicenseKey(supplied)
    if (error) throw new Error(error)
    return supplied.trim()
  }
  if (parsed.yes || !process.stdin.isTTY) {
    throw new Error(`A licence key is required. Pass --license-key or set ${LICENSE_KEY_VARIABLE}.`)
  }
  const entered = await unwrapPrompt(
    await prompts.password({
      message: 'Licence key',
      validate: value => validateLicenseKey(value ?? ''),
    }),
  )
  return entered.trim()
}

async function collectOptions(parsed: Arguments): Promise<CliOptions> {
  if (parsed.yes && !parsed.appName) throw new Error('Pass an app name when using --yes.')
  if (!parsed.yes && !process.stdin.isTTY && !parsed.appName) {
    throw new Error('Interactive prompts need a terminal. Pass an app name and --yes instead.')
  }

  const appName =
    parsed.appName ??
    (await unwrapPrompt(
      await prompts.text({
        message: 'App name',
        placeholder: 'my-saas',
        validate: value => validateAppName(value ?? '') ?? describeTargetConflict(value ?? ''),
      }),
    ))
  const appNameError = validateAppName(appName)
  if (appNameError) throw new Error(appNameError)
  const targetConflict = describeTargetConflict(appName)
  if (targetConflict) throw new Error(targetConflict)

  const licenseKey = parsed.from ? undefined : await collectLicenseKey(parsed)

  const suggestedBrand = suggestBrandName(appName)
  const brandName =
    parsed.brandName ??
    (parsed.yes
      ? suggestedBrand
      : await unwrapPrompt(
          await prompts.text({
            message: 'Brand name',
            placeholder: suggestedBrand,
            defaultValue: suggestedBrand,
            validate: value => validateBrandName(value || suggestedBrand),
          }),
        ))
  const brandError = validateBrandName(brandName)
  if (brandError) throw new Error(brandError)
  const scope = normalizeScope(parsed.scope ?? suggestScope(brandName, appName))

  const initializeGit =
    parsed.initializeGit ??
    (parsed.yes
      ? true
      : await unwrapPrompt(
          await prompts.confirm({
            message: 'Initialize a Git repository?',
            initialValue: true,
          }),
        ))
  const installDependencies =
    parsed.installDependencies ??
    (parsed.yes
      ? true
      : await unwrapPrompt(
          await prompts.confirm({
            message: 'Install dependencies with pnpm?',
            initialValue: true,
          }),
        ))
  if (parsed.startDevelopment && !installDependencies) {
    throw new Error('--start requires dependency installation. Remove --no-install.')
  }
  const startDevelopment =
    parsed.startDevelopment ??
    (parsed.yes || !installDependencies
      ? false
      : await unwrapPrompt(
          await prompts.confirm({
            message: 'Start local development now?',
            initialValue: true,
          }),
        ))

  const setupDeployment =
    parsed.setupDeployment ??
    (parsed.yes
      ? false
      : await unwrapPrompt(
          await prompts.confirm({
            message: 'Set up cloud deployment now?',
            initialValue: false,
          }),
        ))
  const deployment = setupDeployment
    ? await collectDeploymentSelection(parsed.deployment, parsed.yes)
    : undefined

  return {
    appName,
    from: parsed.from ? resolve(parsed.from) : undefined,
    licenseKey,
    sourceVersion: parsed.sourceVersion,
    scope,
    brandName,
    initializeGit,
    installDependencies,
    startDevelopment,
    deployment,
  }
}

async function readCliVersion(): Promise<string> {
  const packageJson = JSON.parse(
    await readFile(resolve(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8'),
  ) as {version?: string}
  if (!packageJson.version) throw new Error(`${CLI_NAME} package version is missing.`)
  return packageJson.version
}

async function assertTargetAvailable(target: string): Promise<void> {
  const targetStat = await stat(target).catch(() => undefined)
  if (!targetStat) return
  if (!targetStat.isDirectory()) throw new Error(`Target exists and is not a directory: ${target}`)
  if ((await readdir(target)).length > 0) {
    throw new Error(`Refusing to overwrite non-empty directory: ${target}`)
  }
}

async function hasListeningServiceOnHost(port: number, host: string): Promise<boolean> {
  return await new Promise(resolvePort => {
    let settled = false
    const socket = createConnection({host, port})
    const finish = (listening: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolvePort(listening)
    }
    socket.setTimeout(250)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

async function hasListeningService(port: number): Promise<boolean> {
  const results = await Promise.all(
    ['127.0.0.1', '::1'].map(host => hasListeningServiceOnHost(port, host)),
  )
  return results.some(Boolean)
}

async function isPortAvailable(port: number): Promise<boolean> {
  if (await hasListeningService(port)) return false
  return await new Promise(resolvePort => {
    const server = createServer()
    server.unref()
    server.once('error', () => resolvePort(false))
    server.listen({host: '127.0.0.1', port, exclusive: true}, () => {
      server.close(() => resolvePort(true))
    })
  })
}

export async function findAvailablePort(preferredPort = 5432): Promise<number> {
  for (let port = preferredPort; port < preferredPort + 100; port += 1) {
    if (await isPortAvailable(port)) return port
  }
  throw new Error(`No available local Postgres port found from ${preferredPort}.`)
}

function assertSiblingTarget(source: string | undefined, target: string): void {
  if (!source) return
  const normalizedSource = resolve(source)
  const normalizedTarget = resolve(target)
  if (normalizedTarget.startsWith(`${normalizedSource}${sep}`)) {
    throw new Error(`Create the new app beside the ${CLI_NAME} source checkout, not inside it.`)
  }
}

function commandFailureOutput(stdout: string, stderr: string): string {
  const output = (stderr.trim() || stdout.trim()).split('\n').slice(-12).join('\n')
  return output ? `\n\n${output}` : ''
}

async function installDependencies(target: string): Promise<void> {
  const {stdout, stderr, exitCode} = await runCaptured(['pnpm', 'install', '--frozen-lockfile'], {
    cwd: target,
    env: {...process.env, CI: '1'},
  })
  if (exitCode !== 0) {
    throw new Error(`Dependency installation failed.${commandFailureOutput(stdout, stderr)}`)
  }
}

export async function occupiedDevelopmentPorts(): Promise<number[]> {
  const results = await Promise.all(
    [5173, 8000].map(async port => ({port, available: await isPortAvailable(port)})),
  )
  return results.filter(result => !result.available).map(result => result.port)
}

async function startDevelopment(target: string): Promise<void> {
  prompts.log.info('Web  http://localhost:5173\nAPI  http://localhost:8000')
  prompts.outro(
    'Development servers are starting. Ctrl+C stops app servers; Postgres stays running.',
  )

  const exitCode = await runInherited(['pnpm', 'run', 'dev'], {cwd: target})
  if (exitCode !== 0 && exitCode !== 130) {
    throw new Error(`Development servers exited with code ${exitCode}.`)
  }
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB']
const BYTE_SCALE = 1024
const PROGRESS_MAX = 100
const PROGRESS_BAR_WIDTH = 40
const PROGRESS_MIN_INTERVAL_MS = 80
const PROGRESS_MIN_DELTA = 0.5

export function formatBytes(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= BYTE_SCALE && unit < BYTE_UNITS.length - 1) {
    value /= BYTE_SCALE
    unit += 1
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${BYTE_UNITS[unit]}`
}

function supportsAnimation(): boolean {
  return prompts.isTTY(process.stdout) && !prompts.isCI()
}

interface ScaffoldReporter {
  handle: prompts.SpinnerResult
  onDownloadProgress?: DownloadProgress
}

function createScaffoldReporter(pending: string, expectsDownload: boolean): ScaffoldReporter {
  if (!expectsDownload || !supportsAnimation()) return {handle: prompts.spinner()}

  const bar = prompts.progress({
    style: 'heavy',
    size: PROGRESS_BAR_WIDTH,
    max: PROGRESS_MAX,
  })
  let shown = 0
  let emittedAt = 0
  return {
    handle: bar,
    onDownloadProgress: (received, total) => {
      const percent = total ? Math.min(PROGRESS_MAX, (received / total) * PROGRESS_MAX) : shown
      const finished = total !== undefined && received >= total
      const now = performance.now()
      if (
        !finished &&
        now - emittedAt < PROGRESS_MIN_INTERVAL_MS &&
        percent - shown < PROGRESS_MIN_DELTA
      ) {
        return
      }
      emittedAt = now
      const label = finished
        ? pending
        : total === undefined
          ? `Downloading source  ${formatBytes(received)}`
          : `Downloading source  ${formatBytes(received)} / ${formatBytes(total)}`
      bar.advance(percent - shown, label)
      shown = percent
    },
  }
}

async function runStep<T>(
  pending: string,
  complete: string,
  action: () => Promise<T>,
  handle: prompts.SpinnerResult,
): Promise<T> {
  handle.start(pending)
  try {
    const result = await action()
    handle.stop(complete)
    return result
  } catch (error) {
    handle.error(`${pending} failed`)
    throw error
  }
}

async function createApplication(
  options: CliOptions,
): Promise<{target: string; databasePort: number}> {
  const target = resolve(process.cwd(), options.appName)
  await assertTargetAvailable(target)
  assertSiblingTarget(options.from, target)
  const databasePort = await findAvailablePort()
  await mkdir(dirname(target), {recursive: true})
  const staging = await mkdtemp(join(dirname(target), `.${options.appName}-${CLI_NAME}-`))

  const preparing = 'Preparing your application'
  const reporter = createScaffoldReporter(preparing, Boolean(options.licenseKey))

  try {
    await runStep(
      preparing,
      'Application source prepared',
      () =>
        scaffold({
          appName: options.appName,
          scope: options.scope,
          brandName: options.brandName,
          targetDirectory: staging,
          from: options.from,
          licenseKey: options.licenseKey,
          sourceVersion: options.sourceVersion,
          initializeGit: options.initializeGit,
          databasePort,
          onDownloadProgress: reporter.onDownloadProgress,
        }),
      reporter.handle,
    )
    if (options.deployment) {
      await runStep(
        'Configuring deployment',
        'Deployment target locked',
        () => applyDeploymentSelection(staging, options.appName, options.deployment!),
        prompts.spinner(),
      )
    }
    if (options.installDependencies) {
      await runStep(
        'Installing dependencies with pnpm',
        'Dependencies installed with pnpm',
        () => installDependencies(staging),
        prompts.spinner({indicator: 'timer'}),
      )
    }

    if (await stat(target).catch(() => undefined)) await rmdir(target)
    await rename(staging, target)
    return {target, databasePort}
  } catch (error) {
    await rm(staging, {recursive: true, force: true})
    throw error
  }
}

function completionDetails(
  target: string,
  options: CliOptions,
  databasePort: number,
): {
  directory: string
  commands: string
  database: string
} {
  const targetName = relative(process.cwd(), target) || options.appName
  const install = options.installDependencies ? [] : ['vp install --frozen-lockfile']
  return {
    directory: `./${targetName}`,
    commands: [`cd ${targetName}`, ...install, 'pnpm dev'].join('\n'),
    database: `Postgres  localhost:${databasePort}`,
  }
}

export function printRunnableCommands(commands: string): void {
  console.log(`\n${commands}\n`)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv[0] === 'agent') {
    if (argv[1] !== 'setup') throw new Error('Unknown agent command. Use `agent setup`.')
    await runAgentSetup(argv.slice(2), CLI_NAME)
    return
  }
  if (argv[0] === 'deploy') {
    if (argv[1] !== 'configure') throw new Error('Unknown deploy command. Use `deploy configure`.')
    await runDeploymentConfigure(argv.slice(2), suggestBrandName(CLI_NAME))
    return
  }
  const parsed = parseArguments(argv)
  const version = await readCliVersion()
  if (parsed.help) {
    console.log(usage())
    return
  }
  if (parsed.version) {
    console.log(version)
    return
  }

  prompts.intro(`${suggestBrandName(CLI_NAME)} ${version} · production SaaS foundation`)
  const options = await collectOptions(parsed)
  const {target, databasePort} = await createApplication(options)
  const completion = completionDetails(target, options, databasePort)
  prompts.log.success(`Created ${completion.directory}`)
  if (!options.startDevelopment) {
    prompts.log.step('Run locally')
    prompts.log.info(
      `Web       http://localhost:5173\nAPI       http://localhost:8000\n${completion.database}`,
    )
    if (options.deployment) {
      prompts.log.info(
        `Deployment ${options.deployment.cloud.toUpperCase()} + ${options.deployment.storageProvider} + ${options.deployment.frontendTarget} locked. Review deployment/README.md.`,
      )
    } else {
      prompts.log.info('Deployment deferred. Run `pnpm deploy:configure` when you are ready.')
    }
    prompts.outro(`${options.brandName} is ready.`)
    printRunnableCommands(completion.commands)
    return
  }

  const occupiedPorts = await occupiedDevelopmentPorts()
  if (occupiedPorts.length > 0) {
    prompts.log.warn(
      `Port ${occupiedPorts.join(' and ')} already in use, so the development servers were not started.`,
    )
    prompts.log.step('Free the port, then run')
    prompts.outro(`${options.brandName} is ready at ${completion.directory}.`)
    printRunnableCommands(completion.commands)
    return
  }

  try {
    await startDevelopment(target)
  } catch (error) {
    prompts.log.error(error instanceof Error ? error.message : String(error))
    prompts.log.step('Start it manually')
    prompts.outro(`${options.brandName} is ready at ${completion.directory}.`)
    printRunnableCommands(completion.commands)
    process.exitCode = 1
  }
}

if (isEntrypoint(import.meta.url)) {
  main().catch((error: unknown) => {
    if (error instanceof CliCancelled) return
    prompts.log.error(error instanceof Error ? error.message : String(error))
    prompts.outro('No project was created.')
    process.exitCode = 1
  })
}
