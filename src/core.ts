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
  LICENSE_KEY_PREFIX,
  LICENSE_KEY_VARIABLE,
  SOURCE_BRAND_NAME,
} from './constants.js'

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
  {path: 'apps/server/email-templates/welcome-email.html', occurrences: 8},
] as const

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
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    return 'App name must be kebab-case (lowercase letters, numbers, and single hyphens).'
  }
  return undefined
}

export function normalizeScope(value: string): string {
  const scope = value.startsWith('@') ? value : `@${value}`
  if (/\s/.test(scope)) {
    throw new Error('Use hyphens instead of spaces, for example test-package.')
  }
  if (!/^@[a-z0-9][a-z0-9._-]*$/.test(scope)) {
    throw new Error(
      'Use lowercase letters and numbers, with optional periods, underscores, or hyphens.',
    )
  }
  return scope
}

export function validateBrandName(value: string): string | undefined {
  if (!value.trim()) return 'Brand name cannot be empty.'
  if (/\r|\n/.test(value)) return 'Brand name must fit on one line.'
  if (value !== value.trim()) return 'Brand name cannot start or end with whitespace.'
  if (value.length > 48) return 'Brand name must be 48 characters or less.'
  if (!/^[\p{L}\p{N}](?:[\p{L}\p{N} ._-]*[\p{L}\p{N}])?$/u.test(value)) {
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
  const escapedSourceBrand = SOURCE_BRAND_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const sourceBrandPattern = new RegExp(`\\b${escapedSourceBrand}\\b`, 'g')
  const matches = content.match(sourceBrandPattern)
  if (brandName === SOURCE_BRAND_NAME || !matches) return {content, replacements: 0}
  return {
    content: content.replace(sourceBrandPattern, () => brandName),
    replacements: matches.length,
  }
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
      const match = line.match(/^(\s*)(import(?:\s+type)?\s+)\{([^}]+)\}(\s+from\s+.+)$/)
      if (!match) return line
      const [, indentation = '', prefix = '', names = '', suffix = ''] = match
      const members = names.split(',').map(name => name.trim())
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
    for (const word of joined.split(/\s+/)) {
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
    !/internal\/|landing\/|seller-surface|studio-owned/i.test(content)
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

  if (/internal\/|landing\/|seller-surface|studio-owned/i.test(rewritten)) {
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

\`bunx ${CLI_NAME}@latest your-app\` is equivalent. Your licence key is on your purchase receipt
and in the customer portal; pass it with \`--license-key\` or set \`${LICENSE_KEY_VARIABLE}\` to skip
the prompt. The full walkthrough, including pinned tool versions, is in the
[setup guide](https://docs.superslate.dev/docs/setup).

The commands below run this foundation in place. Use them to read, diff, or verify the source —
not to build your product.

`

  return `${content.slice(0, index)}${bootstrap}${content.slice(index)}`
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
  if (!/internal\/|landing\/|studio-owned/i.test(content)) return content

  const rewritten = removeParagraphContaining(content, '`internal/landing/AGENTS.md`')
  if (/internal\/|landing\/|studio-owned/i.test(rewritten)) {
    throw new Error('Buyer Claude instructions still contain seller-only guidance.')
  }
  return rewritten
}

export function rewriteBuyerSetupInstructions(content: string): string {
  if (!content.includes('## Create a product repository')) return content
  const rewritten = replaceMarkdownSection(content, 'Create a product repository', '')
  const escapedCliName = CLI_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (
    new RegExp(
      `pnpm dlx ${escapedCliName}|bunx ${escapedCliName}|${escapedCliName} repository`,
      'i',
    ).test(rewritten)
  ) {
    throw new Error('Buyer setup instructions still contain source-delivery guidance.')
  }
  return rewritten
}

export function rewriteBuyerReleaseInstructions(content: string): string {
  if (!content.includes('## npm bootstrapper')) return content
  const rewritten = replaceMarkdownSection(content, 'npm bootstrapper', '')
  const escapedCliName = CLI_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (
    new RegExp(`${escapedCliName}@\\d|public \`${escapedCliName}\` npm package`, 'i').test(
      rewritten,
    )
  ) {
    throw new Error('Buyer release instructions still contain vendor bootstrapper guidance.')
  }
  return rewritten
}

export function generateServerEnv(
  example: string,
  secret = randomBytes(32).toString('hex'),
  databasePort = 5432,
): string {
  if (!/^[a-f0-9]{64}$/.test(secret)) {
    throw new Error('Better Auth secret must be 32 bytes encoded as hex.')
  }
  if (!/^DATABASE_URL=.*$/m.test(example) || !/^BETTER_AUTH_SECRET=.*$/m.test(example)) {
    throw new Error('Server .env.example must contain DATABASE_URL and BETTER_AUTH_SECRET entries.')
  }
  if (!Number.isInteger(databasePort) || databasePort < 1 || databasePort > 65_535) {
    throw new Error('Database port must be an integer between 1 and 65535.')
  }
  const databaseUrl = `postgresql://app:app@localhost:${databasePort}/app?sslmode=disable`
  return example
    .replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=${databaseUrl}`)
    .replace(/^BETTER_AUTH_SECRET=.*$/m, `BETTER_AUTH_SECRET=${secret}`)
}

const SCOPE_EXTENSIONS = new Set(['.json', '.jsonc', '.md', '.ts', '.tsx', '.yaml', '.yml'])

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
  if (normalized === '.github/workflows/internal-commercial.yml') return true
  if (normalized === 'apps/worker' || normalized.startsWith('apps/worker/')) return true
  if (parts.includes('dist') || parts.includes('out')) return true
  if (normalized === 'bun.lock') return true
  if (normalized === '.vercelignore') return true
  if (basename.endsWith('.tfvars') || basename === 'backend.hcl') return true
  if (basename.includes('.tfstate') || /^gha-creds-.*\.json$/.test(basename)) return true
  if (normalized === 'PLAN.md' || normalized === 'comments.md') return true
  if (normalized === 'packages/create-app/src/cli-brand-contract.test.ts') return true
  if (normalized === 'packages/create-app/LICENSE') return true
  if (normalized === 'packages/create-app/README.md') return true
  if (normalized === 'apps/server/server') return true
  if (basename.endsWith('.tsbuildinfo')) return true
  if (basename === '.env' || (basename.startsWith('.env.') && basename !== '.env.example'))
    return true
  return false
}
