import {randomBytes} from 'node:crypto'
import {extname} from 'node:path'

import {
  BUYER_CLI_NAME,
  BUYER_CLI_PACKAGE_NAME,
  CLI_NAME,
  CLI_PACKAGE_NAME,
  DEFAULT_SCOPE,
  DELIVERY_BASE_URL,
  DELIVERY_URL_VARIABLE,
  DOCS_BASE_URL,
  LICENSE_KEY_PREFIX,
  LICENSE_KEY_VARIABLE,
  SOURCE_BRAND_NAME,
} from './constants.js'

const KEBAB_CASE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const WHITESPACE_CHAR_RE = /\s/
const NPM_SCOPE_RE = /^@[a-z0-9][a-z0-9._-]*$/
const NEWLINE_CHAR_RE = /\r|\n/
const BRAND_NAME_RE = /^[\p{L}\p{N}](?:[\p{L}\p{N} ._-]*[\p{L}\p{N}])?$/u
const REGEX_SPECIAL_CHARS_RE = /[.*+?^${}()|[\]\\]/g
const NON_ALPHANUMERIC_CHAR_RE = /[^a-z0-9]/g
const LEADING_DIGIT_RE = /^[0-9]/
const HTTP_PROTOCOL_RE = /^https?:\/\//
const APP_DOMAIN_RE =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/
const BUNDLE_IDENTIFIER_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){2,}$/
const MOBILE_APP_SCHEME_LINE_RE = /^MOBILE_APP_SCHEME=.*$/m
const MOBILE_DOCS_SOURCE_LINE_RE = /^\s*'mobile\.md',\n/m
const MOBILE_EDITION_SECTION_RE = /^## Mobile edition\n[\s\S]*?(?=^## |(?![\s\S]))/m
const MOBILE_TABLE_ROW_RE = /^\| `apps\/mobile` .*\n/gm
const MOBILE_PARAGRAPH_RE = /^`apps\/mobile`[\s\S]*?(?:\n\n|\n?(?![\s\S]))/gm
const MOBILE_DOCS_LINK_RE = /\[([^\]]+)\]\(\.\/mobile\.md(?:#[^)]*)?\)/g
const NAMED_IMPORT_LINE_RE =
  /^(\s*)(import(?:\s+type)?\s+(?:[\w$]+,\s*)?)\{([^}]+)\}(\s+from\s+.+)$/
const WHITESPACE_RE = /\s+/
const INTERNAL_AGENT_REFERENCE_RE = /internal\/|landing\/|seller-surface|studio-owned/i
const INTERNAL_CLAUDE_REFERENCE_RE = /internal\/|landing\/|studio-owned/i
const BETTER_AUTH_SECRET_LINE_RE = /^BETTER_AUTH_SECRET=.*$/m
const HEX_64_RE = /^[a-f0-9]{64}$/
const DATABASE_URL_LINE_RE = /^DATABASE_URL=.*$/m
const GHA_CREDS_FILE_RE = /^gha-creds-.*\.json$/

const ESCAPED_SOURCE_BRAND = SOURCE_BRAND_NAME.replace(REGEX_SPECIAL_CHARS_RE, '\\$&')
const SOURCE_BRAND_RE = new RegExp(`\\b${ESCAPED_SOURCE_BRAND}\\b`, 'gi')
const ESCAPED_CLI_NAME = CLI_NAME.replace(REGEX_SPECIAL_CHARS_RE, '\\$&')
const SOURCE_DELIVERY_GUIDANCE_RE = new RegExp(
  `pnpm dlx ${ESCAPED_CLI_NAME}|bunx ${ESCAPED_CLI_NAME}|${ESCAPED_CLI_NAME} repository`,
  'i',
)
const VENDOR_BOOTSTRAPPER_GUIDANCE_RE = new RegExp(
  `${ESCAPED_CLI_NAME}@\\d|public \`${ESCAPED_CLI_NAME}\` npm package`,
  'i',
)

export interface BrandManifestEntry {
  path: string
  occurrences: number
}

export const BRAND_MANIFEST: readonly BrandManifestEntry[] = [
  {path: 'apps/web/src/configs/config.ts', occurrences: 2},
  {path: 'apps/web/index.html', occurrences: 4},
  {path: 'apps/web/public/favicon/site.webmanifest', occurrences: 2},
  {path: 'apps/web/public/offline.html', occurrences: 6},
  {path: 'apps/docs/lib/shared.ts', occurrences: 1},
  {path: 'apps/site/src/site.ts', occurrences: 1},
  {path: 'apps/docs/README.md', occurrences: 1},
  {path: 'README.md', occurrences: 1},
  {path: 'docs/meta.json', occurrences: 1},
  {path: 'apps/server/.env.example', occurrences: 1},
  {path: 'apps/server/src/config/env.ts', occurrences: 2},
  {path: 'apps/server/src/config/env.test.ts', occurrences: 1},
  {path: 'packages/email/src/billing-payment-failed.tsx', occurrences: 2},
  {path: 'packages/email/src/login-email.tsx', occurrences: 3},
  {path: 'packages/email/src/verify-email.tsx', occurrences: 1},
  {path: 'packages/email/src/reset-password.tsx', occurrences: 1},
  {path: 'packages/email/src/security-alert.tsx', occurrences: 1},
  {path: 'packages/email/src/components/EmailSignature.tsx', occurrences: 1},
  {path: 'packages/email/src/components/EmailLayout.tsx', occurrences: 1},
  {path: 'packages/email/src/components/EmailCopyright.tsx', occurrences: 1},
  {path: 'packages/email/src/welcome-email.tsx', occurrences: 4},
  {path: 'packages/email/src/billing-payment-successful.tsx', occurrences: 1},
  {path: 'packages/email/src/billing-subscription-created.tsx', occurrences: 2},
  {path: 'packages/email/src/billing-subscription-canceled.tsx', occurrences: 2},
  {path: 'apps/server/email-templates/billing-payment-failed.html', occurrences: 6},
  {path: 'apps/server/email-templates/billing-payment-successful.html', occurrences: 5},
  {path: 'apps/server/email-templates/billing-subscription-canceled.html', occurrences: 6},
  {path: 'apps/server/email-templates/billing-subscription-created.html', occurrences: 6},
  {path: 'apps/server/email-templates/login-email.html', occurrences: 7},
  {path: 'apps/server/email-templates/security-alert.html', occurrences: 4},
  {path: 'apps/server/email-templates/verify-email.html', occurrences: 5},
  {path: 'apps/server/email-templates/reset-password.html', occurrences: 5},
  {path: 'apps/server/email-templates/organization-invitation.html', occurrences: 3},
  {path: 'apps/server/email-templates/welcome-email.html', occurrences: 8},
] as const

export const START_BRAND_MANIFEST: readonly BrandManifestEntry[] = [
  {path: 'apps/start/AGENTS.md', occurrences: 1},
  {path: 'apps/start/README.md', occurrences: 1},
  {path: 'apps/start/src/server/config.ts', occurrences: 2},
  {path: 'apps/start/src/shared/site.ts', occurrences: 1},
  {path: 'apps/start/wrangler.jsonc', occurrences: 2},
  {path: 'apps/start/worker-configuration.d.ts', occurrences: 2},
] as const

/**
 * Everything the mobile edition owns. A tier without it must lose all of these and
 * leave no reference behind: a dangling workspace entry or docs page would break the
 * buyer's first `vp install --frozen-lockfile`.
 */
export const MOBILE_EDITION_PATHS = ['apps/mobile', 'docs/mobile.md'] as const

export interface MobileIdentity {
  displayName: string
  slug: string
  scheme: string
  bundleIdentifier: string
  appDomain?: string
}

export const UNIVERSAL_LINK_PATH_PREFIXES = ['/auth', '/invitations'] as const

export interface RewriteResult {
  content: string
  replacements: number
}

export interface RewriteReport {
  files: number
  replacements: number
}

export function validateAppName(value: string): string | undefined {
  if (!value) return 'App name is required.'
  if (!KEBAB_CASE_RE.test(value)) {
    return 'App name must be kebab-case (lowercase letters, numbers, and single hyphens).'
  }
  return undefined
}

export function normalizeScope(value: string): string {
  const scope = value.startsWith('@') ? value : `@${value}`
  if (WHITESPACE_CHAR_RE.test(scope)) {
    throw new Error('Use hyphens instead of spaces, for example test-package.')
  }
  if (!NPM_SCOPE_RE.test(scope)) {
    throw new Error(
      'Use lowercase letters and numbers, with optional periods, underscores, or hyphens.',
    )
  }
  return scope
}

export function validateBrandName(value: string): string | undefined {
  if (!value.trim()) return 'Brand name cannot be empty.'
  if (NEWLINE_CHAR_RE.test(value)) return 'Brand name must fit on one line.'
  if (value !== value.trim()) return 'Brand name cannot start or end with whitespace.'
  if (value.length > 48) return 'Brand name must be 48 characters or less.'
  if (!BRAND_NAME_RE.test(value)) {
    return 'Brand name may contain letters, numbers, spaces, periods, underscores, and hyphens.'
  }
  return undefined
}

export function replaceLiteral(
  content: string,
  search: string,
  replacement: string,
): RewriteResult {
  if (search === replacement || !content.includes(search)) return {content, replacements: 0}
  const parts = content.split(search)
  return {content: parts.join(replacement), replacements: parts.length - 1}
}

export function rewriteScopeContent(
  content: string,
  scope: string,
  originalScope = DEFAULT_SCOPE,
): RewriteResult {
  return replaceLiteral(content, `${originalScope}/`, `${normalizeScope(scope)}/`)
}

export function rewriteBrandContent(content: string, brandName: string): RewriteResult {
  const error = validateBrandName(brandName)
  if (error) throw new Error(error)
  const matches = content.match(SOURCE_BRAND_RE)
  if (brandName === SOURCE_BRAND_NAME || !matches) return {content, replacements: 0}
  return {
    content: content.replace(SOURCE_BRAND_RE, () => brandName),
    replacements: matches.length,
  }
}

/**
 * A URI scheme and an Android package segment are identifiers, not display text.
 * The brand rewrite maps a source literal to an arbitrary display name, so
 * "My App" would produce `My App://` and an invalid package name; both are derived
 * from the validated kebab-case app name instead.
 */
export function mobileSchemeFor(appName: string): string {
  const error = validateAppName(appName)
  if (error) throw new Error(error)
  return appName
}

export function androidPackageSegment(appName: string): string {
  const segment = appName.replace(NON_ALPHANUMERIC_CHAR_RE, '')
  return LEADING_DIGIT_RE.test(segment) || !segment ? `app${segment}` : segment
}

export function validateAppDomain(value: string): string | undefined {
  if (!value.trim()) return 'Application domain cannot be empty.'
  if (HTTP_PROTOCOL_RE.test(value)) return 'Use a bare host such as app.example.com, not a URL.'
  if (value.includes('/')) return 'Use a bare host such as app.example.com, with no path.'
  if (!APP_DOMAIN_RE.test(value)) {
    return 'Use a lowercase hostname with at least two labels, for example app.example.com.'
  }
  return undefined
}

export function validateBundleIdentifier(value: string): string | undefined {
  if (!value.trim()) return 'Bundle identifier cannot be empty.'
  if (!BUNDLE_IDENTIFIER_RE.test(value)) {
    return 'Use at least three lowercase reverse-DNS segments, for example com.example.app.'
  }
  return undefined
}

export function deriveMobileIdentity(
  appName: string,
  brandName: string,
  bundleIdentifier?: string,
  appDomain?: string,
): MobileIdentity {
  const brandError = validateBrandName(brandName)
  if (brandError) throw new Error(brandError)

  const resolvedBundleId = bundleIdentifier ?? `com.${androidPackageSegment(appName)}.app`
  const bundleError = validateBundleIdentifier(resolvedBundleId)
  if (bundleError) throw new Error(bundleError)

  const domain = appDomain?.trim().toLowerCase()
  if (domain) {
    const domainError = validateAppDomain(domain)
    if (domainError) throw new Error(domainError)
  }

  return {
    displayName: brandName,
    slug: appName,
    scheme: mobileSchemeFor(appName),
    bundleIdentifier: resolvedBundleId,
    ...(domain ? {appDomain: domain} : {}),
  }
}

export function universalLinkConfig(domain: string): {
  associatedDomains: string[]
  intentFilters: unknown[]
} {
  return {
    associatedDomains: [`applinks:${domain}`],
    intentFilters: [
      {
        action: 'VIEW',
        autoVerify: true,
        category: ['BROWSABLE', 'DEFAULT'],
        data: UNIVERSAL_LINK_PATH_PREFIXES.map(pathPrefix => ({
          scheme: 'https',
          host: domain,
          pathPrefix,
        })),
      },
    ],
  }
}

/**
 * Rewrites the Expo configuration as JSON rather than by text substitution: the
 * display name is brand text while the slug, scheme, and identifiers are not, and
 * a case-insensitive word replace cannot tell them apart. Any inherited EAS
 * project or update URL is dropped — the buyer claims their own with `eas init`.
 */
export function rewriteMobileAppConfig(content: string, identity: MobileIdentity): string {
  const parsed = JSON.parse(content) as {
    expo: Record<string, unknown> & {
      ios?: Record<string, unknown>
      android?: Record<string, unknown>
      extra?: Record<string, unknown>
      updates?: unknown
    }
  }
  const {expo} = parsed
  if (!expo) throw new Error('Expo configuration is missing its "expo" block.')

  expo.name = identity.displayName
  expo.slug = identity.slug
  expo.scheme = identity.scheme
  if (expo.ios) expo.ios.bundleIdentifier = identity.bundleIdentifier
  if (expo.android) expo.android.package = identity.bundleIdentifier

  const links = identity.appDomain ? universalLinkConfig(identity.appDomain) : undefined
  if (expo.ios) {
    if (links) expo.ios.associatedDomains = links.associatedDomains
    else delete expo.ios.associatedDomains
  }
  if (expo.android) {
    if (links) expo.android.intentFilters = links.intentFilters
    else delete expo.android.intentFilters
  }

  delete expo.updates
  delete expo.owner
  if (expo.extra && typeof expo.extra === 'object') delete (expo.extra as {eas?: unknown}).eas

  return `${stringifyRepositoryJson(parsed)}\n`
}

export function rewriteMobileAppScheme(content: string, scheme: string): RewriteResult {
  if (!MOBILE_APP_SCHEME_LINE_RE.test(content)) {
    throw new Error('Server .env.example must contain a MOBILE_APP_SCHEME entry.')
  }
  return {
    content: content.replace(MOBILE_APP_SCHEME_LINE_RE, `MOBILE_APP_SCHEME=${scheme}`),
    replacements: 1,
  }
}

const JSON_PRINT_WIDTH = 100

function isJsonPrimitive(value: unknown): boolean {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value)
}

/**
 * `JSON.stringify(_, null, 2)` is the right shape for a `package.json`, which the
 * repository formatter prints with its stringify parser, but not for any other
 * JSON file: there, an array of primitives that fits the print width stays on one
 * line. Rewriting a `.json` file with plain stringify therefore leaves the buyer's
 * project failing its own `vp check`.
 */
export function stringifyRepositoryJson(value: unknown, indent = 0, column = 0): string {
  const pad = ' '.repeat(indent)
  const innerPad = ' '.repeat(indent + 2)

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    if (value.every(isJsonPrimitive)) {
      const inline = `[${value.map(item => JSON.stringify(item)).join(', ')}]`
      if (column + inline.length <= JSON_PRINT_WIDTH) return inline
    }
    const items = value.map(
      item => `${innerPad}${stringifyRepositoryJson(item, indent + 2, indent + 2)}`,
    )
    return `[\n${items.join(',\n')}\n${pad}]`
  }

  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
    if (entries.length === 0) return '{}'
    const items = entries.map(([key, item]) => {
      const label = `${JSON.stringify(key)}: `
      return `${innerPad}${label}${stringifyRepositoryJson(item, indent + 2, indent + 2 + label.length)}`
    })
    return `{\n${items.join(',\n')}\n${pad}}`
  }

  return JSON.stringify(value)
}

export function stripMobileRootScripts(content: string): string {
  const parsed = JSON.parse(content) as {scripts?: Record<string, string>}
  if (parsed.scripts) {
    delete parsed.scripts['dev:mobile']
    delete parsed.scripts['build:mobile']
  }
  return `${JSON.stringify(parsed, null, 2)}\n`
}

export function stripMobileKnipWorkspace(content: string): string {
  const parsed = JSON.parse(content) as {workspaces?: Record<string, unknown>}
  if (parsed.workspaces) delete parsed.workspaces['apps/mobile']
  return `${stringifyRepositoryJson(parsed)}\n`
}

export function stripMobileDocsPage(content: string): string {
  const parsed = JSON.parse(content) as {pages?: string[]}
  if (Array.isArray(parsed.pages)) {
    parsed.pages = parsed.pages.filter(page => page !== 'mobile')
  }
  return `${stringifyRepositoryJson(parsed)}\n`
}

export function stripMobileDocsSource(content: string): string {
  return content.replace(MOBILE_DOCS_SOURCE_LINE_RE, '')
}

export function stripMobileDocsReferences(content: string): string {
  return content
    .replace(MOBILE_EDITION_SECTION_RE, '')
    .replace(MOBILE_TABLE_ROW_RE, '')
    .replace(MOBILE_PARAGRAPH_RE, '')
    .replace(MOBILE_DOCS_LINK_RE, '$1')
}

export function formatRewrittenPackageJson(content: string): string {
  const parsed = JSON.parse(content) as Record<string, unknown>
  for (const key of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    const values = parsed[key]
    if (values && typeof values === 'object' && !Array.isArray(values)) {
      parsed[key] = Object.fromEntries(
        Object.entries(values).sort(([left], [right]) => left.localeCompare(right)),
      )
    }
  }
  return `${JSON.stringify(parsed, null, 2)}\n`
}

export function wrapLongNamedImports(content: string, width = 100): string {
  return content
    .split('\n')
    .map(line => {
      if (line.length <= width) return line
      const match = line.match(NAMED_IMPORT_LINE_RE)
      if (!match) return line
      const [, indentation = '', prefix = '', names = '', suffix = ''] = match
      const members = names.split(',').map(name => name.trim())
      if (members.length === 1 && !prefix.includes(',')) return line
      return [
        `${indentation}${prefix}{`,
        ...members.map(name => `${indentation}  ${name},`),
        `${indentation}}${suffix}`,
      ].join('\n')
    })
    .join('\n')
}

export function wrapBrandedJsxText(content: string, brandName: string, width = 100): string {
  const lines = content.split('\n')
  const output: string[] = []
  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? ''
    const text = line.trim()
    if (
      !text ||
      text.startsWith('<') ||
      text.startsWith('{') ||
      text.startsWith('//') ||
      text.includes('<') ||
      text.includes('>')
    ) {
      output.push(line)
      index += 1
      continue
    }

    const paragraph: string[] = []
    const originalParagraph: string[] = []
    const indentation = line.slice(0, line.length - line.trimStart().length)
    while (index < lines.length) {
      const candidate = lines[index] ?? ''
      const candidateText = candidate.trim()
      if (!candidateText || candidateText.startsWith('<') || candidateText.startsWith('{')) break
      paragraph.push(candidateText)
      originalParagraph.push(candidate)
      index += 1
    }
    const joined = paragraph.join(' ')
    if (!joined.includes(brandName)) {
      output.push(...originalParagraph)
      continue
    }

    let current = indentation
    for (const word of joined.split(WHITESPACE_RE)) {
      const candidate = current === indentation ? `${indentation}${word}` : `${current} ${word}`
      if (candidate.length > width && current !== indentation) {
        output.push(current)
        current = `${indentation}${word}`
      } else current = candidate
    }
    output.push(current)
  }
  return output.join('\n')
}

export function rewriteRootPackageName(content: string, appName: string): RewriteResult {
  const error = validateAppName(appName)
  if (error) throw new Error(error)
  const parsed = JSON.parse(content) as Record<string, unknown>
  if (parsed.name === appName) return {content, replacements: 0}
  parsed.name = appName
  return {content: `${JSON.stringify(parsed, null, 2)}\n`, replacements: 1}
}

const WORKER_NAME_DECLARATION = /^name = "[^"]*"$/m

export function rewriteWorkerName(content: string, appName: string): RewriteResult {
  const error = validateAppName(appName)
  if (error) throw new Error(error)
  const declaration = content.match(WORKER_NAME_DECLARATION)?.[0]
  if (!declaration) {
    throw new Error('Cloudflare Worker configuration is missing a name declaration.')
  }
  const replacement = `name = "${appName}"`
  if (declaration === replacement) return {content, replacements: 0}
  return {content: content.replace(WORKER_NAME_DECLARATION, replacement), replacements: 1}
}

const JSONC_WORKER_NAME_FIELD = /("name":\s*")[^"]*(")/

export function rewriteSiteWorkerName(content: string, appName: string): string {
  const error = validateAppName(appName)
  if (error) throw new Error(error)
  if (!JSONC_WORKER_NAME_FIELD.test(content)) {
    throw new Error('The site Worker configuration is missing a name field.')
  }
  return content.replace(JSONC_WORKER_NAME_FIELD, `$1${appName}-site$2`)
}

function replaceMarkdownSection(content: string, heading: string, replacement: string): string {
  const marker = `## ${heading}\n`
  const start = content.indexOf(marker)
  if (start === -1) throw new Error(`Agent instructions are missing the "${heading}" section.`)
  const end = content.indexOf('\n## ', start + marker.length)
  if (end === -1) throw new Error(`Agent instructions cannot delimit the "${heading}" section.`)
  const sections = [content.slice(0, start).trim(), replacement.trim(), content.slice(end).trim()]
  return `${sections.filter(Boolean).join('\n\n')}\n`
}

function removeParagraphContaining(content: string, fragment: string): string {
  const paragraphs = content.split('\n\n')
  const index = paragraphs.findIndex(paragraph => paragraph.includes(fragment))
  if (index === -1) throw new Error(`Agent instructions are missing expected text: ${fragment}`)
  paragraphs.splice(index, 1)
  return paragraphs.join('\n\n')
}

export function rewriteBuyerAgentInstructions(content: string): string {
  if (
    content.includes('Audit and remediate the complete buyer-owned SaaS application') &&
    !INTERNAL_AGENT_REFERENCE_RE.test(content)
  ) {
    return content
  }

  let rewritten = removeParagraphContaining(content, '`internal/` holds every seller-only surface')
  rewritten = removeParagraphContaining(
    rewritten,
    'The root pnpm workspace includes only `apps/*` and `packages/*`.',
  )
  rewritten = replaceMarkdownSection(
    rewritten,
    'Product security audit scope',
    `## Product security audit scope

Audit and remediate the complete buyer-owned SaaS application: \`apps/\`, \`packages/\`, buyer
documentation, and the configuration and deployment files that ship with it. \`agent-tooling/\` and
\`packages/agent-context\` are optional, buyer-distributed development tooling; review them when agent
behavior or distribution changes, but do not treat them as application runtime code. Do not vendor
machine-local installed copies, compatibility symlinks, client configuration, or skill lock records
into this repository.
`,
  )
  rewritten = replaceMarkdownSection(rewritten, 'Landing boundary', '')
  rewritten = rewritten
    .split('\n')
    .filter(line => !line.includes('| `internal`'))
    .join('\n')
    .replace('real env files, `internal/`, or\n  `bun.lock`', 'real env files, or `bun.lock`')

  if (INTERNAL_AGENT_REFERENCE_RE.test(rewritten)) {
    throw new Error('Buyer agent instructions still contain seller-only guidance.')
  }
  return rewritten
}

const BUYER_README_HEADING = '## Create your product'

export function rewriteBuyerReadme(content: string): string {
  if (content.includes(BUYER_README_HEADING)) return content

  const anchor = '## Quick Start'
  const index = content.indexOf(anchor)
  if (index === -1) throw new Error('Repository README is missing the "Quick Start" heading.')

  const bootstrap = `${BUYER_README_HEADING}

Start here. Run the public bootstrapper and paste the licence key from your purchase receipt. It
downloads this release's checksummed source, applies your own brand and package scope, and leaves
you with a git-initialized project of your own.

\`\`\`bash
pnpm dlx ${CLI_NAME}@latest your-app
cd your-app
\`\`\`

\`bunx ${CLI_NAME}@latest your-app\` is equivalent. Your licence key is on your purchase receipt and in
the customer portal; pass it with \`--license-key\` or set \`${LICENSE_KEY_VARIABLE}\` to skip the
prompt. The full walkthrough, including pinned tool versions, is in the
[setup guide](${DOCS_BASE_URL}/docs/setup).

The commands below run this foundation in place. Use them to read, diff, or verify the source — not
to build your product.

`

  return `${content.slice(0, index)}${bootstrap}${content.slice(index)}`
}

export function stripDistributionReadmeBootstrap(content: string): string {
  if (!content.includes(BUYER_README_HEADING)) return content
  return replaceMarkdownSection(content, 'Create your product', '')
}

const REQUIRED_BUYER_CLI_CONSTANTS = ['CLI_NAME', 'CLI_PACKAGE_NAME', 'DEFAULT_SCOPE'] as const

export function rewriteBuyerCliConstants(
  content: string,
  scope: string,
  brandName: string,
): string {
  const buyerVariablePrefix = BUYER_CLI_NAME.toUpperCase().replaceAll('-', '_')
  const buyerConstants: [string, string][] = [
    ['CLI_NAME', BUYER_CLI_NAME],
    ['CLI_PACKAGE_NAME', BUYER_CLI_PACKAGE_NAME],
    ['DEFAULT_SCOPE', normalizeScope(scope)],
    ['SOURCE_BRAND_NAME', brandName],
    ['TEMPLATE_REPOSITORY', 'OWNER/REPOSITORY'],
    ['DELIVERY_BASE_URL', 'https://releases.example.com'],
    ['DOCS_BASE_URL', 'https://docs.example.com'],
    ['DELIVERY_URL_VARIABLE', `${buyerVariablePrefix}_DELIVERY_URL`],
    ['LICENSE_KEY_VARIABLE', `${buyerVariablePrefix}_LICENSE_KEY`],
    ['LICENSE_KEY_PREFIX', 'LICENSE-'],
  ]

  let rewritten = content
  for (const [name, value] of buyerConstants) {
    const declaration = new RegExp(`^export const ${name} = '[^']*'$`, 'm')
    if (!declaration.test(rewritten)) {
      if (REQUIRED_BUYER_CLI_CONSTANTS.includes(name as never)) {
        throw new Error(`Source CLI constants are missing ${name}.`)
      }
      continue
    }
    rewritten = rewritten.replace(declaration, `export const ${name} = '${value}'`)
  }

  const leaked = [
    CLI_PACKAGE_NAME,
    SOURCE_BRAND_NAME,
    DELIVERY_BASE_URL,
    DOCS_BASE_URL,
    DELIVERY_URL_VARIABLE,
    LICENSE_KEY_VARIABLE,
    LICENSE_KEY_PREFIX,
  ].filter(identity => rewritten.includes(identity))
  if (leaked.length > 0) {
    throw new Error(`Buyer CLI constants still name the source product: ${leaked.join(', ')}`)
  }
  return rewritten
}

export const SELLER_ONLY_ROOT_SCRIPTS = [
  'release:distribute',
  'release:publish-cli',
  'release:upload',
]

export function stripSellerOnlyRootScripts(content: string): string {
  const manifest = JSON.parse(content) as {scripts?: Record<string, string>}
  for (const script of SELLER_ONLY_ROOT_SCRIPTS) delete manifest.scripts?.[script]
  return `${JSON.stringify(manifest, null, 2)}\n`
}

export function rewriteBuyerClaudeInstructions(content: string): string {
  if (!INTERNAL_CLAUDE_REFERENCE_RE.test(content)) return content

  const rewritten = removeParagraphContaining(content, '`internal/landing/AGENTS.md`')
  if (INTERNAL_CLAUDE_REFERENCE_RE.test(rewritten)) {
    throw new Error('Buyer Claude instructions still contain seller-only guidance.')
  }
  return rewritten
}

export function rewriteBuyerSetupInstructions(content: string): string {
  if (!content.includes('## Create a product repository')) return content
  const rewritten = replaceMarkdownSection(content, 'Create a product repository', '')
  if (SOURCE_DELIVERY_GUIDANCE_RE.test(rewritten)) {
    throw new Error('Buyer setup instructions still contain source-delivery guidance.')
  }
  return rewritten
}

export function rewriteBuyerReleaseInstructions(content: string): string {
  if (!content.includes('## npm bootstrapper')) return content
  const rewritten = replaceMarkdownSection(content, 'npm bootstrapper', '')
  if (VENDOR_BOOTSTRAPPER_GUIDANCE_RE.test(rewritten)) {
    throw new Error('Buyer release instructions still contain vendor bootstrapper guidance.')
  }
  return rewritten
}

export function generateStartDevVars(
  example: string,
  secret = randomBytes(32).toString('base64'),
): string {
  if (!BETTER_AUTH_SECRET_LINE_RE.test(example)) {
    throw new Error('apps/start/.dev.vars.example must contain a BETTER_AUTH_SECRET entry.')
  }
  return example.replace(BETTER_AUTH_SECRET_LINE_RE, `BETTER_AUTH_SECRET=${secret}`)
}

export function generateServerEnv(
  example: string,
  secret = randomBytes(32).toString('hex'),
  databasePort = 5432,
): string {
  if (!HEX_64_RE.test(secret)) {
    throw new Error('Better Auth secret must be 32 bytes encoded as hex.')
  }
  if (!DATABASE_URL_LINE_RE.test(example) || !BETTER_AUTH_SECRET_LINE_RE.test(example)) {
    throw new Error('Server .env.example must contain DATABASE_URL and BETTER_AUTH_SECRET entries.')
  }
  if (!Number.isInteger(databasePort) || databasePort < 1 || databasePort > 65_535) {
    throw new Error('Database port must be an integer between 1 and 65535.')
  }
  const databaseUrl = `postgresql://app:app@localhost:${databasePort}/app?sslmode=disable`
  return example
    .replace(DATABASE_URL_LINE_RE, `DATABASE_URL=${databaseUrl}`)
    .replace(BETTER_AUTH_SECRET_LINE_RE, `BETTER_AUTH_SECRET=${secret}`)
}

const SCOPE_EXTENSIONS = new Set(['.css', '.json', '.jsonc', '.md', '.ts', '.tsx', '.yaml', '.yml'])

export function isScopeRewriteFile(path: string): boolean {
  return (
    SCOPE_EXTENSIONS.has(extname(path)) ||
    path.replaceAll('\\', '/').endsWith('/.vite-hooks/pre-commit')
  )
}

export function isTemplatePathExcluded(relativePath: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/')
  const parts = normalized.split('/').filter(Boolean)
  const basename = parts.at(-1) ?? ''

  if (parts.includes('.git') || parts.includes('.worktrees') || parts.includes('node_modules'))
    return true
  if (parts.includes('.terraform')) return true
  if (parts.includes('.impeccable')) return true
  if (parts.includes('.agent-evals') || parts.includes('.agents') || parts.includes('.claude'))
    return true
  if (normalized === 'skills-lock.json') return true
  if (normalized === 'internal' || normalized.startsWith('internal/')) return true
  if (normalized === 'marketing' || normalized.startsWith('marketing/')) return true
  if (normalized === '.github/workflows/internal-commercial.yml') return true
  if (normalized === 'apps/worker' || normalized.startsWith('apps/worker/')) return true
  if (parts[0] === 'apps' && parts[1] === 'mobile') {
    const mobileEntry = parts[2] ?? ''
    if (['.expo', 'android', 'ios', 'credentials', 'dist-verify'].includes(mobileEntry)) return true
  }
  if (parts.includes('.wrangler') || parts.includes('.astro')) return true
  if (parts.includes('dist') || parts.includes('out')) return true
  if (parts.includes('.next') || parts.includes('.source') || parts.includes('.turbo')) return true
  if (normalized === 'bun.lock') return true
  if (normalized === '.vercelignore') return true
  if (basename.endsWith('.tfvars') || basename === 'backend.hcl') return true
  if (basename.includes('.tfstate') || GHA_CREDS_FILE_RE.test(basename)) return true
  if (normalized === 'PLAN.md' || normalized === 'comments.md') return true
  if (normalized === 'packages/create-app/src/cli-brand-contract.test.ts') return true
  if (normalized === 'packages/create-app/src/commercial-contract.test.ts') return true
  if (normalized === 'packages/create-app/LICENSE') return true
  if (normalized === 'packages/create-app/README.md') return true
  if (normalized === 'apps/server/server') return true
  if (basename.endsWith('.tsbuildinfo')) return true
  if (
    basename === '.dev.vars' ||
    (basename.startsWith('.dev.vars.') && basename !== '.dev.vars.example')
  )
    return true
  if (basename === '.env' || (basename.startsWith('.env.') && basename !== '.env.example'))
    return true
  return false
}
