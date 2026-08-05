import {execFile} from 'node:child_process'
import {createHash} from 'node:crypto'
import {cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename, join, relative, resolve} from 'node:path'
import {promisify} from 'node:util'

import {BUYER_CLI_NAME, BUYER_CLI_PACKAGE_NAME, CLI_NAME, CLI_PACKAGE_NAME} from './constants.js'
import {deliveryBaseUrl, downloadAsset, releaseAssetNames, resolveRelease} from './delivery.js'
import {
  BRAND_MANIFEST,
  formatRewrittenPackageJson,
  generateServerEnv,
  isScopeRewriteFile,
  isTemplatePathExcluded,
  rewriteBuyerAgentInstructions,
  rewriteBuyerClaudeInstructions,
  rewriteBuyerCliConstants,
  stripSellerOnlyRootScripts,
  rewriteBuyerReleaseInstructions,
  rewriteBuyerSetupInstructions,
  rewriteBrandContent,
  rewriteRootPackageName,
  rewriteScopeContent,
  wrapBrandedJsxText,
  wrapLongNamedImports,
  type RewriteReport,
} from './core.js'

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
}

export interface ScaffoldReport {
  targetDirectory: string
  packageName: RewriteReport
  scope: RewriteReport
  brand: RewriteReport
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

async function copyLocalTemplate(source: string, target: string): Promise<void> {
  const sourceDirectory = resolve(source)
  const sourceStat = await lstat(sourceDirectory).catch(() => undefined)
  if (!sourceStat?.isDirectory())
    throw new Error(`Template path is not a directory: ${sourceDirectory}`)

  await assertNoSymbolicLinks(sourceDirectory, sourceDirectory, true)
  await mkdir(target, {recursive: true})
  await cp(sourceDirectory, target, {
    recursive: true,
    filter: path => {
      const relativePath = relative(sourceDirectory, path)
      return relativePath === '' || !isTemplatePathExcluded(relativePath)
    },
  })
  await assertNoSymbolicLinks(target)
}

async function assertNoSymbolicLinks(
  directory: string,
  root = directory,
  skipExcludedPaths = false,
): Promise<void> {
  const entries = await readdir(directory, {withFileTypes: true})
  for (const entry of entries) {
    const path = join(directory, entry.name)
    const relativePath = relative(root, path)
    if (skipExcludedPaths && isTemplatePathExcluded(relativePath)) continue
    if (entry.isSymbolicLink()) {
      throw new Error(`Template contains a symbolic link, which is not supported: ${path}`)
    }
    if (entry.isDirectory()) await assertNoSymbolicLinks(path, root, skipExcludedPaths)
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
  const checksumMatch = checksum.trim().match(/^([a-f0-9]{64})\s+\*?([^\s]+)$/i)
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

async function downloadLicensedTemplate(
  target: string,
  licenseKey: string,
  sourceVersion?: string,
): Promise<void> {
  const baseUrl = deliveryBaseUrl()
  const releaseTag = sourceVersion ?? (await resolveRelease(licenseKey, baseUrl)).latest
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
  for (const entry of BRAND_MANIFEST) {
    const path = join(target, entry.path)
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
  await writeFile(agentPath, rewriteBuyerAgentInstructions(await readFile(agentPath, 'utf8')))
  await writeFile(claudePath, rewriteBuyerClaudeInstructions(await readFile(claudePath, 'utf8')))

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
    if (options.from) await copyLocalTemplate(options.from, target)
    else if (options.licenseKey) {
      await downloadLicensedTemplate(target, options.licenseKey, options.sourceVersion)
    } else {
      throw new Error(`A local source path or a ${CLI_NAME} licence key is required.`)
    }

    const packagePath = join(target, 'package.json')
    const packageReplacements = await rewriteFile(packagePath, content =>
      rewriteRootPackageName(content, options.appName),
    )
    const scope = await applyScopeRewrite(target, options.scope)
    await neutralizeAgentInstructions(target)
    await neutralizeSourceCli(target, options.scope, options.brandName)
    const brand = await applyBrandRewrite(target, options.brandName)
    await generateEnvironmentFiles(target, options.databasePort)
    if (options.initializeGit) await initializeRepository(target)

    return {
      targetDirectory: target,
      packageName: {files: packageReplacements > 0 ? 1 : 0, replacements: packageReplacements},
      scope,
      brand,
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
