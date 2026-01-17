import axios from 'axios';
import { 
  executeLocalCommand, 
  getEncryptedIPADirectory, 
  findFileByPattern,
  localFileExists,
  ensureLocalDirectory 
} from '../utils/localCommand';
import * as path from 'path';

export class IPAToolService {
  private ipatoolPath: string;

  constructor(ipatoolPath: string = 'ipatool') {
    this.ipatoolPath = ipatoolPath;
  }

  async getAppInfo(appId: string, country: string = 'us'): Promise<any> {
    // Use iTunes API lookup - run locally
    const cacheBust = Date.now();
    const lookupUrl = `https://itunes.apple.com/lookup?id=${appId}&country=${country}&cacheBust=${cacheBust}`;
    
    try {
      const response = await axios.get(lookupUrl);
      const data = response.data;
      
      // Check for errors in the response
      if (data.errorMessage) {
        throw new Error(data.errorMessage);
      }
      
      // Check if results exist
      if (!data.results || data.results.length === 0) {
        throw new Error(`No results found for the given app id: ${appId}`);
      }
      
      const appInfo = data.results[0];
      
      // Extract fields like in the bash script
      return {
        bundleId: appInfo.bundleId,
        bundle_id: appInfo.bundleId, // Alias for compatibility
        trackId: appInfo.trackId,
        trackName: appInfo.trackName,
        version: appInfo.version,
        artistName: appInfo.artistName,
        price: appInfo.price || 0,
        fileSizeBytes: appInfo.fileSizeBytes,
        primaryGenreName: appInfo.primaryGenreName,
        description: appInfo.description,
        artworkUrl512: appInfo.artworkUrl512,
        releaseNotes: appInfo.releaseNotes,
        currentVersionReleaseDate: appInfo.currentVersionReleaseDate,
        trackViewUrl: appInfo.trackViewUrl,
      };
    } catch (error: any) {
      if (error.response) {
        throw new Error(`iTunes API error: ${error.response.statusText}`);
      }
      if (error.message) {
        throw new Error(`Failed to get app info: ${error.message}`);
      }
      throw new Error(`Failed to get app info: ${error}`);
    }
  }


  /**
   * Purchase app (for free apps, this is required before download)
   * Returns true if purchase succeeded, false if already purchased (skip)
   */
  async purchaseApp(bundleId: string): Promise<boolean> {
    const command = `${this.ipatoolPath} purchase --non-interactive --bundle-identifier "${bundleId}"`;
    
    try {
      const output = await executeLocalCommand(command);
      
      // Remove ANSI color codes for easier parsing
      const cleanOutput = output.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
      
      // Check if purchase was successful
      if (cleanOutput.includes('success=true')) {
        console.log(`[IPAToolService] Successfully purchased app: ${bundleId}`);
        return true;
      }
      
      // Check if already purchased (common error when trying to purchase again)
      if (cleanOutput.includes('success=false') && 
          (cleanOutput.includes('failed to purchase item') || 
           cleanOutput.includes('An unknown error has occurred'))) {
        console.log(`[IPAToolService] App already purchased (skipping): ${bundleId}`);
        return false; // Already purchased, skip but continue
      }
      
      // Other errors - throw
      throw new Error(`Purchase failed: ${cleanOutput}`);
    } catch (error: any) {
      // If error message suggests already purchased, skip
      const errorMsg = error.message || error.toString();
      if (errorMsg.includes('failed to purchase item') || 
          errorMsg.includes('An unknown error has occurred')) {
        console.log(`[IPAToolService] App already purchased (skipping): ${bundleId}`);
        return false; // Already purchased, skip but continue
      }
      
      throw new Error(`Failed to purchase app: ${error.message}`);
    }
  }

  async downloadIPA(bundleId: string, country: string = 'us'): Promise<string> {
    // Download IPA using ipatool locally
    const outputDir = getEncryptedIPADirectory();
    ensureLocalDirectory(outputDir);

    // Check if file already exists
    const existingFile = findFileByPattern(outputDir, bundleId);
    if (existingFile && localFileExists(existingFile)) {
      return existingFile;
    }

    // Build ipatool command (no --purchase flag needed, purchase is done separately)
    const command = `${this.ipatoolPath} --non-interactive download -b "${bundleId}" -o "${outputDir}" --format json`;
    
    try {
      const output = await executeLocalCommand(command);
      
      // Check for errors
      if (output.includes('error')) {
        throw new Error(`Download of app failed: ${output}`);
      }
      
      // Find the downloaded file
      const downloadedFile = findFileByPattern(outputDir, bundleId);
      if (!downloadedFile || !localFileExists(downloadedFile)) {
        throw new Error(`File not found in the downloads directory after download`);
      }
      
      return downloadedFile;
    } catch (error: any) {
      throw new Error(`Failed to download IPA: ${error.message}`);
    }
  }
}
