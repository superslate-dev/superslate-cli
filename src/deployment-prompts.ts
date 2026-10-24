import * as prompts from '@clack/prompts'

import {
  defaultRegions,
  defaultStorageProviders,
  parseDeploymentCloud,
  parseFrontendTarget,
  parseStorageProvider,
  storageProvidersByCloud,
  validateDeploymentEnvironment,
  validateDomain,
  validateRegion,
  type DeploymentCloud,
  type DeploymentSelection,
  type FrontendTarget,
  type StorageProvider,
} from './deployment.js'

export interface DeploymentPromptDefaults {
  cloud?: DeploymentCloud
  storageProvider?: StorageProvider
  frontendTarget?: FrontendTarget
  environment?: string
  region?: string
  apiDomain?: string
  frontendDomain?: string
  haEnabled?: boolean
}

export class DeploymentPromptCancelled extends Error {}

async function unwrap<T>(value: T | typeof prompts.CANCEL_SYMBOL): Promise<T> {
  if (prompts.isCancel(value)) {
    prompts.cancel('Deployment configuration was not changed.')
    throw new DeploymentPromptCancelled()
  }
  return value
}

export async function collectDeploymentSelection(
  defaults: DeploymentPromptDefaults = {},
  nonInteractive = false,
): Promise<DeploymentSelection> {
  if (nonInteractive) {
    if (!defaults.cloud || !defaults.apiDomain || !defaults.frontendDomain) {
      throw new Error(
        'Non-interactive deployment setup requires --cloud, --api-domain, and --frontend-domain.',
      )
    }
    return {
      cloud: defaults.cloud,
      storageProvider: defaults.storageProvider ?? defaultStorageProviders[defaults.cloud],
      frontendTarget: defaults.frontendTarget ?? 'native',
      environment: defaults.environment ?? 'production',
      region: defaults.region ?? defaultRegions[defaults.cloud],
      apiDomain: defaults.apiDomain,
      frontendDomain: defaults.frontendDomain,
      haEnabled: defaults.haEnabled ?? false,
    }
  }

  const cloud =
    defaults.cloud ??
    parseDeploymentCloud(
      await unwrap(
        await prompts.select({
          message: 'Backend cloud',
          options: [
            {value: 'aws', label: 'AWS', hint: 'ECS Fargate + RDS PostgreSQL'},
            {value: 'gcp', label: 'Google Cloud', hint: 'Cloud Run + Cloud SQL'},
            {value: 'azure', label: 'Azure', hint: 'Container Apps + Flexible Server'},
          ],
        }),
      ),
    )
  const frontendTarget =
    defaults.frontendTarget ??
    parseFrontendTarget(
      await unwrap(
        await prompts.select({
          message: 'Frontend host',
          options: [
            {value: 'native', label: 'Cloud native', hint: 'Managed with the backend'},
            {value: 'vercel', label: 'Vercel SPA', hint: 'Static frontend only'},
            {
              value: 'cloudflare',
              label: 'Cloudflare static assets',
              hint: 'No API Worker',
            },
          ],
        }),
      ),
    )
  const storageProvider =
    defaults.storageProvider ??
    (storageProvidersByCloud[cloud].length === 1
      ? (storageProvidersByCloud[cloud][0] ?? defaultStorageProviders[cloud])
      : parseStorageProvider(
          await unwrap(
            await prompts.select({
              message: 'Object storage',
              options: storageProvidersByCloud[cloud].map(provider => ({
                value: provider,
                label:
                  provider === 's3'
                    ? 'Amazon S3'
                    : provider === 'gcs'
                      ? 'Google Cloud Storage'
                      : 'Cloudflare R2',
                hint: provider === defaultStorageProviders[cloud] ? 'Cloud-native default' : '',
              })),
            }),
          ),
        ))
  const environment =
    defaults.environment ??
    (await unwrap(
      await prompts.text({
        message: 'Deployment environment',
        placeholder: 'production',
        defaultValue: 'production',
        validate: value => validateDeploymentEnvironment(value || 'production'),
      }),
    ))
  const region =
    defaults.region ??
    (await unwrap(
      await prompts.text({
        message: `${cloud.toUpperCase()} region`,
        placeholder: defaultRegions[cloud],
        defaultValue: defaultRegions[cloud],
        validate: value => validateRegion(value || defaultRegions[cloud]),
      }),
    ))
  const apiDomain =
    defaults.apiDomain ??
    (await unwrap(
      await prompts.text({
        message: 'Production API domain',
        placeholder: 'api.example.com',
        validate: value => validateDomain(value ?? ''),
      }),
    ))
  const frontendDomain =
    defaults.frontendDomain ??
    (await unwrap(
      await prompts.text({
        message: 'Production frontend domain',
        placeholder: 'app.example.com',
        validate: value => validateDomain(value ?? ''),
      }),
    ))
  const haEnabled =
    defaults.haEnabled ??
    (await unwrap(
      await prompts.confirm({
        message: 'Enable the higher-availability profile?',
        initialValue: false,
      }),
    ))

  return {
    cloud,
    storageProvider,
    frontendTarget,
    environment,
    region,
    apiDomain,
    frontendDomain,
    haEnabled,
  }
}
