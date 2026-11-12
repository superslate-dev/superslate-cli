import {mkdir, readFile, rm, stat, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

const DEPLOYMENT_ENVIRONMENT_RE = /^[a-z][a-z0-9-]{1,30}$/
const REGION_RE = /^[a-z0-9][a-z0-9-]{1,31}$/
const DOMAIN_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export const deploymentClouds = ['aws', 'gcp', 'railway'] as const
const openTofuClouds = ['aws', 'gcp'] as const
export const frontendTargets = ['native', 'cloudflare'] as const
export const storageProviders = ['r2', 's3', 'gcs'] as const

export type DeploymentCloud = (typeof deploymentClouds)[number]
type OpenTofuCloud = (typeof openTofuClouds)[number]
export type FrontendTarget = (typeof frontendTargets)[number]
export type StorageProvider = (typeof storageProviders)[number]

export interface DeploymentSelection {
  cloud: DeploymentCloud
  storageProvider: StorageProvider
  frontendTarget: FrontendTarget
  environment: string
  region: string | null
  apiDomain: string
  frontendDomain: string
  haEnabled: boolean
}

export interface DeploymentConfig {
  schema_version: 2
  cloud: DeploymentCloud
  storage_provider: StorageProvider
  project_name: string
  environment: string
  region: string | null
  frontend_target: FrontendTarget
  external_frontend_origin: string | null
  api_domain: string
  frontend_domain: string
  ha_enabled: boolean
}

export const defaultRegions: Record<OpenTofuCloud, string> = {
  aws: 'us-east-1',
  gcp: 'us-central1',
}

export const defaultStorageProviders: Record<DeploymentCloud, StorageProvider> = {
  aws: 's3',
  gcp: 'gcs',
  railway: 'r2',
}

export const storageProvidersByCloud: Record<DeploymentCloud, StorageProvider[]> = {
  aws: ['s3', 'r2'],
  gcp: ['gcs', 'r2'],
  railway: ['r2'],
}

export const frontendTargetsByCloud: Record<DeploymentCloud, FrontendTarget[]> = {
  aws: ['native', 'cloudflare'],
  gcp: ['native', 'cloudflare'],
  railway: ['cloudflare'],
}

export const cloudLabels: Record<DeploymentCloud, string> = {
  aws: 'AWS',
  gcp: 'GCP',
  railway: 'Railway',
}

export function isOpenTofuCloud(cloud: DeploymentCloud): cloud is OpenTofuCloud {
  return openTofuClouds.some(candidate => candidate === cloud)
}

function isDeploymentCloud(value: string): value is DeploymentCloud {
  return deploymentClouds.some(cloud => cloud === value)
}

function isFrontendTarget(value: string): value is FrontendTarget {
  return frontendTargets.some(target => target === value)
}

function isStorageProvider(value: string): value is StorageProvider {
  return storageProviders.some(provider => provider === value)
}

export function parseDeploymentCloud(value: string): DeploymentCloud {
  if (!isDeploymentCloud(value)) throw new Error('Cloud must be aws, gcp, or railway.')
  return value
}

export function parseFrontendTarget(value: string): FrontendTarget {
  if (!isFrontendTarget(value)) {
    throw new Error('Frontend target must be native or cloudflare.')
  }
  return value
}

export function parseStorageProvider(value: string): StorageProvider {
  if (!isStorageProvider(value)) throw new Error('Storage provider must be r2, s3, or gcs.')
  return value
}

export function validateDeploymentEnvironment(value: string): string | undefined {
  if (!DEPLOYMENT_ENVIRONMENT_RE.test(value)) {
    return 'Environment must use 2-31 lowercase letters, numbers, or hyphens.'
  }
  return undefined
}

export function validateRegion(value: string): string | undefined {
  if (!REGION_RE.test(value)) {
    return 'Region must use 2-32 lowercase letters, numbers, or hyphens.'
  }
  return undefined
}

export function validateDomain(value: string): string | undefined {
  if (value.length > 80 || !DOMAIN_RE.test(value)) {
    return 'Enter a lowercase hostname such as api.example.com, without a protocol or path.'
  }
  return undefined
}

export function validateDeploymentSelection(selection: DeploymentSelection): void {
  if (!storageProvidersByCloud[selection.cloud].includes(selection.storageProvider)) {
    throw new Error(
      `${selection.storageProvider} storage is not supported for ${selection.cloud} deployments.`,
    )
  }
  if (!frontendTargetsByCloud[selection.cloud].includes(selection.frontendTarget)) {
    throw new Error(
      `The ${selection.frontendTarget} frontend is not supported for ${selection.cloud} deployments.`,
    )
  }
  if (isOpenTofuCloud(selection.cloud)) {
    const regionError = validateRegion(selection.region ?? '')
    if (regionError) throw new Error(regionError)
  } else {
    if (selection.region !== null) {
      throw new Error('Railway selects its region per service; omit the region.')
    }
    if (selection.haEnabled) {
      throw new Error('The higher-availability profile applies to AWS and GCP only.')
    }
  }
  const environmentError = validateDeploymentEnvironment(selection.environment)
  if (environmentError) throw new Error(environmentError)
  const apiError = validateDomain(selection.apiDomain)
  if (apiError) throw new Error(`API domain: ${apiError}`)
  const frontendError = validateDomain(selection.frontendDomain)
  if (frontendError) throw new Error(`Frontend domain: ${frontendError}`)
  if (selection.apiDomain === selection.frontendDomain) {
    throw new Error('API and frontend domains must be different hostnames.')
  }
  const apiSite = selection.apiDomain.split('.').slice(1).join('.')
  const frontendSite = selection.frontendDomain.split('.').slice(1).join('.')
  if (apiSite !== frontendSite) {
    throw new Error('API and frontend domains must be sibling hosts under the same site.')
  }
}

export function createDeploymentConfig(
  projectName: string,
  selection: DeploymentSelection,
): DeploymentConfig {
  validateDeploymentSelection(selection)
  return {
    schema_version: 2,
    cloud: selection.cloud,
    storage_provider: selection.storageProvider,
    project_name: projectName,
    environment: selection.environment,
    region: selection.region,
    frontend_target: selection.frontendTarget,
    external_frontend_origin:
      selection.frontendTarget === 'native' ? null : `https://${selection.frontendDomain}`,
    api_domain: selection.apiDomain,
    frontend_domain: selection.frontendDomain,
    ha_enabled: selection.haEnabled,
  }
}

function lockSummary(config: DeploymentConfig): string {
  return `The deployment target is locked:

- backend: **${cloudLabels[config.cloud]}**;
- storage: **${config.storage_provider}**;
- frontend: **${config.frontend_target}**;
- environment: **${config.environment}**.`
}

function railwayReadme(config: DeploymentConfig): string {
  return `# Deployment setup

${lockSummary(config)}

The production hosts are:

- API: \`${config.api_domain}\`;
- frontend: \`${config.frontend_domain}\`.

## Railway API and PostgreSQL

1. Create a Railway project with a PostgreSQL service and an API service connected to this
   repository. Build from the repository root, because the image copies the whole workspace.
2. Set the API service's config-as-code path to \`apps/server/railway.toml\`. It builds
   \`apps/server/Dockerfile\`, runs \`./server migrate\` before each deploy, starts \`./server serve\`,
   and admits traffic only after \`/ready\` succeeds.
3. Set these API service variables in the \`${config.environment}\` Railway environment:

   \`\`\`text
   DATABASE_URL=\${{Postgres.DATABASE_URL}}
   ENVIRONMENT=production
   TRUSTED_PROXY_PROFILE=railway
   DEPLOYMENT_CLOUD=railway
   FRONTEND_URL=https://${config.frontend_domain}
   SERVER_URL=https://${config.api_domain}
   \`\`\`

   Add \`BETTER_AUTH_SECRET\`, \`RESEND_API_KEY\`, \`EMAIL_FROM\`, \`APP_DB_POOL_MAX\`, and
   \`AUTH_DB_POOL_MAX\`, then the Cloudflare R2 storage variables and every enabled billing,
   monitoring, and OAuth value. Railway injects \`PORT\`; leave it unset.

4. Add the API host as the service's custom domain and publish the DNS records Railway reports. A
   Cloudflare-managed zone keeps them \`DNS only\`.

## Cloudflare frontend

1. Create a Cloudflare Workers project rooted at \`apps/web\`. It uses \`apps/web/wrangler.toml\`, which
   serves \`dist\` as static assets with single-page-application fallback.
2. Build with \`pnpm run build:prod\` and these variables:

   \`\`\`text
   VITE_APP_ENV=production
   VITE_API_URL=https://${config.api_domain}
   \`\`\`

   Add \`VITE_TERMS_URL\` and \`VITE_PRIVACY_URL\`, plus \`VITE_MARKETING_URL\` when the product has a
   public marketing site.

3. Attach the frontend host as the Worker's custom domain.

## Verify

\`\`\`sh
API_ORIGIN=https://${config.api_domain} \\
WEB_ORIGIN=https://${config.frontend_domain} \\
bash scripts/verify-public-deployment.sh
\`\`\`

The provider lock is deliberate. Restore the deployment directories from a fresh licensed release
before changing providers.
`
}

function openTofuReadme(config: DeploymentConfig): string {
  const identity =
    config.cloud === 'aws'
      ? '`AWS_ROLE_ARN` secret'
      : '`GCP_WORKLOAD_IDENTITY_PROVIDER` and `GCP_SERVICE_ACCOUNT` secrets'
  const providerInputs =
    config.cloud === 'aws'
      ? 'Route 53 zone or certificate identifiers and runtime Secrets Manager ARNs'
      : 'GCP project, Cloud DNS zone, and runtime Secret Manager names'
  const storageSetup =
    config.storage_provider === 'r2'
      ? 'Create private staging and public Cloudflare R2 buckets, then store the required storage\n   variables in the runtime secret container.'
      : `${config.storage_provider.toUpperCase()} application buckets, lifecycle policy, CORS, public access, and workload permissions are\n   managed by the selected OpenTofu root.`

  return `# Deployment setup

${lockSummary(config)}

## Protected GitHub environment

Create a GitHub environment named \`${config.environment}\` and configure:

- ${identity};
- a \`BACKEND_HCL\` secret containing the selected remote-state backend configuration;
- a \`TFVARS_JSON\` secret containing only:
  - ${providerInputs};
- \`VITE_TERMS_URL\` and \`VITE_PRIVACY_URL\`, plus \`VITE_MARKETING_URL\` when the product has a public
  marketing site.

## Cloud preparation

1. Run \`infra/bootstrap/${config.cloud}\` once with an administrator identity.
2. Configure OIDC trust for this repository and the \`${config.environment}\` GitHub environment.
3. Create the DNS zone or supply the existing zone identifier required by the selected root.
4. ${storageSetup}
5. Create application secret entries for Better Auth and enabled email, billing, monitoring, OAuth,
   and credential-based providers.
6. Put only secret identifiers in \`TFVARS_JSON\`; write secret values directly through the cloud
   provider.
7. Dispatch \`.github/workflows/deploy-cloud.yml\` with:
   - cloud: \`${config.cloud}\`;
   - environment: \`${config.environment}\`;
   - frontend: \`${config.frontend_target}\`.

The workflow creates the registry first, pushes an immutable image, provisions the API with public
traffic disabled, runs migrations, and admits traffic only after migration succeeds.

The provider lock is deliberate. Restore the deployment directories from a fresh licensed release
before changing providers.
`
}

function deploymentReadme(config: DeploymentConfig): string {
  return config.cloud === 'railway' ? railwayReadme(config) : openTofuReadme(config)
}

function openTofuPaths(cloud: OpenTofuCloud): string[] {
  return [
    `infra/bootstrap/${cloud}`,
    `infra/modules/${cloud}`,
    `infra/roots/${cloud}`,
    `scripts/deploy/release-${cloud}.sh`,
    `scripts/deploy/frontend-${cloud}.sh`,
  ]
}

function unusedDeploymentPaths(selection: DeploymentSelection): string[] {
  const paths =
    selection.cloud === 'railway'
      ? ['infra', 'scripts/deploy', '.github/workflows/deploy-cloud.yml']
      : [
          ...openTofuClouds.filter(cloud => cloud !== selection.cloud).flatMap(openTofuPaths),
          'apps/server/railway.toml',
        ]
  if (selection.frontendTarget === 'native') paths.push('apps/web/wrangler.toml')
  else if (selection.cloud !== 'railway') {
    paths.push(`scripts/deploy/frontend-${selection.cloud}.sh`)
  }
  return paths
}

async function removeIfPresent(target: string): Promise<boolean> {
  if (!(await stat(target).catch(() => undefined))) return false
  await rm(target, {recursive: true, force: true})
  return true
}

async function removeInfrastructureScript(repositoryRoot: string): Promise<void> {
  const packagePath = join(repositoryRoot, 'package.json')
  const content = await readFile(packagePath, 'utf8').catch(() => undefined)
  if (!content) return
  const rootPackage = JSON.parse(content) as {scripts?: Record<string, string>}
  if (!rootPackage.scripts?.['verify:infra']) return
  delete rootPackage.scripts['verify:infra']
  await writeFile(packagePath, `${JSON.stringify(rootPackage, null, 2)}\n`)
}

export async function applyDeploymentSelection(
  repositoryRoot: string,
  projectName: string,
  selection: DeploymentSelection,
): Promise<string[]> {
  const config = createDeploymentConfig(projectName, selection)
  const configPath = join(repositoryRoot, 'deployment/config.json')
  if (await stat(configPath).catch(() => undefined)) {
    throw new Error('Deployment is already locked. Restore a fresh release to change providers.')
  }

  await mkdir(join(repositoryRoot, 'deployment'), {recursive: true})
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
  await writeFile(join(repositoryRoot, 'deployment/README.md'), deploymentReadme(config))

  const removed: string[] = []
  for (const relativePath of unusedDeploymentPaths(selection)) {
    if (await removeIfPresent(join(repositoryRoot, relativePath))) removed.push(relativePath)
  }
  if (removed.includes('infra')) await removeInfrastructureScript(repositoryRoot)

  return removed
}

export async function readDeploymentConfig(repositoryRoot: string): Promise<DeploymentConfig> {
  const value = JSON.parse(
    await readFile(join(repositoryRoot, 'deployment/config.json'), 'utf8'),
  ) as DeploymentConfig
  if (
    value.schema_version !== 2 ||
    !isDeploymentCloud(value.cloud) ||
    !isStorageProvider(value.storage_provider) ||
    !isFrontendTarget(value.frontend_target)
  ) {
    throw new Error('deployment/config.json is not a supported deployment configuration.')
  }
  validateDeploymentSelection({
    cloud: value.cloud,
    storageProvider: value.storage_provider,
    frontendTarget: value.frontend_target,
    environment: value.environment,
    region: value.region,
    apiDomain: value.api_domain,
    frontendDomain: value.frontend_domain,
    haEnabled: value.ha_enabled,
  })
  return value
}
