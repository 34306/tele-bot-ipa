import { SSHService } from './sshService';
import { executeLocalCommand } from '../utils/localCommand';

export class DeviceService {
  private udid: string;

  constructor(
    private ssh: SSHService,
    private useLocal: boolean = false,
    udid?: string
  ) {
    this.udid = udid || '';
  }

  private buildCommand(baseCommand: string, isUninstall: boolean = false): string {
    if (this.udid && this.useLocal) {
      // For ideviceinstaller, -u is used for UDID
      // Add -u UDID flag right after ideviceinstaller
      if (isUninstall) {
        // ideviceinstaller -u UDID uninstall BUNDLEID
        return baseCommand.replace(
          'ideviceinstaller uninstall',
          `ideviceinstaller -u ${this.udid} uninstall`
        );
      } else {
        // ideviceinstaller -u UDID install PATH or ideviceinstaller -u UDID -l
        // Replace first occurrence of ideviceinstaller with ideviceinstaller -u UDID
        // This ensures -u UDID comes right after ideviceinstaller, before other flags like -w or -l
        return baseCommand.replace(
          /^ideviceinstaller/,
          `ideviceinstaller -u ${this.udid}`
        );
      }
    }
    return baseCommand;
  }

  async installApp(ipaPath: string): Promise<void> {
    const command = this.buildCommand(`ideviceinstaller -w install "${ipaPath}"`, false);
    
    try {
      if (this.useLocal) {
        console.log(`[DeviceService] Executing install command: ${command}`);
        const output = await executeLocalCommand(command);
        console.log(`[DeviceService] Install output: ${output}`);
        
        if (!output.includes('Install: Complete')) {
          const errorMsg = `Installation failed. Command: ${command}\nOutput: ${output}`;
          console.error(`[DeviceService] ${errorMsg}`);
          throw new Error(errorMsg);
        }
        console.log(`[DeviceService] Install completed successfully`);
      } else {
        console.log(`[DeviceService] Executing install via SSH: ${command}`);
        const output = await this.ssh.executeCommand(command);
        console.log(`[DeviceService] SSH install output: ${output}`);
      }
    } catch (error: any) {
      const errorDetails = {
        message: error.message,
        command: command,
        stack: error.stack,
        ipaPath: ipaPath,
        udid: this.udid || 'not specified',
        useLocal: this.useLocal
      };
      console.error(`[DeviceService] Install error details:`, JSON.stringify(errorDetails, null, 2));
      throw new Error(`Failed to install app: ${error.message}\nCommand: ${command}\nDetails: ${JSON.stringify(errorDetails, null, 2)}`);
    }
  }

  async uninstallApp(bundleId: string): Promise<void> {
    const command = this.buildCommand(`ideviceinstaller uninstall "${bundleId}"`, true);
    
    try {
      if (this.useLocal) {
        await executeLocalCommand(command);
      } else {
        await this.ssh.executeCommand(command);
      }
    } catch (error: any) {
      throw new Error(`Failed to uninstall app: ${error.message}`);
    }
  }

  async listInstalledApps(): Promise<string[]> {
    // When using UDID, always use local ideviceinstaller to ensure we're checking the correct device
    // Use 'list' instead of '-l' as ideviceinstaller doesn't support -l flag
    const command = this.buildCommand(`ideviceinstaller list`);
    
    try {
      // Always use local command when UDID is specified to ensure correct device
      // When UDID is set, we MUST use local ideviceinstaller, not SSH
      const output = (this.useLocal && this.udid) || this.useLocal
        ? await executeLocalCommand(command)
        : await this.ssh.executeCommand(command);
      
      console.log(`[DeviceService] List apps output: ${output.substring(0, 500)}`);
      console.log(`[DeviceService] Using UDID: ${this.udid || 'none'}, useLocal: ${this.useLocal}, command: ${command}`);
      
      // Parse CSV output from ideviceinstaller
      // Format: CFBundleIdentifier, CFBundleShortVersionString, CFBundleDisplayName
      // Example: vn.com.vinamilk.b2c, "1.0.111", "Vinamilk"
      const lines = output.split('\n').filter(line => line.trim());
      const bundleIds: string[] = [];
      
      for (const line of lines) {
        // Skip header line
        if (line.includes('CFBundleIdentifier')) {
          continue;
        }
        
        // Parse CSV: bundleId, version, name
        // Handle both formats: "bundleId, version, name" and "bundleId - App Name"
        const csvMatch = line.match(/^([^,\s]+)/);
        if (csvMatch) {
          const bundleId = csvMatch[1].trim();
          if (bundleId && !bundleId.includes('CFBundle')) {
            bundleIds.push(bundleId);
          }
        }
      }
      
      console.log(`[DeviceService] Found ${bundleIds.length} installed apps`);
      return bundleIds;
    } catch (error: any) {
      console.error(`[DeviceService] Failed to list apps:`, error);
      throw new Error(`Failed to list apps: ${error.message}`);
    }
  }

  async isAppInstalled(bundleId: string): Promise<boolean> {
    const apps = await this.listInstalledApps();
    const isInstalled = apps.includes(bundleId);
    console.log(`[DeviceService] Checking if ${bundleId} is installed: ${isInstalled}`);
    console.log(`[DeviceService] Installed apps sample: ${apps.slice(0, 5).join(', ')}`);
    return isInstalled;
  }

  async getAppInfo(bundleId: string): Promise<any> {
    // Use 'list' instead of '-l' as ideviceinstaller doesn't support -l flag
    const command = this.buildCommand(`ideviceinstaller list | grep "${bundleId}"`);
    
    try {
      // Always use local when UDID is set
      const output = (this.useLocal && this.udid) || this.useLocal
        ? await executeLocalCommand(command)
        : await this.ssh.executeCommand(command);
      return output.trim();
    } catch (error: any) {
      throw new Error(`Failed to get app info: ${error.message}`);
    }
  }
}
