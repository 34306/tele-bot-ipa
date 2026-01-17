import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const execAsync = promisify(exec);

/**
 * Execute a local shell command
 */
export async function executeLocalCommand(command: string, options?: { cwd?: string }): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: options?.cwd,
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
    });
    
    if (stderr && !stdout) {
      throw new Error(stderr);
    }
    
    return stdout.trim();
  } catch (error: any) {
    throw new Error(`Command failed: ${error.message}`);
  }
}

/**
 * Check if a file exists locally
 */
export function localFileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

/**
 * Create directory if it doesn't exist
 */
export function ensureLocalDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Get project root directory (where package.json is located)
 */
function getProjectRoot(): string {
  // When compiled, __dirname will be in dist/utils, so go up 2 levels
  // When running from source, __dirname will be in src/utils, so go up 2 levels
  const currentDir = __dirname;
  const isCompiled = currentDir.includes('dist');
  
  if (isCompiled) {
    // dist/utils -> dist -> project root
    return path.resolve(currentDir, '..', '..');
  } else {
    // src/utils -> src -> project root
    return path.resolve(currentDir, '..', '..');
  }
}

/**
 * Get local temp directory for IPA files (in project root)
 */
export function getLocalIPADirectory(): string {
  const projectRoot = getProjectRoot();
  const ipaDir = path.join(projectRoot, 'ipa-files');
  ensureLocalDirectory(ipaDir);
  return ipaDir;
}

/**
 * Get encrypted IPA directory
 */
export function getEncryptedIPADirectory(): string {
  const dir = path.join(getLocalIPADirectory(), 'encrypted');
  ensureLocalDirectory(dir);
  return dir;
}

/**
 * Get decrypted IPA directory
 */
export function getDecryptedIPADirectory(): string {
  const dir = path.join(getLocalIPADirectory(), 'decrypted');
  ensureLocalDirectory(dir);
  return dir;
}

/**
 * Find file by pattern in directory
 */
export function findFileByPattern(dir: string, pattern: string): string | null {
  try {
    const files = fs.readdirSync(dir);
    const matchingFile = files.find(file => file.includes(pattern));
    return matchingFile ? path.join(dir, matchingFile) : null;
  } catch {
    return null;
  }
}
