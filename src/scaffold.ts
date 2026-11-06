import {execFile} from 'node:child_process'
import {createHash} from 'node:crypto'
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename, dirname, join, relative, resolve} from 'node:path'
import {promisify} from 'node:util'

import {BUYER_CLI_NAME, BUYER_CLI_PACKAGE_NAME, CLI_NAME, CLI_PACKAGE_NAME} from './constants.js'
import {
  deliveryBaseUrl,
  downloadAsset,
  entitledSelection,
  releaseAssetNames,
  resolveEdition,
  resolveRelease,
  type DownloadProgress,
} from './delivery.js'
import {
  normalizeEditions,
  pruneLockfileImporters,
  rewriteStartWorkerIdentifiers,
  selectedEditions,
  START_EDITION_OVERLAY,
  START_EDITION_PATHS,
  START_ONLY_KEPT_PATHS,
  START_ROOT_CONTRACTS,
  startOnlyRootPackage,
  stripKnipWorkspaces,
  stripStartReferences,
  type EditionName,
  type EditionSelection,
} from './editions.js'
import {
  BRAND_MANIFEST,
  START_BRAND_MANIFEST,
  deriveMobileIdentity,
  formatRewrittenPackageJson,
  generateServerEnv,
  generateStartDevVars,
  MOBILE_EDITION_PATHS,
  rewriteMobileAppConfig,
  rewriteMobileAppScheme,
  stripMobileDocsPage,
  stripMobileDocsReferences,
  stripMobileDocsSource,
  stripMobileKnipWorkspace,
  stripMobileRootScripts,
  isScopeRewriteFile,
  isTemplatePathExcluded,
  rewriteBuyerAgentInstructions,
  rewriteBuyerClaudeInstructions,
  rewriteBuyerCliConstants,
  stripDistributionReadmeBootstrap,
  stripSellerOnlyRootScripts,
  rewriteBuyerReleaseInstructions,
  rewriteBuyerSetupInstructions,
  rewriteBrandContent,
  rewriteRootPackageName,
  rewriteScopeContent,
  rewriteSiteWorkerName,
  rewriteWorkerName,
  wrapBrandedJsxText,
  wrapLongNamedImports,
  type RewriteReport,
} from './core.js'

const SHA256_CHECKSUM_LINE_RE = /^([a-f0-9]{64})\s+\*?([^\s]+)$/i

const execFileAsync = promisify(execFile)

export interface ScaffoldOptions {
  appName: string
  scope: string
  brandName: string
  targetDirectory: string
  from?: string
  licenseKey?: string
  sourceVersion?: string
  initializeGit: boolean
  databasePort?: number
  onDownloadProgress?: DownloadProgress
  /**
   * Which editions ship. Left undefined, a licensed run takes what the licence
   * entitles, and a local `--from` run defaults to the web foundation alone, so an
   * edition is never granted by accident.
   */
  includeWeb?: boolean
  includeMobile?: boolean
  includeStart?: boolean
  mobileBundleIdentifier?: string
  mobileAppDomain?: string
}

export interface ScaffoldReport {
  targetDirectory: string
  packageName: RewriteReport
  scope: RewriteReport
  brand: RewriteReport
  editions: EditionName[]
  mobile: boolean
}

async function assertEmptyTarget(targetDirectory: string): Promise<void> {
  try {
    const targetStat = await stat(targetDirectory)
    if (!targetStat.isDirectory())
      throw new Error(`Target exists and is not a directory: ${targetDirectory}`)
    if ((await readdir(targetDirectory)).length > 0) {
      throw new Error(`Refusing to overwrite non-empty directory: ${targetDirectory}`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function trackedTemplatePaths(sourceDirectory: string): Promise<Set<string> | undefined> {
  const topLevel = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
    cwd: sourceDirectory,
  })
    .then(result => resolve(result.stdout.trim()))
    .catch(() => undefined)
  if (topLevel !== sourceDirectory) return undefined

  const {stdout} = await execFileAsync('git', ['ls-files', '-z'], {
    cwd: sourceDirectory,
    maxBuffer: 64 * 1024 * 1024,
  })
  const tracked = new Set<string>()
  for (const path of stdout.split('\0')) {
    if (!path) continue
    tracked.add(path)
    for (let parent = dirname(path); parent !== '.'; parent = dirname(parent)) {
      tracked.add(parent)
    }
  }
  return tracked
}

async function copyLocalTemplate(source: string, target: string): Promise<void> {
  const sourceDirectory = resolve(source)
  const sourceStat = await lstat(sourceDirectory).catch(() => undefined)
  if (!sourceStat?.isDirectory())
    throw new Error(`Template path is not a directory: ${sourceDirectory}`)

  const tracked = await trackedTemplatePaths(sourceDirectory)
  const isTemplatePathIncluded = (relativePath: string): boolean =>
    relativePath === '' ||
    (!isTemplatePathExcluded(relativePath) && (!tracked || tracked.has(relativePath)))

  await assertNoSymbolicLinks(sourceDirectory, sourceDirectory, isTemplatePathIncluded)
  await mkdir(target, {recursive: true})
  await cp(sourceDirectory, target, {
    recursive: true,
    filter: path => isTemplatePathIncluded(relative(sourceDirectory, path).replaceAll('\\', '/')),
  })
  await assertNoSymbolicLinks(target)
}

async function assertNoSymbolicLinks(
  directory: string,
  root = directory,
  isIncluded?: (relativePath: string) => boolean,
): Promise<void> {
  const entries = await readdir(directory, {withFileTypes: true})
  for (const entry of entries) {
    const path = join(directory, entry.name)
    const relativePath = relative(root, path).replaceAll('\\', '/')
    if (isIncluded && !isIncluded(relativePath)) continue
    if (entry.isSymbolicLink()) {
      throw new Error(`Template contains a symbolic link, which is not supported: ${path}`)
    }
    if (entry.isDirectory()) await assertNoSymbolicLinks(path, root, isIncluded)
  }
}

interface ReleaseManifest {
  schemaVersion: string | number
  tag: string
  artifact: {file: string; sha256: string}
}

export function verifyReleaseMetadata(
  checksum: string,
  manifest: ReleaseManifest,
  artifactName: string,
  digest: string,
  templateRef: string,
): void {
  const checksumMatch = checksum.trim().match(SHA256_CHECKSUM_LINE_RE)
  if (!checksumMatch || checksumMatch[2] !== artifactName) {
    throw new Error(`${CLI_NAME} release checksum metadata is malformed.`)
  }
  if (checksumMatch[1]?.toLowerCase() !== digest) {
    throw new Error(`${CLI_NAME} release checksum verification failed.`)
  }
  if (
    String(manifest.schemaVersion) !== '1' ||
    manifest.tag !== templateRef ||
    manifest.artifact.file !== artifactName ||
    manifest.artifact.sha256.toLowerCase() !== digest
  ) {
    throw new Error(`${CLI_NAME} release manifest does not match the downloaded source artifact.`)
  }
}

type RequestedEditions = Partial<EditionSelection>

function chooseEditions(
  requested: RequestedEditions,
  entitled: EditionSelection | undefined,
): EditionSelection {
  const choose = (edition: EditionName, localDefault: boolean) =>
    entitled
      ? resolveEdition(edition, {
          requested: requested[edition],
          entitled: entitled[edition],
          licensed: true,
        })
      : (requested[edition] ?? localDefault)

  const selection = normalizeEditions({
    web: choose('web', true),
    mobile: choose('mobile', false),
    start: choose('start', false),
  })
  if (requested.web === false && selection.mobile) {
    throw new Error(
      'The mobile edition ships with the web foundation it runs on. Drop --no-web, or add --no-mobile.',
    )
  }
  if (selectedEditions(selection).length === 0) {
    throw new Error('Nothing to scaffold: every edition was excluded.')
  }
  return selection
}

async function downloadLicensedTemplate(
  target: string,
  licenseKey: string,
  requested: RequestedEditions,
  sourceVersion?: string,
  onDownloadProgress?: DownloadProgress,
): Promise<EditionSelection> {
  const baseUrl = deliveryBaseUrl()
  const index = await resolveRelease(licenseKey, baseUrl)
  const selection = chooseEditions(requested, entitledSelection(index))
  const releaseTag = sourceVersion ?? index.latest
  const {artifact, checksum: checksumName, manifest: manifestName} = releaseAssetNames(releaseTag)

  const temporaryDirectory = await mkdtemp(join(tmpdir(), `${CLI_NAME}-`))
  const extractedPath = join(temporaryDirectory, 'template')
  try {
    const archivePath = await downloadAsset(
      licenseKey,
      releaseTag,
      artifact,
      temporaryDirectory,
      baseUrl,
      onDownloadProgress,
    )
    await downloadAsset(licenseKey, releaseTag, checksumName, temporaryDirectory, baseUrl)
    await downloadAsset(licenseKey, releaseTag, manifestName, temporaryDirectory, baseUrl)

    const archive = await readFile(archivePath)
    const digest = createHash('sha256').update(archive).digest('hex')
    const checksum = await readFile(join(temporaryDirectory, checksumName), 'utf8')
    const manifest = JSON.parse(
      await readFile(join(temporaryDirectory, manifestName), 'utf8'),
    ) as ReleaseManifest
    verifyReleaseMetadata(checksum, manifest, artifact, digest, releaseTag)

    await mkdir(extractedPath)
    await execFileAsync('tar', ['-xzf', archivePath, '-C', extractedPath, '--strip-components=1'])
    await copyLocalTemplate(extractedPath, target)
    return selection
  } finally {
    await rm(temporaryDirectory, {recursive: true, force: true})
  }
}

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {withFileTypes: true})
  const paths: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error(`Generated template contains a symbolic link: ${path}`)
    }
    if (entry.isDirectory()) paths.push(...(await walk(path)))
    else if (entry.isFile()) paths.push(path)
  }
  return paths
}

async function rewriteFile(
  path: string,
  rewrite: (content: string) => {content: string; replacements: number},
): Promise<number> {
  const content = await readFile(path, 'utf8')
  const result = rewrite(content)
  if (result.replacements > 0) await writeFile(path, result.content)
  return result.replacements
}

async function applyScopeRewrite(target: string, scope: string): Promise<RewriteReport> {
  const report = {files: 0, replacements: 0}
  for (const path of await walk(target)) {
    if (!isScopeRewriteFile(path)) continue
    const replacements = await rewriteFile(path, content => {
      const result = rewriteScopeContent(content, scope)
      if (result.replacements > 0 && path.endsWith('/package.json')) {
        result.content = formatRewrittenPackageJson(result.content)
      }
      if (result.replacements > 0 && (path.endsWith('.ts') || path.endsWith('.tsx'))) {
        result.content = wrapLongNamedImports(result.content)
      }
      return result
    })
    if (replacements > 0) report.files += 1
    report.replacements += replacements
  }
  return report
}

async function applyBrandRewrite(target: string, brandName: string): Promise<RewriteReport> {
  const report = {files: 0, replacements: 0}
  for (const entry of [...BRAND_MANIFEST, ...START_BRAND_MANIFEST]) {
    const path = join(target, entry.path)
    if (!(await exists(path))) continue
    const replacements = await rewriteFile(path, content => {
      const result = rewriteBrandContent(content, brandName)
      if (result.replacements > 0 && path.endsWith('.tsx')) {
        result.content = wrapBrandedJsxText(result.content, brandName)
      }
      return result
    })
    if (replacements > 0) report.files += 1
    report.replacements += replacements
  }
  return report
}

async function rewriteJsonFile(path: string, rewrite: (content: string) => string) {
  await writeFile(path, rewrite(await readFile(path, 'utf8')))
}

async function exists(path: string): Promise<boolean> {
  return Boolean(await lstat(path).catch(() => undefined))
}

async function rewriteIfPresent(path: string, rewrite: (content: string) => string): Promise<void> {
  const content = await readFile(path, 'utf8').catch(() => undefined)
  if (content === undefined) return
  const rewritten = rewrite(content)
  if (rewritten !== content) await writeFile(path, rewritten)
}

async function markdownDocuments(target: string): Promise<string[]> {
  const pages = await readdir(join(target, 'docs'), {recursive: true}).catch(() => [] as string[])
  return [
    'AGENTS.md',
    ...pages.filter(page => page.endsWith('.md')).map(page => join('docs', page)),
  ]
}

async function applyMobileIdentity(
  target: string,
  appName: string,
  brandName: string,
  bundleIdentifier?: string,
  appDomain?: string,
): Promise<void> {
  const identity = deriveMobileIdentity(appName, brandName, bundleIdentifier, appDomain)

  await rewriteJsonFile(join(target, 'apps/mobile/app.json'), content =>
    rewriteMobileAppConfig(content, identity),
  )
  await rewriteFile(join(target, 'apps/server/.env.example'), content =>
    rewriteMobileAppScheme(content, identity.scheme),
  )
}

/**
 * A tier without the mobile edition must produce a project that installs and
 * verifies exactly like one that never had it, so every reference goes with the
 * directory: root scripts, the knip workspace, the docs page, its site entry and
 * every link to it, and the lockfile importer pnpm compares against the workspace on disk.
 */
async function removeMobileEdition(target: string): Promise<void> {
  for (const path of MOBILE_EDITION_PATHS) {
    await rm(join(target, path), {recursive: true, force: true})
  }

  await rewriteIfPresent(join(target, 'package.json'), stripMobileRootScripts)
  await rewriteIfPresent(join(target, 'knip.json'), stripMobileKnipWorkspace)
  await rewriteIfPresent(join(target, 'docs/meta.json'), stripMobileDocsPage)
  for (const page of await markdownDocuments(target)) {
    await rewriteIfPresent(join(target, page), stripMobileDocsReferences)
  }
  await rewriteIfPresent(join(target, 'apps/docs/lib/source.ts'), stripMobileDocsSource)
  await rewriteIfPresent(join(target, 'pnpm-lock.yaml'), content =>
    pruneLockfileImporters(content, ['apps/mobile']),
  )
}

async function removeStartEdition(target: string): Promise<void> {
  for (const path of START_EDITION_PATHS) {
    await rm(join(target, path), {recursive: true, force: true})
  }

  await rewriteIfPresent(join(target, 'knip.json'), content =>
    stripKnipWorkspaces(content, ['apps/start']),
  )
  for (const page of await markdownDocuments(target)) {
    await rewriteIfPresent(join(target, page), stripStartReferences)
  }
  await rewriteIfPresent(join(target, 'pnpm-lock.yaml'), content =>
    pruneLockfileImporters(content, ['apps/start']),
  )
}

async function pruneToKeptPaths(
  target: string,
  relativeDirectory: string,
  kept: ReadonlySet<string>,
  removedWorkspaces: string[],
): Promise<void> {
  for (const entry of await readdir(join(target, relativeDirectory))) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry}` : entry
    if (kept.has(relativePath)) continue
    if ([...kept].some(path => path.startsWith(`${relativePath}/`))) {
      await pruneToKeptPaths(target, relativePath, kept, removedWorkspaces)
      continue
    }
    if (relativeDirectory === 'apps' || relativeDirectory === 'packages') {
      removedWorkspaces.push(relativePath)
    }
    await rm(join(target, relativePath), {recursive: true, force: true})
  }
}

/**
 * The Start edition on its own is the Start app, the two workspace packages it
 * imports, and a root written for it. The root files live in the edition
 * overlay so they are reviewed as files rather than assembled from fragments.
 */
async function reduceToStartEdition(target: string): Promise<void> {
  const overlay = join(target, START_EDITION_OVERLAY)
  const overlayPackage = await readFile(join(overlay, 'package.json'), 'utf8')
  const rootPackage = await readFile(join(target, 'package.json'), 'utf8')

  const removedWorkspaces: string[] = []
  await pruneToKeptPaths(target, '', new Set(START_ONLY_KEPT_PATHS), removedWorkspaces)

  await cp(overlay, target, {recursive: true, force: true})
  await writeFile(join(target, 'package.json'), startOnlyRootPackage(rootPackage, overlayPackage))
  for (const [overlayName, rootName] of Object.entries(START_ROOT_CONTRACTS)) {
    await rename(join(target, overlayName), join(target, rootName))
  }
  await rm(overlay, {recursive: true, force: true})

  await rewriteIfPresent(join(target, 'knip.json'), content =>
    stripKnipWorkspaces(content, removedWorkspaces),
  )
  await rewriteIfPresent(join(target, 'pnpm-lock.yaml'), content =>
    pruneLockfileImporters(content, removedWorkspaces),
  )
}

async function isStartOnlyTree(target: string): Promise<boolean> {
  return (await exists(join(target, 'apps/start'))) && !(await exists(join(target, 'apps/server')))
}

/** @public */
export async function assembleEditions(
  target: string,
  selection: EditionSelection,
  {keepStartOverlay = false}: {keepStartOverlay?: boolean} = {},
): Promise<void> {
  if (!selection.mobile) await removeMobileEdition(target)
  if (!selection.start) await removeStartEdition(target)
  if (!selection.web && !(await isStartOnlyTree(target))) await reduceToStartEdition(target)
  if (!keepStartOverlay)
    await rm(join(target, START_EDITION_OVERLAY), {recursive: true, force: true})
}

async function applyStartIdentity(target: string, appName: string): Promise<void> {
  await rewriteIfPresent(join(target, 'apps/start/wrangler.jsonc'), content =>
    rewriteStartWorkerIdentifiers(content, appName),
  )
}

async function renameSiteWorker(target: string, appName: string): Promise<void> {
  await rewriteIfPresent(join(target, 'apps/site/wrangler.jsonc'), content =>
    rewriteSiteWorkerName(content, appName),
  )
}

async function renameFrontendWorker(target: string, appName: string): Promise<void> {
  const workerPath = join(target, 'apps/web/wrangler.toml')
  if (!(await stat(workerPath).catch(() => undefined))) return
  await rewriteFile(workerPath, content => rewriteWorkerName(content, appName))
}

async function generateStartEnvironment(target: string): Promise<void> {
  const example = await readFile(join(target, 'apps/start/.dev.vars.example'), 'utf8')
  await writeFile(join(target, 'apps/start/.dev.vars'), generateStartDevVars(example))
}

async function generateEnvironmentFiles(target: string, databasePort = 5432): Promise<void> {
  const serverExample = await readFile(join(target, 'apps/server/.env.example'), 'utf8')
  await writeFile(
    join(target, 'apps/server/.env'),
    generateServerEnv(serverExample, undefined, databasePort),
  )
  const webExample = await readFile(join(target, 'apps/web/.env.example'), 'utf8')
  await writeFile(join(target, 'apps/web/.env'), webExample)
  const docsExample = await readFile(join(target, 'apps/docs/.env.example'), 'utf8')
  await writeFile(join(target, 'apps/docs/.env'), docsExample)
  await writeFile(join(target, '.env'), `POSTGRES_PORT=${databasePort}\n`)
}

async function neutralizeAgentInstructions(target: string): Promise<void> {
  const agentPath = join(target, 'AGENTS.md')
  const claudePath = join(target, 'CLAUDE.md')
  const readmePath = join(target, 'README.md')
  await writeFile(agentPath, rewriteBuyerAgentInstructions(await readFile(agentPath, 'utf8')))
  await writeFile(claudePath, rewriteBuyerClaudeInstructions(await readFile(claudePath, 'utf8')))
  await writeFile(readmePath, stripDistributionReadmeBootstrap(await readFile(readmePath, 'utf8')))

  const rootPackagePath = join(target, 'package.json')
  await writeFile(
    rootPackagePath,
    stripSellerOnlyRootScripts(await readFile(rootPackagePath, 'utf8')),
  )
}

async function neutralizeSourceCli(
  target: string,
  scope: string,
  brandName: string,
): Promise<void> {
  if (String(CLI_NAME) === BUYER_CLI_NAME && String(CLI_PACKAGE_NAME) === BUYER_CLI_PACKAGE_NAME)
    return

  const rootPackagePath = join(target, 'package.json')
  const rootPackage = JSON.parse(await readFile(rootPackagePath, 'utf8')) as {
    scripts?: Record<string, string>
  }
  const sourceScript = rootPackage.scripts?.[CLI_NAME]
  if (!sourceScript) throw new Error(`Root package is missing the ${CLI_NAME} script.`)
  rootPackage.scripts![BUYER_CLI_NAME] = sourceScript
  delete rootPackage.scripts![CLI_NAME]
  await writeFile(rootPackagePath, `${JSON.stringify(rootPackage, null, 2)}\n`)

  const cliPackagePath = join(target, 'packages/create-app/package.json')
  const cliPackage = JSON.parse(await readFile(cliPackagePath, 'utf8')) as {
    name?: string
    version?: string
    private?: boolean
    bin?: Record<string, string>
    description?: string
    homepage?: string
    bugs?: unknown
    author?: unknown
    repository?: unknown
    keywords?: string[]
    files?: string[]
    publishConfig?: unknown
  }
  if (cliPackage.name !== CLI_PACKAGE_NAME || !cliPackage.bin?.[CLI_NAME]) {
    throw new Error(`Source CLI package must expose ${CLI_PACKAGE_NAME} as ${CLI_NAME}.`)
  }
  cliPackage.bin = {[BUYER_CLI_NAME]: './src/cli.ts'}
  delete cliPackage.description
  delete cliPackage.homepage
  delete cliPackage.bugs
  delete cliPackage.author
  delete cliPackage.repository
  delete cliPackage.keywords
  delete cliPackage.files
  delete cliPackage.publishConfig
  const {name: _sourceName, version: cliVersion, ...cliPackageRemainder} = cliPackage
  await writeFile(
    cliPackagePath,
    `${JSON.stringify(
      {name: BUYER_CLI_PACKAGE_NAME, version: cliVersion, private: true, ...cliPackageRemainder},
      null,
      2,
    )}\n`,
  )

  const constantsPath = join(target, 'packages/create-app/src/constants.ts')
  await writeFile(
    constantsPath,
    rewriteBuyerCliConstants(await readFile(constantsPath, 'utf8'), scope, brandName),
  )

  const brandingPath = join(target, 'docs/golden-paths/customize-branding-design-tokens.md')
  const branding = await readFile(brandingPath, 'utf8')
  await writeFile(brandingPath, branding.replaceAll(`pnpm ${CLI_NAME}`, `pnpm ${BUYER_CLI_NAME}`))

  const setupPath = join(target, 'docs/setup.md')
  await writeFile(setupPath, rewriteBuyerSetupInstructions(await readFile(setupPath, 'utf8')))
  const releasesPath = join(target, 'docs/releases.md')
  await writeFile(
    releasesPath,
    rewriteBuyerReleaseInstructions(await readFile(releasesPath, 'utf8')),
  )
}

async function initializeRepository(target: string): Promise<void> {
  await execFileAsync('git', ['init'], {cwd: target})
  await execFileAsync('git', ['add', '-A'], {cwd: target})
  await execFileAsync(
    'git',
    [
      '-c',
      `user.name=${CLI_NAME}`,
      '-c',
      `user.email=${CLI_NAME}@localhost`,
      'commit',
      '-m',
      'Initial commit',
    ],
    {cwd: target},
  )
}

export async function scaffold(options: ScaffoldOptions): Promise<ScaffoldReport> {
  const target = resolve(options.targetDirectory)
  await assertEmptyTarget(target)

  try {
    const requested: RequestedEditions = {
      web: options.includeWeb,
      mobile: options.includeMobile,
      start: options.includeStart,
    }
    let selection: EditionSelection
    if (options.from) {
      selection = chooseEditions(requested, undefined)
      await copyLocalTemplate(options.from, target)
    } else if (options.licenseKey) {
      selection = await downloadLicensedTemplate(
        target,
        options.licenseKey,
        requested,
        options.sourceVersion,
        options.onDownloadProgress,
      )
    } else {
      throw new Error(`A local source path or a ${CLI_NAME} licence key is required.`)
    }

    await assembleEditions(target, selection)
    if (selection.mobile) {
      await applyMobileIdentity(
        target,
        options.appName,
        options.brandName,
        options.mobileBundleIdentifier,
        options.mobileAppDomain,
      )
    }
    if (selection.start) await applyStartIdentity(target, options.appName)

    const packagePath = join(target, 'package.json')
    const packageReplacements = await rewriteFile(packagePath, content =>
      rewriteRootPackageName(content, options.appName),
    )
    await renameFrontendWorker(target, options.appName)
    await renameSiteWorker(target, options.appName)
    const scope = await applyScopeRewrite(target, options.scope)
    if (selection.web) {
      await neutralizeAgentInstructions(target)
      await neutralizeSourceCli(target, options.scope, options.brandName)
    }
    const brand = await applyBrandRewrite(target, options.brandName)
    if (selection.web) await generateEnvironmentFiles(target, options.databasePort)
    if (selection.start) await generateStartEnvironment(target)
    if (options.initializeGit) await initializeRepository(target)

    return {
      targetDirectory: target,
      packageName: {files: packageReplacements > 0 ? 1 : 0, replacements: packageReplacements},
      scope,
      brand,
      editions: selectedEditions(selection),
      mobile: selection.mobile,
    }
  } catch (error) {
    if ((await stat(target).catch(() => undefined))?.isDirectory()) {
      const entries = await readdir(target)
      if (entries.length === 0) await rm(target, {recursive: true, force: true})
    }
    throw error
  }
}

export function formatReport(label: string, report: RewriteReport): string {
  return `${label}: ${report.replacements} replacement(s) across ${report.files} file(s)`
}

export function relativeTarget(target: string, cwd = process.cwd()): string {
  const path = relative(cwd, target)
  return path && !path.startsWith('..') ? path : basename(target)
}
