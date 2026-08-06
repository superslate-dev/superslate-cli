import {spawn} from 'node:child_process'
import {text} from 'node:stream/consumers'

export interface ProcessResult {
  exitCode: number
  stdout: string
  stderr: string
}

export async function runProcess(
  command: string,
  argv: string[],
  options: {cwd: string; env?: NodeJS.ProcessEnv},
): Promise<ProcessResult> {
  const child = spawn(command, argv, {
    cwd: options.cwd,
    ...(options.env ? {env: options.env} : {}),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    text(child.stdout),
    text(child.stderr),
    new Promise<number>((settle, fail) => {
      child.once('error', fail)
      child.once('close', code => settle(code ?? 1))
    }),
  ])
  return {stdout, stderr, exitCode}
}
