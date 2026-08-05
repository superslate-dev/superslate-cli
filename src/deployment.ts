import {mkdir, readFile, rm, stat, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

export const deploymentClouds = ['aws', 'gcp', 'azure'] as const
export const frontendTargets = ['native', 'vercel', 'cloudflare'] as const
export const storageProviders = ['r2', 's3', 'gcs'] as const

export type DeploymentCloud = (typeof deploymentClouds)[number]
export type FrontendTarget = (typeof frontendTargets)[number]
export type StorageProvider = (typeof storageProviders)[number]

export interface DeploymentSelection {
  cloud: DeploymentCloud
  storageProvider: StorageProvider
  frontendTarget: FrontendTarget
  environment: string
  region: string
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
  region: string
  frontend_target: FrontendTarget
  external_frontend_origin: string | null
  api_domain: string
  frontend_domain: string
  ha_enabled: boolean
}

export const defaultRegions: Record<DeploymentCloud, string> = {
  aws: 'us-east-1',
  gcp: 'us-central1',
  azure: 'eastus2',
}

export const defaultStorageProviders: Record<DeploymentCloud, StorageProvider> = {
  aws: 's3',
  gcp: 'gcs',
  azure: 'r2',
}

export const storageProvidersByCloud: Record<DeploymentCloud, StorageProvider[]> = {
  aws: ['s3', 'r2'],
  gcp: ['gcs', 'r2'],
  azure: ['r2'],
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
  if (!isDeploymentCloud(value)) throw new Error('Cloud must be aws, gcp, or azure.')
  return value
}

export function parseFrontendTarget(value: string): FrontendTarget {
  if (!isFrontendTarget(value)) {
    throw new Error('Frontend target must be native, vercel, or cloudflare.')
  }
  return value
}

export function parseStorageProvider(value: string): StorageProvider {
  if (!isStorageProvider(value)) throw new Error('Storage provider must be r2, s3, or gcs.')
  return value
}

export function validateDeploymentEnvironment(value: string): string | undefined {
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(value)) {
    return 'Environment must use 2-31 lowercase letters, numbers, or hyphens.'
  }
  return undefined
}

export function validateRegion(value: string): string | undefined {
  if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(value)) {
    return 'Region must use 2-32 lowercase letters, numbers, or hyphens.'
  }
  return undefined
}

export function validateDomain(value: string): string | undefined {
  if (
    value.length > 80 ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      value,
    )
  ) {
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
  const environmentError = validateDeploymentEnvironment(selection.environment)
  if (environmentError) throw new Error(environmentError)
  const regionError = validateRegion(selection.region)
  if (regionError) throw new Error(regionError)
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

function deploymentReadme(config: DeploymentConfig): string {
  const identity =
    config.cloud === 'aws'
      ? '`AWS_ROLE_ARN` secret'
      : config.cloud === 'gcp'
        ? '`GCP_WORKLOAD_IDENTITY_PROVIDER` and `GCP_SERVICE_ACCOUNT` secrets'
        : '`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and `AZURE_SUBSCRIPTION_ID` secrets'
  const providerInputs =
    config.cloud === 'aws'
      ? 'Route 53 zone or certificate identifiers and runtime Secrets Manager ARNs'
      : config.cloud === 'gcp'
        ? 'GCP project, Cloud DNS zone, and runtime Secret Manager names'
        : 'Azure DNS zone ID and runtime Key Vault secret identifiers'
  const storageSetup =
    config.storage_provider === 'r2'
      ? 'Create private staging and public Cloudflare R2 buckets, then store the required storage\n   variables in the runtime secret container.'
      : `${config.storage_provider.toUpperCase()} application buckets, lifecycle policy, CORS, public access, and workload permissions are\n   managed by the selected OpenTofu root.`

  return `# Deployment setup

The deployment target is locked:

- backend: **${config.cloud.toUpperCase()}**;
- storage: **${config.storage_provider}**;
- frontend: **${config.frontend_target}**;
- environment: **${config.environment}**.

## Protected GitHub environment

Create a GitHub environment named \`${config.environment}\` and configure:

- ${identity};
- a \`BACKEND_HCL\` secret containing the selected remote-state backend configuration;
- a \`TFVARS_JSON\` secret containing only:
  - ${providerInputs};
- \`VITE_TERMS_URL\` and \`VITE_PRIVACY_URL\`.

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
before changing cloud providers.
`
}

async function removeIfPresent(target: string): Promise<boolean> {
  if (!(await stat(target).catch(() => undefined))) return false
  await rm(target, {recursive: true, force: true})
  return true
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
  for (const cloud of deploymentClouds) {
    if (cloud === selection.cloud) continue
    for (const relativePath of [
      `infra/bootstrap/${cloud}`,
      `infra/modules/${cloud}`,
      `infra/roots/${cloud}`,
      `scripts/deploy/release-${cloud}.sh`,
      `scripts/deploy/frontend-${cloud}.sh`,
    ]) {
      if (await removeIfPresent(join(repositoryRoot, relativePath))) removed.push(relativePath)
    }
  }

  const adapters = [
    {target: 'vercel', path: 'apps/web/vercel.json'},
    {target: 'cloudflare', path: 'apps/web/wrangler.toml'},
    {
      target: 'azure-native',
      path: 'apps/web/public/staticwebapp.config.json',
    },
  ] as const
  const selectedAdapter =
    selection.frontendTarget === 'native'
      ? selection.cloud === 'azure'
        ? 'azure-native'
        : undefined
      : selection.frontendTarget
  for (const adapter of adapters) {
    if (adapter.target === selectedAdapter) continue
    if (await removeIfPresent(join(repositoryRoot, adapter.path))) removed.push(adapter.path)
  }

  if (selection.frontendTarget !== 'native') {
    const nativeScript = `scripts/deploy/frontend-${selection.cloud}.sh`
    if (await removeIfPresent(join(repositoryRoot, nativeScript))) removed.push(nativeScript)
  }

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
