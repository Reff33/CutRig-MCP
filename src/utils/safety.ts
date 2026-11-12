import { access, copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const BLOCKED_BASENAMES = new Set(['.env', '.git', 'id_rsa', 'id_ed25519']);
const BLOCKED_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx']);

export function resolveSafePath(inputPath: string, workspaceRoot?: string): string {
  if (!inputPath || !inputPath.trim()) {
    throw new Error('Path cannot be empty.');
  }

  const resolved = path.resolve(workspaceRoot ?? process.cwd(), inputPath);
  const segments = resolved.split(path.sep).map((s) => s.toLowerCase());
  const base = path.basename(resolved).toLowerCase();
  const ext = path.extname(resolved).toLowerCase();

  if (
    BLOCKED_BASENAMES.has(base) ||
    base.startsWith('.env.') ||
    segments.includes('.git') ||
    segments.includes('.ssh') ||
    BLOCKED_EXTENSIONS.has(ext)
  ) {
    throw new Error(`Access blocked for sensitive path: ${inputPath}`);
  }

  if (workspaceRoot) {
    const root = path.resolve(workspaceRoot);
    const rel = path.relative(root, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Path escapes workspace root: ${inputPath}`);
    }
  }

  return resolved;
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function backupIfExists(filePath: string): Promise<string | null> {
  if (!(await fileExists(filePath))) return null;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${filePath}.${stamp}.bak`;
  await copyFile(filePath, backupPath);
  return backupPath;
}

export async function prepareOutputPath(
  rawOutputPath: string,
  protectedInputPaths: string[],
  options: { workspaceRoot?: string; overwrite?: boolean; createDir?: boolean } = {}
): Promise<{ outputPath: string; backupPath: string | null }> {
  let outputPath = resolveSafePath(rawOutputPath, options.workspaceRoot);

  const normalizedInputs = new Set(protectedInputPaths.map((p) => path.resolve(p).toLowerCase()));
  if (normalizedInputs.has(outputPath.toLowerCase())) {
    throw new Error(`Refusing to overwrite input source file: ${outputPath}`);
  }

  let backupPath: string | null = null;
  if (await fileExists(outputPath)) {
    if (options.overwrite) {
      backupPath = await backupIfExists(outputPath);
    } else {
      const parsed = path.parse(outputPath);
      let idx = 1;
      let candidate = path.join(parsed.dir, `${parsed.name}_${idx}${parsed.ext}`);
      while (await fileExists(candidate)) {
        idx++;
        candidate = path.join(parsed.dir, `${parsed.name}_${idx}${parsed.ext}`);
      }
      outputPath = candidate;
    }
  }

  if (options.createDir !== false) {
    await mkdir(path.dirname(outputPath), { recursive: true });
  }

  return { outputPath, backupPath };
}
