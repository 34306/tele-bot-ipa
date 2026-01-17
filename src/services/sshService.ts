import { Client } from 'ssh2';
import SftpClient from 'ssh2-sftp-client';

export class SSHService {
  private host: string;
  private port: number;
  private username: string;
  private password: string;
  private sftp: SftpClient;

  constructor(host: string, port: number, username: string, password: string) {
    this.host = host;
    this.port = port;
    this.username = username;
    this.password = password;
    this.sftp = new SftpClient();
  }

  async connect(): Promise<void> {
    await this.sftp.connect({
      host: this.host,
      port: this.port,
      username: this.username,
      password: this.password,
    });
  }

  async disconnect(): Promise<void> {
    await this.sftp.end();
  }

  async executeCommand(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      
      conn.on('ready', () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            conn.end();
            reject(err);
            return;
          }

          let output = '';
          let errorOutput = '';

          stream.on('close', (code: number, signal: string) => {
            conn.end();
            if (code !== 0) {
              reject(new Error(`Command failed with code ${code}: ${errorOutput || output}`));
            } else {
              resolve(output);
            }
          });

          stream.on('data', (data: Buffer) => {
            const text = data.toString();
            output += text;
            // Log real-time output for long-running commands
            if (text.trim()) {
              console.log(`[SSH] ${text.trim()}`);
            }
          });

          stream.stderr.on('data', (data: Buffer) => {
            const text = data.toString();
            errorOutput += text;
            // Log stderr output
            if (text.trim()) {
              console.log(`[SSH] stderr: ${text.trim()}`);
            }
          });
        });
      });

      conn.on('error', (err) => {
        reject(err);
      });

      conn.connect({
        host: this.host,
        port: this.port,
        username: this.username,
        password: this.password,
      });
    });
  }

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    await this.sftp.put(localPath, remotePath);
  }

  async downloadFile(remotePath: string, localPath: string): Promise<void> {
    await this.sftp.get(remotePath, localPath);
  }

  async fileExists(remotePath: string): Promise<boolean> {
    try {
      await this.sftp.stat(remotePath);
      return true;
    } catch {
      return false;
    }
  }

  async listFiles(remotePath: string): Promise<string[]> {
    const files = await this.sftp.list(remotePath);
    return files.map(file => file.name);
  }

  async deleteFile(remotePath: string): Promise<void> {
    try {
      await this.sftp.delete(remotePath);
      console.log(`[SSHService] Deleted file: ${remotePath}`);
    } catch (error: any) {
      // Try using SSH command as fallback
      try {
        await this.executeCommand(`rm -f "${remotePath}"`);
        console.log(`[SSHService] Deleted file via SSH: ${remotePath}`);
      } catch (sshError: any) {
        throw new Error(`Failed to delete file ${remotePath}: ${sshError.message}`);
      }
    }
  }

  async createDirectory(remotePath: string): Promise<void> {
    try {
      await this.sftp.mkdir(remotePath, true);
    } catch (error: any) {
      if (error.code === 4 || error.message?.includes('already exists') || error.message?.includes('No SFTP connection')) {
        // Directory already exists or SFTP not connected, try SSH command instead
        console.log(`[SSHService] SFTP mkdir failed (${error.message}), trying SSH command...`);
        try {
          await this.executeCommand(`mkdir -p "${remotePath}"`);
          console.log(`[SSHService] Directory created via SSH command`);
        } catch (sshError: any) {
          // If directory already exists via SSH, that's fine
          if (sshError.message?.includes('File exists') || sshError.message?.includes('already exists')) {
            console.log(`[SSHService] Directory already exists`);
            return;
          }
          throw new Error(`Failed to create directory: ${error.message} (SSH fallback also failed: ${sshError.message})`);
        }
      } else {
        throw error;
      }
    }
  }

  async ensureConnected(): Promise<void> {
    try {
      // Try to list current directory to check connection
      await this.sftp.list('.');
    } catch (error: any) {
      if (error.message?.includes('No SFTP connection') || error.message?.includes('not connected')) {
        console.log(`[SSHService] SFTP not connected, reconnecting...`);
        await this.connect();
      } else {
        // Other errors might be fine, just reconnect to be safe
        console.log(`[SSHService] Connection check failed, reconnecting: ${error.message}`);
        await this.connect();
      }
    }
  }
}
