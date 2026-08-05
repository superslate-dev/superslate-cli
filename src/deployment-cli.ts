import * as prompts from '@clack/prompts'
import {readFile} from 'node:fs/promises'
import {resolve} from 'node:path'

import {
  applyDeploymentSelection,
  parseDeploymentCloud,
  parseFrontendTarget,
  parseStorageProvider,
} from './deployment.js'
import {
  collectDeploymentSelection,
  DeploymentPromptCancelled,
  type DeploymentPromptDefaults,
} from './deployment-prompts.js'

interface DeploymentArguments extends DeploymentPromptDefaults {
  yes: boolean
}

function takeValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`)
  return value
}

export function parseDeploymentArguments(argv: string[]): DeploymentArguments {
  const parsed: DeploymentArguments = {yes: false}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--cloud') {
      parsed.cloud = parseDeploymentCloud(takeValue(argv, index++, argument))
    } else if (argument === '--frontend') {
      parsed.frontendTarget = parseFrontendTarget(takeValue(argv, index++, argument))
    } else if (argument === '--storage') {
      parsed.storageProvider = parseStorageProvider(takeValue(argv, index++, argument))
    } else if (argument === '--environment') {
      parsed.environment = takeValue(argv, index++, argument)
    } else if (argument === '--region') {
      parsed.region = takeValue(argv, index++, argument)
    } else if (argument === '--api-domain') {
      parsed.apiDomain = takeValue(argv, index++, argument)
    } else if (argument === '--frontend-domain') {
      parsed.frontendDomain = takeValue(argv, index++, argument)
    } else if (argument === '--ha') parsed.haEnabled = true
    else if (argument === '--no-ha') parsed.haEnabled = false
    else if (argument === '--yes' || argument === '-y') parsed.yes = true
    else throw new Error(`Unknown deployment option: ${argument}`)
  }
  return parsed
}

export async function runDeploymentConfigure(
  argv: string[],
  productName: string,
  repositoryRoot = process.cwd(),
): Promise<void> {
  const parsed = parseDeploymentArguments(argv)
  const root = resolve(repositoryRoot)
  const rootPackage = JSON.parse(await readFile(`${root}/package.json`, 'utf8')) as {name?: string}
  if (!rootPackage.name) throw new Error('Root package name is required for deployment setup.')
  prompts.intro(`${productName} deployment setup`)
  try {
    const selection = await collectDeploymentSelection(parsed, parsed.yes)
    const removed = await applyDeploymentSelection(root, rootPackage.name, selection)
    prompts.log.success(
      `${selection.cloud.toUpperCase()} + ${selection.storageProvider} + ${selection.frontendTarget} is locked for ${selection.environment}.`,
    )
    prompts.log.info(`${removed.length} unused deployment paths removed.`)
    prompts.log.step('Next')
    prompts.log.message(
      `Review deployment/config.json\nConfigure the protected GitHub environment\nDispatch .github/workflows/deploy-cloud.yml`,
    )
    prompts.outro('Deployment configuration is ready to commit.')
  } catch (error) {
    if (error instanceof DeploymentPromptCancelled) return
    throw error
  }
}
