import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ExecResult {
  ok: boolean;
  code: number | string;
  stdout: string;
  stderr: string;
}

export async function runCommand(
  command: string,
  args: string[] = [],
  timeoutMs = 15_000
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true
    });
    return {
      ok: true,
      code: 0,
      stdout: stdout.trim(),
      stderr: stderr.trim()
    };
  } catch (err: unknown) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      code: e.code ?? 1,
      stdout: (e.stdout ?? '').trim(),
      stderr: (e.stderr ?? e.message ?? '').trim()
    };
  }
}
