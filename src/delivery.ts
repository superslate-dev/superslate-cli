import {createWriteStream} from 'node:fs'
import {rm} from 'node:fs/promises'
import {join} from 'node:path'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'

import {
  CLI_NAME,
  DELIVERY_BASE_URL,
  DELIVERY_URL_VARIABLE,
  LICENSE_KEY_PREFIX,
  LICENSE_KEY_VARIABLE,
} from './constants.js'

export interface ReleaseIndex {
  latest: string
  versions: string[]
}

export interface ReleaseAssetNames {
  artifact: string
  checksum: string
  manifest: string
}

const RELEASE_TAG_PATTERN = /^v\d+\.\d+\.\d+(?:-rc\.\d+)?$/
const INDEX_TIMEOUT_MS = 15_000
const DOWNLOAD_TIMEOUT_MS = 300_000

export function deliveryBaseUrl(
  environment: Record<string, string | undefined> = process.env,
): string {
  const configured = environment[DELIVERY_URL_VARIABLE]?.trim()
  return (configured || DELIVERY_BASE_URL).replace(/\/+$/, '')
}

export function validateLicenseKey(value: string): string | undefined {
  const key = value.trim()
  if (!key) return 'Enter the licence key from your purchase receipt.'
  if (/\s/.test(key)) return 'A licence key does not contain spaces.'
  if (!key.startsWith(LICENSE_KEY_PREFIX) || key.length === LICENSE_KEY_PREFIX.length) {
    return `A ${CLI_NAME} licence key starts with ${LICENSE_KEY_PREFIX}. Copy it from your purchase receipt or the customer portal.`
  }
  return undefined
}

export function readLicenseKeyFromEnvironment(
  environment: Record<string, string | undefined> = process.env,
): string | undefined {
  return environment[LICENSE_KEY_VARIABLE]?.trim() || undefined
}

export function normalizeSourceVersion(value: string): string {
  const trimmed = value.trim()
  const releaseTag = trimmed.startsWith('v') ? trimmed : `v${trimmed}`
  if (!RELEASE_TAG_PATTERN.test(releaseTag)) {
    throw new Error(`Source version must be an immutable release such as 1.2.3: ${value}`)
  }
  return releaseTag
}

export function releaseAssetNames(releaseTag: string): ReleaseAssetNames {
  const artifact = `foundation-source-${releaseTag}.tar.gz`
  return {
    artifact,
    checksum: `${artifact}.sha256`,
    manifest: `foundation-source-${releaseTag}.manifest.json`,
  }
}

function describeFailure(status: number, subject: string): string {
  if (status === 401) {
    return 'That licence key was not accepted. Copy it exactly from your purchase receipt or the customer portal (polar.sh).'
  }
  if (status === 429) {
    return 'Too many download requests for this licence key. Wait a minute and try again.'
  }
  if (status === 404) return `${subject} is not available for download.`
  if (status >= 500) {
    return 'Source delivery is temporarily unavailable. Wait a few minutes and try again.'
  }
  return `Source delivery refused the request (HTTP ${status}).`
}

async function requestDelivery(url: string, init: RequestInit, subject: string): Promise<Response> {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch {
    throw new Error('Could not reach source delivery. Check your network connection and try again.')
  }
  if (!response.ok) throw new Error(describeFailure(response.status, subject))
  return response
}

export async function resolveRelease(
  licenseKey: string,
  baseUrl = deliveryBaseUrl(),
): Promise<ReleaseIndex> {
  const response = await requestDelivery(
    `${baseUrl}/v1/releases`,
    {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({key: licenseKey}),
      signal: AbortSignal.timeout(INDEX_TIMEOUT_MS),
    },
    'The release index',
  )

  let index: ReleaseIndex | undefined
  try {
    index = (await response.json()) as ReleaseIndex
  } catch {
    index = undefined
  }
  if (!index || !RELEASE_TAG_PATTERN.test(index.latest) || !Array.isArray(index.versions)) {
    throw new Error(`Source delivery returned an unreadable release index.`)
  }
  return index
}

export async function downloadAsset(
  licenseKey: string,
  releaseTag: string,
  assetName: string,
  directory: string,
  baseUrl = deliveryBaseUrl(),
): Promise<string> {
  const response = await requestDelivery(
    `${baseUrl}/v1/source/${encodeURIComponent(releaseTag)}/${encodeURIComponent(assetName)}`,
    {
      headers: {authorization: `Bearer ${licenseKey}`},
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    },
    releaseTag,
  )
  if (!response.body) throw new Error(`Source delivery returned an empty ${assetName}.`)

  const path = join(directory, assetName)
  try {
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(path),
    )
  } catch {
    await rm(path, {force: true})
    throw new Error(`Downloading ${assetName} was interrupted. Try again in a few minutes.`)
  }
  return path
}
