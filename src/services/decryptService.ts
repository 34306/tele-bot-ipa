import { SSHService } from './sshService';

export class DecryptService {
  constructor(
    private ssh: SSHService,
    private decryptedPath: string = '/var/mobile/Documents/decrypted'
  ) {}

  async decryptApp(bundleId: string, appName?: string): Promise<string> {
    console.log(`[DecryptService] Starting decryption for bundle ID: ${bundleId}`);
    
    // Ensure decrypted directory exists using SSH command (no SFTP needed for decrypt)
    try {
      await this.ssh.executeCommand(`mkdir -p "${this.decryptedPath}"`);
      console.log(`[DecryptService] Directory ensured: ${this.decryptedPath}`);
    } catch (error: any) {
      console.warn(`[DecryptService] Failed to create directory: ${error.message}`);
      // Continue anyway, directory might already exist
    }

    // Run trolldecryptjb directly with bundle ID using full path
    // /usr/local/bin/trolldecryptjb <bundle-id> <output-path>
    // Note: trolldecryptjb automatically generates the output filename
    const command = `/usr/local/bin/trolldecryptjb ${bundleId} ${this.decryptedPath}`;
    
    try {
      console.log(`[DecryptService] Executing: ${command}`);
      const output = await this.ssh.executeCommand(command);
      console.log(`[DecryptService] trolldecryptjb completed. Output:\n${output}`);
      
      // trolldecryptjb generates filename automatically, so we need to find it
      // Wait a bit for file to be created
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Use SSH command to find the decrypted file (no SFTP needed)
      // Find the most recent IPA file in decrypted directory
      const findCommand = `ls -t "${this.decryptedPath}"/*.ipa 2>/dev/null | head -1`;
      const filePath = await this.ssh.executeCommand(findCommand);
      const decryptedFilePath = filePath.trim();
      
      if (!decryptedFilePath || !decryptedFilePath.endsWith('.ipa')) {
        throw new Error(`No IPA file found in ${this.decryptedPath} after decryption`);
      }
      
      console.log(`[DecryptService] Found decrypted file: ${decryptedFilePath}`);
      console.log(`[DecryptService] Decryption completed: ${decryptedFilePath}`);
      return decryptedFilePath;
    } catch (error: any) {
      console.error(`[DecryptService] Decryption failed:`, error);
      console.error(`[DecryptService] Error details:`, {
        message: error.message,
        stack: error.stack,
        bundleId: bundleId
      });
      
      // Provide more detailed error message
      let errorMessage = error.message || 'Unknown error';
      
      if (errorMessage.includes('Failed to get app information')) {
        errorMessage = `Failed to get app information for bundle ID '${bundleId}'. ` +
          `Make sure the app is installed on the device and the bundle ID is correct.`;
      } else if (errorMessage.includes('No IPA file found')) {
        errorMessage = `No IPA file found after decryption. ` +
          `The decryption process may have failed. Check trolldecryptjb output above.`;
      } else if (errorMessage.includes('Command failed')) {
        errorMessage = `Command execution failed: ${errorMessage}`;
      }
      
      throw new Error(`Failed to decrypt app: ${errorMessage}`);
    }
  }

  private async findAppBundle(bundleId: string, retries: number = 3): Promise<string | null> {
    const command = `find /private/var/containers/Bundle/Application -name "*.app" -type d 2>/dev/null`;
    
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        console.log(`[DecryptService] Finding app bundle for ${bundleId} (attempt ${attempt}/${retries})`);
        const output = await this.ssh.executeCommand(command);
        const appPaths = output.trim().split('\n').filter(line => line.trim());
        
        console.log(`[DecryptService] Found ${appPaths.length} app bundles`);
        
        for (const appPath of appPaths) {
          const infoPlistPath = `${appPath}/Info.plist`;
          const exists = await this.ssh.fileExists(infoPlistPath);
          
          if (exists) {
            // Check if bundle ID matches
            const checkCommand = `plutil -extract CFBundleIdentifier raw "${infoPlistPath}" 2>/dev/null || echo ""`;
            const bundleIdOutput = await this.ssh.executeCommand(checkCommand);
            const foundBundleId = bundleIdOutput.trim().replace(/"/g, '');
            
            console.log(`[DecryptService] Checking ${appPath}: bundleId=${foundBundleId}`);
            
            if (foundBundleId === bundleId) {
              console.log(`[DecryptService] Found app bundle: ${appPath}`);
              return appPath;
            }
          }
        }
        
        // If not found and not last attempt, wait and retry
        if (attempt < retries) {
          console.log(`[DecryptService] App bundle not found, waiting 3 seconds before retry...`);
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      } catch (error: any) {
        console.error(`[DecryptService] Error finding app bundle (attempt ${attempt}):`, error.message);
        if (attempt < retries) {
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }
    }
    
    console.error(`[DecryptService] App bundle not found after ${retries} attempts`);
    return null;
  }

  private async getAppName(appPath: string): Promise<string> {
    const infoPlistPath = `${appPath}/Info.plist`;
    const command = `plutil -extract CFBundleName raw "${infoPlistPath}" 2>/dev/null || plutil -extract CFBundleDisplayName raw "${infoPlistPath}" 2>/dev/null || echo "App"`;
    
    try {
      const output = await this.ssh.executeCommand(command);
      return output.trim().replace(/"/g, '') || 'App';
    } catch {
      return 'App';
    }
  }

  private async getAppVersion(appPath: string): Promise<string> {
    const infoPlistPath = `${appPath}/Info.plist`;
    const command = `plutil -extract CFBundleShortVersionString raw "${infoPlistPath}" 2>/dev/null || echo "1.0"`;
    
    try {
      const output = await this.ssh.executeCommand(command);
      return output.trim().replace(/"/g, '') || '1.0';
    } catch {
      return '1.0';
    }
  }
}
