/**
 * Minimal local subprocess owner for tests: projects Node's child_process
 * handle onto the `SubprocessHandle` shape the provider consumes.
 */
import { spawn } from 'node:child_process'

/**
 * @param {import('@deepseek-ai/dsh-subprocess').SubprocessSpawnSpec} spec
 * @returns {import('@deepseek-ai/dsh-subprocess').SubprocessHandle}
 */
export function localSpawn(spec) {
  const child = spawn(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: [spec.stdio?.stdin ?? 'pipe', spec.stdio?.stdout ?? 'pipe', spec.stdio?.stderr ?? 'inherit'],
  })
  const done = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
  })
  done.catch(() => {})
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr ?? undefined,
    control: undefined,
    collected: {},
    done,
    terminate() {
      child.kill('SIGTERM')
    },
    async waitForExit() {
      await done.catch(() => {})
      return true
    },
  }
}
