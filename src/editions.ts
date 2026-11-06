import {stringifyRepositoryJson} from './core.js'

const NON_INDENTED_LINE_RE = /^\S/
const IMPORTER_KEY_LINE_RE = /^ {2}(\S[^:]*):\s*$/
const EXTRA_BLANK_LINES_RE = /\n{3,}/g
const START_TABLE_ROW_RE = /^\| `apps\/start` .*\n/gm
const START_PARAGRAPH_RE = /^`apps\/start`[\s\S]*?(?:\n\n|\n?(?![\s\S]))/gm
const WORKER_NAME_FIELD_RE = /("name":\s*")[^"]+(")/
const DATABASE_NAME_FIELD_RE = /("database_name":\s*")[^"]+(")/

export const EDITION_NAMES = ['web', 'mobile', 'start'] as const

export type EditionName = (typeof EDITION_NAMES)[number]

export type EditionSelection = Record<EditionName, boolean>

export const START_EDITION_PATHS = ['apps/start', '.github/workflows/deploy-start.yml'] as const

export const START_EDITION_OVERLAY = 'apps/start/edition'

export const START_ROOT_CONTRACTS = {
  'ROOT-AGENTS.md': 'AGENTS.md',
  'ROOT-CLAUDE.md': 'CLAUDE.md',
} as const

export const START_ONLY_KEPT_PATHS = [
  'apps/start',
  'apps/site',
  'packages/billing',
  'packages/tsconfig',
  '.github/workflows/deploy-start.yml',
  '.gitattributes',
  '.gitignore',
  '.node-version',
  'LICENSE',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'vite.config.ts',
  'knip.json',
] as const

export function isEditionName(value: string): value is EditionName {
  return (EDITION_NAMES as readonly string[]).includes(value)
}

export function normalizeEditions(selection: EditionSelection): EditionSelection {
  return {...selection, web: selection.web || selection.mobile}
}

export function hasFoundation(selection: EditionSelection): boolean {
  return normalizeEditions(selection).web
}

export function selectedEditions(selection: EditionSelection): EditionName[] {
  const normalized = normalizeEditions(selection)
  return EDITION_NAMES.filter(name => normalized[name])
}

export function editionVariant(selection: EditionSelection): string {
  const names = selectedEditions(selection)
  if (names.length === 0) throw new Error('An edition variant needs at least one edition.')
  return names.join('-')
}

export const RELEASE_VARIANTS: readonly EditionSelection[] = [
  {web: true, mobile: false, start: false},
  {web: true, mobile: true, start: false},
  {web: false, mobile: false, start: true},
  {web: true, mobile: false, start: true},
  {web: true, mobile: true, start: true},
]

export function selectionFromEditions(editions: readonly string[]): EditionSelection {
  return normalizeEditions({
    web: editions.includes('web'),
    mobile: editions.includes('mobile'),
    start: editions.includes('start'),
  })
}

/**
 * pnpm compares lockfile importers against the workspace projects on disk, so a
 * removed package must lose its importer block or `--frozen-lockfile` fails. Only
 * the importer is removed; pnpm prunes the now-unreachable package entries itself.
 */
export function pruneLockfileImporters(
  content: string,
  removedImporters: readonly string[],
): string {
  if (removedImporters.length === 0) return content
  const removed = new Set(removedImporters)
  const lines = content.split('\n')
  const output: string[] = []
  let inImporters = false
  let skipping = false

  for (const line of lines) {
    if (NON_INDENTED_LINE_RE.test(line)) {
      inImporters = line === 'importers:'
      skipping = false
      output.push(line)
      continue
    }
    if (inImporters) {
      const importer = line.match(IMPORTER_KEY_LINE_RE)?.[1]
      if (importer !== undefined) skipping = removed.has(importer)
      if (skipping) continue
    }
    output.push(line)
  }

  return output.join('\n').replace(EXTRA_BLANK_LINES_RE, '\n\n')
}

export function stripKnipWorkspaces(content: string, removedWorkspaces: readonly string[]): string {
  const parsed = JSON.parse(content) as {
    workspaces?: Record<string, unknown>
    ignoreWorkspaces?: string[]
  }
  for (const workspace of removedWorkspaces) delete parsed.workspaces?.[workspace]
  if (parsed.ignoreWorkspaces) {
    parsed.ignoreWorkspaces = parsed.ignoreWorkspaces.filter(
      workspace => !removedWorkspaces.includes(workspace),
    )
  }
  return `${stringifyRepositoryJson(parsed)}\n`
}

export function stripStartReferences(content: string): string {
  return content.replace(START_TABLE_ROW_RE, '').replace(START_PARAGRAPH_RE, '')
}

export function rewriteStartWorkerIdentifiers(content: string, appName: string): string {
  return content
    .replace(WORKER_NAME_FIELD_RE, `$1${appName}$2`)
    .replace(DATABASE_NAME_FIELD_RE, `$1${appName}$2`)
}

export function startOnlyRootPackage(rootPackage: string, overlayPackage: string): string {
  const root = JSON.parse(rootPackage) as Record<string, unknown>
  const overlay = JSON.parse(overlayPackage) as {scripts: Record<string, string>}
  return `${JSON.stringify({...root, scripts: overlay.scripts}, null, 2)}\n`
}
