import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Api } from 'telegram/tl';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

export class UploadService {
  private client: TelegramClient | null = null;
  private apiId: number;
  private apiHash: string;
  private sessionString: string;
  public backupChannelId: string; // Make public for access in handlers

  constructor(
    apiId: number,
    apiHash: string,
    sessionString: string,
    backupChannelId: string
  ) {
    this.apiId = apiId;
    this.apiHash = apiHash;
    this.sessionString = sessionString;
    this.backupChannelId = backupChannelId;
  }

  async connect(): Promise<void> {
    if (this.client && this.client.connected) {
      return;
    }

    const stringSession = new StringSession(this.sessionString);
    this.client = new TelegramClient(stringSession, this.apiId, this.apiHash, {
      connectionRetries: 5,
    });

    await this.client.connect();
  }

  async disconnect(): Promise<void> {
    if (this.client && this.client.connected) {
      await this.client.disconnect();
    }
  }

  async uploadFile(filePath: string, caption?: string): Promise<number> {
    if (!this.client) {
      await this.connect();
    }

    if (!this.client || !this.client.connected) {
      throw new Error('Telegram client not connected');
    }

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    try {
      // Parse channel ID (can be negative for groups/channels)
      // Channel ID format: -1001234567890 (for supergroups/channels)
      const channelId = this.backupChannelId.startsWith('-100')
        ? this.backupChannelId
        : `-100${this.backupChannelId.replace('-', '')}`;
      
      // Upload file to backup channel
      const message = await this.client.sendFile(
        channelId as any,
        {
          file: filePath,
          caption: caption || '',
          forceDocument: true,
        }
      );

      // Return message ID
      if (message && 'id' in message) {
        return message.id;
      }
      
      throw new Error('Failed to get message ID after upload');
    } catch (error: any) {
      throw new Error(`Failed to upload file: ${error.message}`);
    }
  }

  async uploadFileWithProgress(
    filePath: string,
    caption?: string,
    onProgress?: (uploaded: number, total: number) => void,
    thumbnailPath?: string
  ): Promise<number> {
    // Log for debugging
    console.log(`[UploadService] Starting upload: ${filePath}`);
    if (!this.client) {
      await this.connect();
    }

    if (!this.client || !this.client.connected) {
      throw new Error('Telegram client not connected');
    }

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    try {
      // Parse channel ID (can be negative for groups/channels)
      const channelId = this.backupChannelId.startsWith('-100')
        ? this.backupChannelId
        : `-100${this.backupChannelId.replace('-', '')}`;
      
      const fileSize = fs.statSync(filePath).size;

      // Create progress callback
      // GramJS progressCallback may return progress as percentage (0-1) instead of bytes
      const progressCallback = onProgress
        ? (downloaded: number | bigint, total: number | bigint) => {
            // Convert BigInt to number if needed
            const progressValue = typeof downloaded === 'bigint' ? Number(downloaded) : downloaded;
            
            // Check if progressValue is a percentage (0-1) or bytes
            let downloadedBytes: number;
            let totalBytes: number = fileSize;
            
            if (progressValue >= 0 && progressValue <= 1) {
              // It's a percentage (0-1)
              downloadedBytes = progressValue * fileSize;
            } else {
              // It's bytes
              downloadedBytes = progressValue;
              if (total !== undefined && total !== null) {
                totalBytes = typeof total === 'bigint' ? Number(total) : total;
              }
            }
            
            // Validate values
            if (isNaN(downloadedBytes) || downloadedBytes < 0 || totalBytes <= 0) {
              return; // Silently ignore invalid values
            }
            
            try {
              // Pass downloaded bytes and total bytes (no speed calculation)
              onProgress(downloadedBytes, totalBytes);
            } catch (progressError) {
              // Ignore progress callback errors (might timeout)
              console.warn(`[UploadService] Progress callback error: ${progressError}`);
            }
          }
        : undefined;

      // Prepare upload options
      // Using workers: 8 for faster uploads
      // Progress tracking works with proper speed calculation (average + instant)
      const uploadOptions: any = {
        file: filePath,
        caption: caption || '',
        forceDocument: true,
        progressCallback,
        workers: 8, // Use 8 workers for faster uploads (2-8 is safe range)
      };

      // Add thumbnail if provided
      if (thumbnailPath && fs.existsSync(thumbnailPath)) {
        uploadOptions.thumb = thumbnailPath;
      }

      // Wrap sendFile to handle GramJS internal 90s timeout
      // GramJS uses p-timeout internally with 90s default, but upload may still succeed
      let message: any;
      try {
        message = await this.client.sendFile(
          channelId as any,
          uploadOptions
        );
      } catch (uploadError: any) {
        // If it's the 90s timeout from p-timeout, check if upload actually succeeded
        if (uploadError.message && (
          uploadError.message.includes('timeout') || 
          uploadError.message.includes('TimeoutError') ||
          uploadError.message.includes('90000')
        )) {
          console.warn(`[UploadService] GramJS timeout detected (90s), checking if upload succeeded...`);
          
          // Wait a bit for upload to complete
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          // Try to get the latest message from channel
          try {
            const messages = await this.client!.getMessages(channelId as any, { limit: 1 });
            if (messages && messages.length > 0 && messages[0] && 'id' in messages[0]) {
              console.log(`[UploadService] Found message ID ${messages[0].id} after timeout - upload succeeded!`);
              message = messages[0];
            } else {
              throw new Error('No message found after timeout');
            }
          } catch (fallbackError: any) {
            console.warn(`[UploadService] Failed to get message after timeout: ${fallbackError.message}`);
            // Re-throw original error
            throw uploadError;
          }
        } else {
          // Not a timeout error, re-throw
          throw uploadError;
        }
      }

      if (message && 'id' in message) {
        return message.id;
      }
      
      throw new Error('Failed to get message ID after upload');
    } catch (error: any) {
      // Check if it's a timeout but upload might have succeeded
      if (error.message && (error.message.includes('timeout') || error.message.includes('TimeoutError'))) {
        console.warn(`[UploadService] Upload timeout detected: ${error.message}`);
        // Try to get the latest message from channel as fallback
        try {
          const channelId = this.backupChannelId.startsWith('-100')
            ? this.backupChannelId
            : `-100${this.backupChannelId.replace('-', '')}`;
          
          // Get messages from channel to find the uploaded file
          const messages = await this.client!.getMessages(channelId as any, { limit: 1 });
          if (messages && messages.length > 0 && messages[0] && 'id' in messages[0]) {
            console.log(`[UploadService] Found message ID ${messages[0].id} after timeout - upload likely succeeded`);
            return messages[0].id;
          }
        } catch (fallbackError: any) {
          console.warn(`[UploadService] Failed to get message ID after timeout: ${fallbackError.message}`);
        }
      }
      throw new Error(`Failed to upload file: ${error.message}`);
    }
  }

  /**
   * Download artwork image from URL
   */
  async downloadArtwork(artworkUrl: string, outputPath: string): Promise<string> {
    try {
      const response = await axios({
        url: artworkUrl,
        method: 'GET',
        responseType: 'stream',
      });

      // Ensure directory exists
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const writer = fs.createWriteStream(outputPath);
      response.data.pipe(writer);

      return new Promise((resolve, reject) => {
        writer.on('finish', () => resolve(outputPath));
        writer.on('error', reject);
      });
    } catch (error: any) {
      throw new Error(`Failed to download artwork: ${error.message}`);
    }
  }

  /**
   * Search for existing file in backup channel by app name, bundle ID, and version
   * Returns message ID if found, null otherwise
   */
  async findExistingFile(
    trackName: string,
    bundleId: string,
    version: string
  ): Promise<number | null> {
    if (!this.client) {
      await this.connect();
    }

    if (!this.client || !this.client.connected) {
      throw new Error('Telegram client not connected');
    }

    try {
      const channelId = this.backupChannelId.startsWith('-100')
        ? this.backupChannelId
        : `-100${this.backupChannelId.replace('-', '')}`;

      // Search recent messages (last 200 messages should be enough)
      const messages = await this.client.getMessages(channelId as any, { limit: 200 });
      
      if (!messages || messages.length === 0) {
        console.log(`[UploadService] No messages found in backup channel`);
        return null;
      }

      // Normalize search terms (lowercase, remove special chars for comparison)
      const normalize = (text: string): string => {
        return text.toLowerCase().trim().replace(/[^\w\s]/g, '');
      };

      const normalizedTrackName = normalize(trackName);
      const normalizedBundleId = normalize(bundleId);
      const normalizedVersion = normalize(version);

      console.log(`[UploadService] Searching for: "${trackName}" (${bundleId}) v${version}`);

      // Search through messages (newest first)
      for (const message of messages) {
        if (!message || !('message' in message) || !message.message) {
          continue;
        }

        const caption = message.message;
        if (!caption || typeof caption !== 'string') {
          continue;
        }

        // Check if caption contains bundle ID and version
        const normalizedCaption = normalize(caption);
        
        // Check if message has bundle ID and version
        const hasBundleId = normalizedCaption.includes(normalizedBundleId);
        const hasVersion = normalizedCaption.includes(normalizedVersion);
        const hasTrackName = normalizedCaption.includes(normalizedTrackName);

        // Also check for version in format "Version: X" or "vX"
        const versionPattern = new RegExp(`(version|v)[\\s:]*${normalizedVersion.replace(/\./g, '\\.')}`, 'i');
        const hasVersionPattern = versionPattern.test(normalizedCaption);

        // Match if has bundle ID and (version or track name)
        if (hasBundleId && (hasVersion || hasVersionPattern || hasTrackName)) {
          // Additional check: verify bundle ID is exact match (not substring)
          const bundleIdPattern = new RegExp(`\\b${normalizedBundleId.replace(/\./g, '\\.')}\\b`, 'i');
          if (bundleIdPattern.test(normalizedCaption)) {
            console.log(`[UploadService] Found matching file in backup channel: ${message.id}`);
            console.log(`[UploadService] Caption: ${caption.substring(0, 100)}...`);
            return message.id;
          }
        }
      }

      console.log(`[UploadService] No matching file found in backup channel`);
      return null;
    } catch (error: any) {
      console.warn(`[UploadService] Error searching backup channel: ${error.message}`);
      return null; // Return null on error, don't block the flow
    }
  }
}
