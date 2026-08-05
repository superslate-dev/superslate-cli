import {spawn, type ChildProcess} from 'node:child_process'
import {accessSync, constants, realpathSync} from 'node:fs'
import {delimiter, join, resolve as resolvePath} from 'node:path'
import {fileURLToPath} from 'node:url'

export interface CaptureResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface RunOptions {
  cwd: string
  env?: NodeJS.ProcessEnv
}

export function runCaptured(command: string[], options: RunOptions): Promise<CaptureResult> {
  const [file, ...args] = command
  if (!file) throw new Error('runCaptured requires a command')
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      resolve({exitCode: code ?? (signal ? 1 : 0), stdout, stderr})
    })
  })
}

export function runInherited(command: string[], options: RunOptions): Promise<number> {
  const [file, ...args] = command
  if (!file) throw new Error('runInherited requires a command')
  return new Promise<number>((resolve, reject) => {
    const child: ChildProcess = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: 'inherit',
    })
    child.on('error', reject)
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      resolve(code ?? (signal === 'SIGINT' ? 130 : 1))
    })
  })
}

export function which(command: string): string | null {
  if (command.includes('/')) return isExecutable(command) ? command : null
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT ?? '').split(';') : ['']
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`)
      if (isExecutable(candidate)) return candidate
    }
  }
  return null
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolvePath(path)
  }
}

export function isEntrypoint(moduleUrl: string): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return canonicalPath(fileURLToPath(moduleUrl)) === canonicalPath(entry)
  } catch {
    return false
  }
}
