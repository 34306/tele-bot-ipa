import { Context } from 'telegraf';
import { SSHService } from '../services/sshService';
import { IPAToolService } from '../services/ipatoolService';
import { DecryptService } from '../services/decryptService';
import { DeviceService } from '../services/deviceService';
import { UploadService } from '../services/uploadService';
import { ArcadeCheckService } from '../services/arcadeCheckService';
import { QueueService } from '../services/queueService';
import { extractAppId, extractCountryCode, isValidAppStoreUrl } from '../utils/urlParser';
import { getDecryptedIPADirectory } from '../utils/localCommand';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export class BotHandlers {
  private ipaTool: IPAToolService;
  private decrypt: DecryptService;
  private device: DeviceService;
  private upload: UploadService;
  private arcadeCheck: ArcadeCheckService;
  public queue: QueueService; // Public for access from index.ts
  private bot: any; // Telegraf bot instance
  private isProcessingQueue = false;
  private queueProcessorInterval: NodeJS.Timeout | null = null;
  private tempDir: string;
  private ownerId = 1255350210;

  constructor(
    private ssh: SSHService,
    uploadService: UploadService,
    bot: any,
    ipatoolPath?: string
  ) {
    this.ipaTool = new IPAToolService(ipatoolPath || 'ipatool');
    this.decrypt = new DecryptService(ssh);
    // Use local ideviceinstaller with UDID if provided
    const udid = process.env.DEVICE_UDID;
    this.device = new DeviceService(ssh, true, udid);
    
    // Warning: SSH_HOST must point to the same device as UDID
    if (udid) {
      console.log(`[BotHandlers] Using UDID: ${udid}`);
      console.log(`[BotHandlers] IMPORTANT: SSH_HOST (${process.env.SSH_HOST}) must point to the device with this UDID!`);
      console.log(`[BotHandlers] If SSH_HOST points to a different device, decryption will fail!`);
    }
    
    this.upload = uploadService;
    this.bot = bot;
    this.arcadeCheck = new ArcadeCheckService(process.env.ARCADE_CHECK_URL || 'http://localhost:8080/check-arcade.php');
    this.queue = new QueueService();
    this.tempDir = path.join(os.tmpdir(), 'telegram-bot-ipa');
    
    // Ensure temp directory exists
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }

    // Start queue processor
    this.startQueueProcessor();
  }

  /**
   * Start queue processor to handle requests one by one (FIFO - strictly sequential)
   * Ensures only ONE task runs at a time, no overlapping
   */
  private async startQueueProcessor(): Promise<void> {
    const processNext = async (): Promise<void> => {
      // CRITICAL: Check if already processing - if yes, wait and retry
      if (this.isProcessingQueue) {
        console.log(`[BotHandlers] Queue processor: Already processing, waiting...`);
        this.queueProcessorInterval = setTimeout(processNext, 2000);
        return;
      }

      const nextItem = this.queue.getNext();
      if (!nextItem) {
        // No items in queue, check again later
        this.queueProcessorInterval = setTimeout(processNext, 2000);
        return;
      }

      // CRITICAL: Mark as processing BEFORE starting (prevents race condition)
      this.isProcessingQueue = true;
      this.queue.startProcessing(nextItem);
      console.log(`[BotHandlers] Queue processor: Starting task "${nextItem.trackName}" (isProcessingQueue=true)`);

      try {
        // Process the item - this is async and will take time
        // CRITICAL: await ensures we wait for this task to complete before starting next
        await this.processRequestItem(nextItem);
        console.log(`[BotHandlers] Queue processor: Completed task "${nextItem.trackName}"`);
      } catch (error: any) {
        // Log detailed error to console only (not to user)
        console.error(`[BotHandlers] Queue processor: Error in task "${nextItem.trackName}":`, error);
        
        // Send short error message to user (no detailed logs)
        try {
          await this.bot.telegram.sendMessage(
            nextItem.chatId,
            `❌ Error processing app "${nextItem.trackName}". Please try again later.`,
            nextItem.messageId ? { reply_parameters: { message_id: nextItem.messageId } } : undefined
          );
        } catch (notifyError: any) {
          console.warn(`[BotHandlers] Failed to notify user: ${notifyError.message}`);
        }
      } finally {
        // CRITICAL: Always finish processing and mark as not processing
        // This ensures next task can start
        this.queue.finishProcessing();
        this.isProcessingQueue = false;
        console.log(`[BotHandlers] Queue processor: Task finished, isProcessingQueue=false, moving to next...`);
        
        // CRITICAL: Process next item immediately (no delay)
        // This ensures strict FIFO - one task finishes completely before next starts
        // Using setImmediate ensures this runs after current call stack completes
        setImmediate(() => processNext());
      }
    };

    // Start processing
    console.log(`[BotHandlers] Queue processor: Started (FIFO mode - strictly sequential)`);
    processNext();
  }


  private async uploadAndForwardFile(
    ctx: Context,
    statusMsg: any,
    filePath: string,
    caption?: string,
    artworkUrl?: string,
    replyToMessageId?: number
  ): Promise<void> {
    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      statusMsg.message_id,
      undefined,
      '⬆️ Uploading file to backup channel...'
    );

    // Download artwork if provided
    let thumbnailPath: string | undefined;
    if (artworkUrl) {
      try {
        const artworkFileName = path.join(this.tempDir, `artwork_${Date.now()}.jpg`);
        await this.upload.downloadArtwork(artworkUrl, artworkFileName);
        thumbnailPath = artworkFileName;
        console.log(`[BotHandlers] Artwork downloaded: ${thumbnailPath}`);
      } catch (error: any) {
        console.warn(`[BotHandlers] Failed to download artwork: ${error.message}`);
        // Continue without artwork
      }
    }

    // Upload file to backup channel with thumbnail
    let messageId: number;
    let lastUpdateTime = 0;
    const UPDATE_INTERVAL = 500; // Update every 500ms
    
    // Helper to format bytes
    const formatBytes = (bytes: number): string => {
      if (!bytes || bytes <= 0 || isNaN(bytes) || !isFinite(bytes)) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
      
      // Calculate which unit to use
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      // Ensure index is within bounds (0 to sizes.length - 1)
      const sizeIndex = Math.max(0, Math.min(i, sizes.length - 1));
      const size = sizes[sizeIndex];
      const value = bytes / Math.pow(k, sizeIndex);
      
      // Format with appropriate decimal places
      let formattedValue: string;
      if (sizeIndex === 0) {
        formattedValue = Math.round(value).toString();
      } else if (value < 10) {
        formattedValue = value.toFixed(2);
      } else if (value < 100) {
        formattedValue = value.toFixed(1);
      } else {
        formattedValue = Math.round(value).toString();
      }
      
      return `${formattedValue} ${size}`;
    };

    // Helper to format speed
    const formatSpeed = (bytesPerSecond: number): string => {
      if (!bytesPerSecond || bytesPerSecond <= 0 || isNaN(bytesPerSecond) || !isFinite(bytesPerSecond)) {
        return '0 B/s';
      }
      return formatBytes(bytesPerSecond) + '/s';
    };

    // Initialize progress with file size
    const fileStats = fs.statSync(filePath);
    const initialTotal = fileStats.size;
    let previousProgress = 0;
    const UPDATE_INTERVAL_MS = 5000; // Update every 5 seconds minimum
    
    // Show initial progress
    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      statusMsg.message_id,
      undefined,
      `⬆️ Uploading file...\n📊 0% (0 B / ${formatBytes(initialTotal)})`
    ).catch(() => {});

    try {
      messageId = await this.upload.uploadFileWithProgress(
        filePath,
        caption,
        (uploaded: number, total: number) => {
          // Validate inputs
          if (!uploaded || !total || uploaded < 0 || total <= 0 || isNaN(uploaded) || isNaN(total)) {
            return;
          }
          
          const now = Date.now();
          const roundedProgress = Math.round((uploaded / total) * 100);
          
          // Only update if progress changed significantly (5%) or enough time passed (5s)
          const progressChanged = roundedProgress !== previousProgress && 
            (roundedProgress - previousProgress >= 5 || roundedProgress % 10 === 0);
          const timeElapsed = now - lastUpdateTime >= UPDATE_INTERVAL_MS;
          
          if (progressChanged || timeElapsed || uploaded >= total) {
            const uploadedFormatted = formatBytes(uploaded);
            const totalFormatted = formatBytes(total);
            
            const progressText = `⬆️ Uploading file...\n` +
              `📊 ${roundedProgress}% (${uploadedFormatted} / ${totalFormatted})`;
            
            // Update message asynchronously without blocking
            ctx.telegram.editMessageText(
              ctx.chat!.id,
              statusMsg.message_id,
              undefined,
              progressText
            ).catch(() => {
              // Ignore edit errors - don't block upload
            });
            
            previousProgress = roundedProgress;
            lastUpdateTime = now;
          }
        },
        thumbnailPath
      );
    } catch (error: any) {
      // If upload failed, throw error
      throw error;
    }

    // Cleanup artwork file
    if (thumbnailPath && fs.existsSync(thumbnailPath)) {
      fs.unlinkSync(thumbnailPath);
    }

    await ctx.telegram.editMessageText(
      ctx.chat!.id,
      statusMsg.message_id,
      undefined,
      '✅ Copying file to you...'
    );

    // Copy message from backup channel to user (without "Forwarded from" label)
    // Convert channel ID to number for copyMessage
    let copySuccess = false;
    try {
      const channelIdNum = parseInt(this.upload.backupChannelId);
      const copyOptions: any = {};
      if (replyToMessageId) {
        copyOptions.reply_to_message_id = replyToMessageId;
      }
      await ctx.telegram.copyMessage(
        ctx.chat!.id,
        channelIdNum,
        messageId,
        copyOptions
      );
      copySuccess = true;
      console.log(`[BotHandlers] Successfully copied message (replied to message ${replyToMessageId || 'none'})`);
    } catch (copyError: any) {
      // If copyMessage fails, it might be because upload actually failed
      // But if user received the file, it means upload succeeded and this is a different issue
      console.warn(`[BotHandlers] copyMessage failed: ${copyError.message}`);
      // Try to forward as fallback
      try {
        const channelIdNum = parseInt(this.upload.backupChannelId);
        await ctx.telegram.forwardMessage(
          ctx.chat!.id,
          channelIdNum,
          messageId
        );
        // If forward succeeded but we wanted to reply, send a separate reply message
        if (replyToMessageId) {
          try {
            await ctx.telegram.sendMessage(
              ctx.chat!.id,
              '✅ File has been forwarded from backup channel',
              { reply_parameters: { message_id: replyToMessageId } }
            );
          } catch (replyError: any) {
            console.warn(`[BotHandlers] Failed to send reply message: ${replyError.message}`);
          }
        }
        copySuccess = true;
        console.log(`[BotHandlers] Successfully forwarded message (fallback)`);
      } catch (forwardError: any) {
        // If both fail, log but don't throw - file might have been sent successfully
        console.warn(`[BotHandlers] forwardMessage also failed: ${forwardError.message}`);
        // Don't throw - user might have received the file already
      }
    }

    // Delete status message after successful copy/forward
    if (copySuccess) {
      try {
        await ctx.telegram.deleteMessage(ctx.chat!.id, statusMsg.message_id);
        console.log(`[BotHandlers] Deleted status message: ${statusMsg.message_id}`);
      } catch (deleteError: any) {
        console.warn(`[BotHandlers] Failed to delete status message: ${deleteError.message}`);
      }
    }
  }

  async handleStart(ctx: Context) {
    const DONATE_LINK = 'https://ko-fi.com/little34306';
    await ctx.reply(
      '🤖 IPA Bot - Manage and decrypt iOS apps\n\n' +
      '📋 Available commands:\n' +
      '• /request <app-store-url> - Download and decrypt app from App Store URL\n' +
      '• /download <app-store-url> - Download IPA from App Store\n' +
      '• /decrypt <bundle-id> - Decrypt installed app\n' +
      '• /install <bundle-id> - Install app from decrypted file\n' +
      '• /uninstall <bundle-id> - Uninstall app\n' +
      '• /list - List installed apps\n' +
      '• /status - View queue status\n' +
      '• /help - Show detailed help\n\n' +
      '💝 Donate: ' + DONATE_LINK
    );
  }

  async handleHelp(ctx: Context) {
    const DONATE_LINK = 'https://ko-fi.com/little34306';
    await ctx.reply(
      '📖 Usage Guide:\n\n' +
      '1️⃣ Download and decrypt (recommended):\n' +
      '   /request <app-store-url>\n' +
      '   Example: /request https://apps.apple.com/us/app/example/id1234567890\n\n' +
      '2️⃣ Download IPA:\n' +
      '   /download <app-store-url>\n' +
      '   Example: /download https://apps.apple.com/us/app/example/id1234567890\n\n' +
      '3️⃣ Decrypt installed app:\n' +
      '   /decrypt <bundle-id>\n' +
      '   Example: /decrypt com.example.app\n\n' +
      '4️⃣ Install app:\n' +
      '   /install <bundle-id>\n' +
      '   Example: /install com.example.app\n\n' +
      '5️⃣ Uninstall:\n' +
      '   /uninstall <bundle-id>\n' +
      '   Example: /uninstall com.example.app\n\n' +
      '6️⃣ List apps:\n' +
      '   /list\n\n' +
      '7️⃣ View queue status:\n' +
      '   /status\n\n' +
      '⚠️ Note:\n' +
      '• Only supports free apps\n' +
      '• Does not support Apple Arcade or paid apps\n' +
      '• Free users: 5 apps/day\n' +
      '• Admin/Owner: unlimited\n\n' +
      '💝 Donate: ' + DONATE_LINK
    );
  }

  async handleDownload(ctx: Context) {
    if (this.isProcessingQueue) {
      await ctx.reply('⏳ Processing another request, please wait...');
      return;
    }

    const args = ctx.message && 'text' in ctx.message 
      ? ctx.message.text.split(' ').slice(1) 
      : [];

    if (args.length === 0) {
      await ctx.reply('❌ Please provide App Store URL\nExample: /download https://apps.apple.com/us/app/example/id1234567890');
      return;
    }

    const input = args.join(' '); // Join in case URL has spaces
    
    if (!isValidAppStoreUrl(input)) {
      await ctx.reply('❌ Invalid URL. Please provide App Store URL\nExample: /download https://apps.apple.com/us/app/example/id1234567890');
      return;
    }

    const appId = extractAppId(input);
    const country = extractCountryCode(input);

    if (!appId) {
      await ctx.reply('❌ Could not find App ID from URL');
      return;
    }

    this.isProcessingQueue = true;
    const statusMsg = await ctx.reply('🔍 Searching for app...');

    try {
      // Get app info first
      const appInfo = await this.ipaTool.getAppInfo(appId, country);
      const bundleId = appInfo.bundleId || appInfo.bundle_id;

      if (!bundleId) {
        throw new Error('Không tìm thấy Bundle ID của app');
      }

      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        undefined,
        '⏬ Downloading IPA from App Store...'
      );

      // Download IPA locally
      const localIPAPath = await this.ipaTool.downloadIPA(bundleId, country);

      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        undefined,
        '⬆️ Uploading file to backup channel...'
      );

      // Upload file to backup channel
      // Track progress for this upload
      let previousProgress2 = 0;
      let lastUpdateTime2 = 0;
      const UPDATE_INTERVAL_MS2 = 5000;
      
      // Helper to format bytes (reuse from above)
      const formatBytes2 = (bytes: number): string => {
        if (!bytes || bytes <= 0 || isNaN(bytes) || !isFinite(bytes)) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        const sizeIndex = Math.max(0, Math.min(i, sizes.length - 1));
        const size = sizes[sizeIndex];
        const value = bytes / Math.pow(k, sizeIndex);
        let formattedValue: string;
        if (sizeIndex === 0) {
          formattedValue = Math.round(value).toString();
        } else if (value < 10) {
          formattedValue = value.toFixed(2);
        } else if (value < 100) {
          formattedValue = value.toFixed(1);
        } else {
          formattedValue = Math.round(value).toString();
        }
        return `${formattedValue} ${size}`;
      };
      
      const formatSpeed2 = (bytesPerSecond: number): string => {
        if (!bytesPerSecond || bytesPerSecond <= 0 || isNaN(bytesPerSecond) || !isFinite(bytesPerSecond)) {
          return '0 B/s';
        }
        return formatBytes2(bytesPerSecond) + '/s';
      };
      
      const messageId = await this.upload.uploadFileWithProgress(
        localIPAPath,
        `📦 ${appInfo.trackName || path.basename(localIPAPath)}\n📱 Version: ${appInfo.version || 'N/A'}\n🆔 Bundle ID: ${bundleId}`,
        (uploaded: number, total: number) => {
          const now = Date.now();
          const roundedProgress = Math.round((uploaded / total) * 100);
          
          // Only update if progress changed significantly (5%) or enough time passed (5s)
          const progressChanged = roundedProgress !== previousProgress2 && 
            (roundedProgress - previousProgress2 >= 5 || roundedProgress % 10 === 0);
          const timeElapsed = now - lastUpdateTime2 >= UPDATE_INTERVAL_MS2;
          
          if (progressChanged || timeElapsed || uploaded >= total) {
            const uploadedFormatted = formatBytes2(uploaded);
            const totalFormatted = formatBytes2(total);
            
            const progressText = `⬆️ Uploading file...\n` +
              `📊 ${roundedProgress}% (${uploadedFormatted} / ${totalFormatted})`;
            
            ctx.telegram.editMessageText(
              ctx.chat!.id,
              statusMsg.message_id,
              undefined,
              progressText
            ).catch(() => {});
            
            previousProgress2 = roundedProgress;
            lastUpdateTime2 = now;
          }
        }
      );

      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        undefined,
        '✅ Forwarding file...'
      );

      // Forward message from backup channel to user
      await ctx.telegram.forwardMessage(
        ctx.chat!.id,
        this.upload.backupChannelId,
        messageId
      );
    } catch (error: any) {
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        undefined,
        `❌ Error: ${error.message}`
      );
    } finally {
      this.isProcessingQueue = false;
    }
  }

  async handleDecrypt(ctx: Context) {
    if (this.isProcessingQueue) {
      await ctx.reply('⏳ Processing another request, please wait...');
      return;
    }

    const args = ctx.message && 'text' in ctx.message 
      ? ctx.message.text.split(' ').slice(1) 
      : [];

    if (args.length === 0) {
      await ctx.reply('❌ Please provide Bundle ID\nExample: /decrypt com.example.app');
      return;
    }

    const bundleId = args[0];

    this.isProcessingQueue = true;
    const statusMsg = await ctx.reply('🔓 Decrypting app...');

    try {
      await this.ssh.connect();
      const decryptedPath = await this.decrypt.decryptApp(bundleId);
      
      // Download file to decrypted folder in project
      const fileName = path.basename(decryptedPath);
      const decryptedDir = getDecryptedIPADirectory();
      const localPath = path.join(decryptedDir, fileName);
      
      // Ensure SFTP connection for download
      await this.ssh['ensureConnected']();
      await this.ssh.downloadFile(decryptedPath, localPath);
      console.log(`[BotHandlers] File downloaded to: ${localPath}`);

      await this.uploadAndForwardFile(
        ctx,
        statusMsg,
        localPath,
        `🔓 Decrypted IPA\n📦 Bundle ID: ${bundleId}`,
        undefined // No artwork for decrypt command
      );

      // Cleanup after successful upload
      console.log(`[BotHandlers] Starting cleanup...`);
      
      // 1. Delete decrypted file on iPhone
      try {
        await this.ssh.deleteFile(decryptedPath);
        console.log(`[BotHandlers] Deleted decrypted file on iPhone: ${decryptedPath}`);
      } catch (error: any) {
        console.warn(`[BotHandlers] Failed to delete decrypted file on iPhone: ${error.message}`);
      }

      // 2. Delete decrypted file on PC
      try {
        if (fs.existsSync(localPath)) {
          fs.unlinkSync(localPath);
          console.log(`[BotHandlers] Deleted decrypted file on PC: ${localPath}`);
        }
      } catch (error: any) {
        console.warn(`[BotHandlers] Failed to delete decrypted file on PC: ${error.message}`);
      }

      await this.ssh.disconnect();
    } catch (error: any) {
      console.error(`[BotHandlers] Error in handleDecrypt:`, error);
      console.error(`[BotHandlers] Error stack:`, error.stack);
      console.error(`[BotHandlers] Error details:`, JSON.stringify({
        message: error.message,
        name: error.name,
        bundleId: bundleId
      }, null, 2));
      
      // Check if it's a timeout error - if so, don't show error message
      const isTimeout = error.message && (
        error.message.includes('timeout') || 
        error.message.includes('TimeoutError') ||
        error.message.includes('Upload timeout')
      );
      
      if (!isTimeout) {
        // Show detailed error message
        let errorMessage = error.message || 'Unknown error';
        
        // Provide more helpful error messages
        if (errorMessage.includes('Failed to get app information')) {
          errorMessage = `App not found with bundle ID: ${bundleId}\n\n` +
            `The app may not be installed or the bundle ID is incorrect.\n` +
            `Please check the bundle ID or install the app first.`;
        } else if (errorMessage.includes('No IPA file found')) {
          errorMessage = `Decrypted file not found.\n\n` +
            `The decryption process may have failed.\n` +
            `Please check the logs for more details.`;
        } else if (errorMessage.includes('Command failed')) {
          errorMessage = `Error executing command on device.\n\n` +
            `Details: ${errorMessage}\n\n` +
            `Please check:\n` +
            `- Device is jailbroken\n` +
            `- TrollDecryptJB is installed\n` +
            `- App is installed on device`;
        }
        
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          statusMsg.message_id,
          undefined,
            `❌ Error: ${errorMessage}`
        );
      } else {
        console.warn(`[BotHandlers] Timeout error caught but upload may have succeeded: ${error.message}`);
      }
      await this.ssh.disconnect().catch(() => {});
    } finally {
      this.isProcessingQueue = false;
    }
  }

  async handleRequest(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) {
      return;
    }

    // Check if user can use bot
    if (!this.queue.canUseBot(userId)) {
      await ctx.reply('❌ Bot is currently in private mode. Only admins can use it.');
      return;
    }

    const args = ctx.message && 'text' in ctx.message 
      ? ctx.message.text.split(' ').slice(1) 
      : [];

    if (args.length === 0) {
      await ctx.reply('❌ Please provide App Store URL\nExample: /request https://apps.apple.com/us/app/example/id1234567890');
      return;
    }

    const input = args.join(' '); // Join in case URL has spaces
    
    if (!isValidAppStoreUrl(input)) {
      await ctx.reply('❌ Invalid URL. Please provide App Store URL\nExample: /request https://apps.apple.com/us/app/example/id1234567890');
      return;
    }

    const appId = extractAppId(input);
    const country = extractCountryCode(input);

    if (!appId) {
      await ctx.reply('❌ Could not find App ID from URL');
      return;
    }

    // Get app info first to add to queue
    try {
      const appInfo = await this.ipaTool.getAppInfo(appId, country);
      const bundleId = appInfo.bundleId || appInfo.bundle_id;

      if (!bundleId) {
        await ctx.reply('❌ Could not find Bundle ID of app');
        return;
      }

      const trackName = appInfo.trackName || appInfo.track_name || 'Unknown';
      const version = appInfo.version || 'N/A';
      const username = ctx.from?.username;

      // Add to queue (use chatId from context, not userId)
      const chatId = ctx.chat?.id;
      if (!chatId) {
        await ctx.reply('❌ Could not determine chat ID');
        return;
      }

      // Get message ID for replying
      const messageId = ctx.message && 'message_id' in ctx.message ? ctx.message.message_id : undefined;

      const result = this.queue.addToQueue(
        userId,
        chatId,
        messageId,
        username,
        appId,
        bundleId,
        trackName,
        version,
        country,
        input
      );

      if (!result.success) {
        await ctx.reply(result.message || '❌ Could not add to queue');
        return;
      }

      // Get position in queue
      const position = this.queue.getUserPosition(userId);
      const processing = this.queue.getProcessing();
      
      let message = `✅ Added to queue!\n\n`;
      message += `📦 App: ${trackName}\n`;
      message += `📱 Version: ${version}\n`;
      
      if (processing && processing.userId !== userId) {
        message += `\n⏳ Processing: ${processing.trackName}\n`;
        message += `📍 Your position: ${position}`;
      } else if (position === 0) {
        message += `\n🔄 Processing your app...`;
      } else {
        message += `\n📍 Position in queue: ${position}`;
      }

      const queueMsg = await ctx.reply(message);
      // Save queue message ID for later deletion
      if (queueMsg && queueMsg.message_id) {
        this.queue.setQueueMessageId(userId, bundleId, queueMsg.message_id);
      }
    } catch (error: any) {
      await ctx.reply(`❌ Error: ${error.message}`);
    }
  }

  /**
   * Process a request item from queue
   */
  private async processRequestItem(item: any): Promise<void> {
    const userId = item.userId;
    const chatId = item.chatId; // Chat where request was sent
    const requestMessageId = item.messageId; // Original request message ID
    const input = item.input;
    const appId = item.appId;
    const bundleId = item.bundleId;
    const trackName = item.trackName;
    const version = item.version;
    const country = item.country;

    // Cleanup: Uninstall any existing app before processing new one
    // Skip TrollStore and 3u
    const SKIP_BUNDLE_IDS = ['com.opa334.trollstore', 'com.sanfengmag.3utools', 'com.sanfengmag.3utools.ios'];
    
    try {
      const installedApps = await this.device.listInstalledApps();
      if (installedApps && installedApps.length > 0) {
        console.log(`[BotHandlers] Cleaning up installed app(s) before processing new request...`);
        // Uninstall all installed apps except TrollStore and 3u
        // WARNING: THIS WILL UNINSTALL ALL!!!!! TRIED IT ON YOUR CLONE/ALTERNATIVE DEVICE
        let cleanedCount = 0;
        for (const appBundleId of installedApps) {
          // Skip TrollStore and 3u
          if (SKIP_BUNDLE_IDS.some(skipId => appBundleId.toLowerCase().includes(skipId.toLowerCase()))) {
            console.log(`[BotHandlers] Skipping cleanup for: ${appBundleId}`);
            continue;
          }
          
          try {
            await this.device.uninstallApp(appBundleId);
            console.log(`[BotHandlers] Uninstalled app: ${appBundleId}`);
            cleanedCount++;
          } catch (error: any) {
            console.warn(`[BotHandlers] Failed to uninstall ${appBundleId}: ${error.message}`);
          }
        }
        
        if (cleanedCount > 0) {
          console.log(`[BotHandlers] Cleaned up ${cleanedCount} app(s)`);
          // Wait a bit for cleanup
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    } catch (error: any) {
      console.warn(`[BotHandlers] Failed to cleanup apps: ${error.message}`);
      // Continue anyway
    }

    const DONATE_LINK = 'https://ko-fi.com/little34306';
    const donateText = `\n\n💝 Donate: ${DONATE_LINK}`;

    // Send status message to the chat where request was sent (reply to original message if available)
    let statusMsg: any;
    try {
      if (requestMessageId) {
        // Reply to original request message
        statusMsg = await this.bot.telegram.sendMessage(
          chatId,
          `🔍 Processing app "${trackName}"...${donateText}`,
                  { reply_parameters: { message_id: requestMessageId } }
        );
      } else {
        // Fallback to regular message
        statusMsg = await this.bot.telegram.sendMessage(
          chatId,
          `🔍 Processing app "${trackName}"...${donateText}`
        );
      }
    } catch (error: any) {
      console.warn(`[BotHandlers] Failed to send status message: ${error.message}`);
      // Continue without status message
    }

    const updateStatus = async (text: string) => {
      if (statusMsg) {
        try {
          await this.bot.telegram.editMessageText(chatId, statusMsg.message_id, undefined, text);
        } catch (error: any) {
          console.warn(`[BotHandlers] Failed to update status: ${error.message}`);
        }
      }
    };

    try {
      // Step 1.2: Check if app is Apple Arcade or paid app
      await updateStatus('🔍 Checking app type...');

      const appCheck = await this.arcadeCheck.checkApp(input, country);
      if (appCheck.isArcade || appCheck.isPaid) {
        const errorMsg = appCheck.isArcade 
          ? '❌ Apple Arcade apps not supported'
          : '❌ Paid apps not supported';
        
        await updateStatus(errorMsg);
        return;
      }

      // Step 1.3: Purchase app (required for free apps before download)
      await updateStatus('🛒 Purchasing app...');

      try {
        const purchaseSuccess = await this.ipaTool.purchaseApp(bundleId);
        if (purchaseSuccess) {
          console.log(`[BotHandlers] App purchased successfully: ${bundleId}`);
        } else {
          console.log(`[BotHandlers] App already purchased, continuing: ${bundleId}`);
        }
      } catch (purchaseError: any) {
        await updateStatus(`❌ Error purchasing app: ${purchaseError.message}`);
        return;
      }

      // Step 1.5: Check backup channel for existing file
      await updateStatus('🔍 Checking file in backup channel...');

      const existingMessageId = await this.upload.findExistingFile(trackName, bundleId, version);
      
      if (existingMessageId) {
        // File exists in backup channel, forward it directly without notification
        console.log(`[BotHandlers] Found existing file in backup channel, forwarding silently...`);

        // Copy message from backup channel to the chat where request was sent
        // Reply to original request if messageId is provided
        // Note: copyMessage supports reply_to_message_id, forwardMessage does not
        let copySuccess = false;
        try {
          const channelIdNum = parseInt(this.upload.backupChannelId);
          const copyOptions: any = {};
          if (requestMessageId) {
            copyOptions.reply_to_message_id = requestMessageId;
          }
          await this.bot.telegram.copyMessage(
            chatId,
            channelIdNum,
            existingMessageId,
            copyOptions
          );
          copySuccess = true;
          console.log(`[BotHandlers] Successfully copied message from backup channel (replied to message ${requestMessageId || 'none'})`);
        } catch (copyError: any) {
          console.warn(`[BotHandlers] copyMessage failed: ${copyError.message}`);
          // Try to forward as fallback (but forwardMessage doesn't support reply_to_message_id)
          try {
            const channelIdNum = parseInt(this.upload.backupChannelId);
            await this.bot.telegram.forwardMessage(
              chatId,
              channelIdNum,
              existingMessageId
            );
            // If forward succeeded but we wanted to reply, send a separate reply message
            if (requestMessageId) {
              try {
                await this.bot.telegram.sendMessage(
                  chatId,
                  '✅ File has been forwarded from backup channel',
                  { reply_parameters: { message_id: requestMessageId } }
                );
              } catch (replyError: any) {
                console.warn(`[BotHandlers] Failed to send reply message: ${replyError.message}`);
              }
            }
            copySuccess = true;
            console.log(`[BotHandlers] Successfully forwarded message from backup channel (fallback)`);
          } catch (forwardError: any) {
            console.warn(`[BotHandlers] forwardMessage also failed: ${forwardError.message}`);
            throw new Error('Could not forward file from backup channel');
          }
        }

        // Delete status message after successful copy/forward
        if (copySuccess && statusMsg) {
          try {
            await this.bot.telegram.deleteMessage(chatId, statusMsg.message_id);
            console.log(`[BotHandlers] Deleted status message: ${statusMsg.message_id}`);
          } catch (deleteError: any) {
            console.warn(`[BotHandlers] Failed to delete status message: ${deleteError.message}`);
          }
        }

        return; // Exit early, no need to decrypt
      }

      // File not found in backup channel, proceed with download and decrypt
      console.log(`[BotHandlers] File not found in backup channel, proceeding with decrypt...`);

      // Step 2: Download IPA (local)
      await updateStatus('⏬ Downloading IPA from App Store...');
      const localIPAPath = await this.ipaTool.downloadIPA(bundleId, country);
      
      // Step 3: Install app (ideviceinstaller will handle file transfer)
      await updateStatus('📲 Installing app for decryption...');
      
      // Install app from local path (ideviceinstaller handles transfer)
      try {
        await this.device.installApp(localIPAPath);
      } catch (installError: any) {
        console.error(`[BotHandlers] Install app failed:`, installError);
        throw installError; // Re-throw to be caught by outer catch
      }
      
      // Verify installation - wait a bit for system to register the app
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Ensure SSH/SFTP connection is maintained for decrypt
      await this.ssh['ensureConnected']();
      
      const isInstalled = await this.device.isAppInstalled(bundleId);
      if (!isInstalled) {
        console.error(`[BotHandlers] App verification failed. Bundle ID: ${bundleId}`);
        // Try one more time after another delay
        await new Promise(resolve => setTimeout(resolve, 2000));
        const retryInstalled = await this.device.isAppInstalled(bundleId);
        if (!retryInstalled) {
          console.error(`[BotHandlers] App verification failed after retry. Bundle ID: ${bundleId}`);
          throw new Error(`Failed to verify app installation. Bundle ID: ${bundleId}`);
        }
        console.log(`[BotHandlers] App verified after retry. Bundle ID: ${bundleId}`);
      } else {
        console.log(`[BotHandlers] App verified successfully. Bundle ID: ${bundleId}`);
      }

      // Step 4: Wait a bit more for app bundle to be registered
      await updateStatus('⏳ Waiting for app to be registered...');
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Step 5: Decrypt (using SSH only, no SFTP needed)
      await updateStatus('🔓 Decrypting app...');
      
      const decryptedPath = await this.decrypt.decryptApp(bundleId);
      
      // Step 6: Connect SFTP and download decrypted file
      await updateStatus('⬇️ Downloading decrypted file...');
      
      // Ensure SFTP connection for file download
      await this.ssh['ensureConnected']();
      
      const fileName = path.basename(decryptedPath);
      const decryptedDir = getDecryptedIPADirectory();
      const localDecryptedPath = path.join(decryptedDir, fileName);
      await this.ssh.downloadFile(decryptedPath, localDecryptedPath);
      console.log(`[BotHandlers] File downloaded to: ${localDecryptedPath}`);

      // Get app info for caption
      const appInfo = await this.ipaTool.getAppInfo(appId, country);
      
      // Upload and forward file (create a mock context for uploadAndForwardFile)
      const mockCtx = {
        chat: { id: chatId }, // Use chatId where request was sent
        telegram: this.bot.telegram,
      } as any;

      const DONATE_LINK = 'https://ko-fi.com/little34306';
      const caption = `📦 ${appInfo.trackName || fileName}\n📱 Version: ${appInfo.version || 'N/A'}\n🆔 Bundle ID: ${bundleId}\n\n💝 Donate: ${DONATE_LINK}`;

      await this.uploadAndForwardFile(
        mockCtx,
        statusMsg,
        localDecryptedPath,
        caption,
        appInfo.artworkUrl512,
        requestMessageId // Pass messageId for replying
      );

      // Cleanup after successful upload
      console.log(`[BotHandlers] Starting cleanup...`);
      
      // 1. Delete decrypted file on iPhone
      try {
        await this.ssh.deleteFile(decryptedPath);
        console.log(`[BotHandlers] Deleted decrypted file on iPhone: ${decryptedPath}`);
      } catch (error: any) {
        console.warn(`[BotHandlers] Failed to delete decrypted file on iPhone: ${error.message}`);
      }

      // 2. Uninstall app on iPhone
      try {
        await this.device.uninstallApp(bundleId);
        console.log(`[BotHandlers] Uninstalled app: ${bundleId}`);
      } catch (error: any) {
        console.warn(`[BotHandlers] Failed to uninstall app: ${error.message}`);
      }

      // 3. Delete encrypted file on PC
      try {
        if (fs.existsSync(localIPAPath)) {
          fs.unlinkSync(localIPAPath);
          console.log(`[BotHandlers] Deleted encrypted file on PC: ${localIPAPath}`);
        }
      } catch (error: any) {
        console.warn(`[BotHandlers] Failed to delete encrypted file on PC: ${error.message}`);
      }

      // 4. Delete decrypted file on PC
      try {
        if (fs.existsSync(localDecryptedPath)) {
          fs.unlinkSync(localDecryptedPath);
          console.log(`[BotHandlers] Deleted decrypted file on PC: ${localDecryptedPath}`);
        }
      } catch (error: any) {
        console.warn(`[BotHandlers] Failed to delete decrypted file on PC: ${error.message}`);
      }

      // 5. Delete queue message ("Added to queue")
      if (item.queueMessageId) {
        try {
          await this.bot.telegram.deleteMessage(chatId, item.queueMessageId);
          console.log(`[BotHandlers] Deleted queue message: ${item.queueMessageId}`);
        } catch (error: any) {
          console.warn(`[BotHandlers] Failed to delete queue message: ${error.message}`);
        }
      }

      await this.ssh.disconnect();
    } catch (error: any) {
      // Check if it's a timeout error - if so, don't show error message
      // because upload might have succeeded (we'll try to copy message anyway)
      const isTimeout = error.message && (
        error.message.includes('timeout') || 
        error.message.includes('TimeoutError') ||
        error.message.includes('Upload timeout')
      );
      
      // Log detailed error to console only
      console.error(`[BotHandlers] Error in processRequestItem for "${trackName}":`, error);
      
      if (!isTimeout && statusMsg) {
        try {
          // Send short error message (no detailed logs)
          await this.bot.telegram.editMessageText(
            chatId,
            statusMsg.message_id,
            undefined,
            `❌ An error occurred while processing. Please try again later.`
          );
        } catch (editError: any) {
          console.warn(`[BotHandlers] Failed to send error message: ${editError.message}`);
        }
      } else {
        console.warn(`[BotHandlers] Timeout error caught but upload may have succeeded: ${error.message}`);
        // Don't show error message - upload likely succeeded
      }
      
      // Re-throw error so it's caught by startQueueProcessor and moves to next task
      throw error;
      // Cleanup on error
      try {
        await this.ssh.disconnect();
      } catch (disconnectError: any) {
        console.warn(`[BotHandlers] Failed to disconnect SSH: ${disconnectError.message}`);
      }
      
      // Delete queue message on error
      if (item.queueMessageId) {
        try {
          await this.bot.telegram.deleteMessage(chatId, item.queueMessageId);
        } catch (deleteError: any) {
          console.warn(`[BotHandlers] Failed to delete queue message on error: ${deleteError.message}`);
        }
      }
      
      // Re-throw to be caught by startQueueProcessor
      throw error;
    }
  }

  async handleDownloadAndDecrypt(ctx: Context) {
    if (this.isProcessingQueue) {
      await ctx.reply('⏳ Processing another request, please wait...');
      return;
    }

    const args = ctx.message && 'text' in ctx.message 
      ? ctx.message.text.split(' ').slice(1) 
      : [];

    if (args.length === 0) {
      await ctx.reply('❌ Please provide App Store URL\nExample: /download_and_decrypt https://apps.apple.com/us/app/example/id1234567890');
      return;
    }

    const input = args.join(' ');
    
    if (!isValidAppStoreUrl(input)) {
      await ctx.reply('❌ Invalid URL. Please provide App Store URL\nExample: /download_and_decrypt https://apps.apple.com/us/app/example/id1234567890');
      return;
    }

    const appId = extractAppId(input);
    const country = extractCountryCode(input);

    if (!appId) {
      await ctx.reply('❌ Could not find App ID from URL');
      return;
    }

    this.isProcessingQueue = true;
    let statusMsg = await ctx.reply('⏬ Downloading IPA from App Store...');

    try {
      await this.ssh.connect();
      
      // Step 1: Download IPA
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        undefined,
        '⏬ Downloading IPA from App Store...'
      );
      
      const ipaPath = await this.ipaTool.downloadIPA(appId, country);
      
      // Step 2: Get app info to find bundle ID
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        undefined,
        '📦 Getting app information...'
      );
      
      const appInfo = await this.ipaTool.getAppInfo(appId, country);
      const bundleId = appInfo.bundleId || appInfo.bundle_id;

      if (!bundleId) {
        throw new Error('Không tìm thấy Bundle ID của app');
      }

      // Step 3: Install app first (needed for decryption)
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        undefined,
        '📲 Installing app for decryption...'
      );
      
      await this.device.installApp(ipaPath);

      // Step 4: Wait a bit more for app bundle to be registered
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        undefined,
        '⏳ Waiting for app to be registered...'
      );
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Step 5: Decrypt (using SSH only, no SFTP needed)
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        undefined,
        '🔓 Decrypting app...'
      );
      
      const decryptedPath = await this.decrypt.decryptApp(bundleId);
      
      // Step 6: Connect SFTP and download file
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        undefined,
        '⬇️ Downloading decrypted file...'
      );
      
      // Ensure SFTP connection for file download
      await this.ssh['ensureConnected']();
      
      const fileName = path.basename(decryptedPath);
      const decryptedDir = getDecryptedIPADirectory();
      const localPath = path.join(decryptedDir, fileName);
      await this.ssh.downloadFile(decryptedPath, localPath);
      console.log(`[BotHandlers] File downloaded to: ${localPath}`);

      await this.uploadAndForwardFile(
        ctx,
        statusMsg,
        localPath,
        `📦 ${appInfo.trackName || fileName}\n📱 Version: ${appInfo.version || 'N/A'}\n🆔 Bundle ID: ${bundleId}`,
        appInfo.artworkUrl512
      );

      // Cleanup after successful upload
      console.log(`[BotHandlers] Starting cleanup...`);
      
      // 1. Delete decrypted file on iPhone
      try {
        await this.ssh.deleteFile(decryptedPath);
        console.log(`[BotHandlers] Deleted decrypted file on iPhone: ${decryptedPath}`);
      } catch (error: any) {
        console.warn(`[BotHandlers] Failed to delete decrypted file on iPhone: ${error.message}`);
      }

      // 2. Uninstall app on iPhone
      try {
        await this.device.uninstallApp(bundleId);
        console.log(`[BotHandlers] Uninstalled app: ${bundleId}`);
      } catch (error: any) {
        console.warn(`[BotHandlers] Failed to uninstall app: ${error.message}`);
      }

      // 3. Delete encrypted file on PC
      try {
        if (fs.existsSync(ipaPath)) {
          fs.unlinkSync(ipaPath);
          console.log(`[BotHandlers] Deleted encrypted file on PC: ${ipaPath}`);
        }
      } catch (error: any) {
        console.warn(`[BotHandlers] Failed to delete encrypted file on PC: ${error.message}`);
      }

      // 4. Delete decrypted file on PC
      try {
        if (fs.existsSync(localPath)) {
          fs.unlinkSync(localPath);
          console.log(`[BotHandlers] Deleted decrypted file on PC: ${localPath}`);
        }
      } catch (error: any) {
        console.warn(`[BotHandlers] Failed to delete decrypted file on PC: ${error.message}`);
      }

      await this.ssh.disconnect();
    } catch (error: any) {
      // Check if it's a timeout error - if so, don't show error message
      const isTimeout = error.message && (
        error.message.includes('timeout') || 
        error.message.includes('TimeoutError') ||
        error.message.includes('Upload timeout')
      );
      
      if (!isTimeout) {
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          statusMsg.message_id,
          undefined,
          `❌ Error: ${error.message}`
        );
      } else {
        console.warn(`[BotHandlers] Timeout error caught but upload may have succeeded: ${error.message}`);
      }
      await this.ssh.disconnect().catch(() => {});
    } finally {
      this.isProcessingQueue = false;
    }
  }

  async handleInstall(ctx: Context) {
    if (this.isProcessingQueue) {
      await ctx.reply('⏳ Processing another request, please wait...');
      return;
    }

    const args = ctx.message && 'text' in ctx.message 
      ? ctx.message.text.split(' ').slice(1) 
      : [];

    if (args.length === 0) {
      await ctx.reply('❌ Please provide Bundle ID\nExample: /install com.example.app');
      return;
    }

    const bundleId = args[0];

    this.isProcessingQueue = true;
    const statusMsg = await ctx.reply('📲 Installing app...');

    try {
      await this.ssh.connect();
      
      // Find decrypted IPA file
      const files = await this.ssh.listFiles('/var/mobile/Documents/decrypted');
      const ipaFile = files.find(f => f.includes(bundleId) && f.endsWith('.ipa'));
      
      if (!ipaFile) {
        throw new Error(`Could not find decrypted IPA file for bundle ID: ${bundleId}`);
      }

      const ipaPath = `/var/mobile/Documents/decrypted/${ipaFile}`;
      await this.device.installApp(ipaPath);

      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        undefined,
        '✅ App installed successfully!'
      );

      await this.ssh.disconnect();
    } catch (error: any) {
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        undefined,
        `❌ Error: ${error.message}`
      );
      await this.ssh.disconnect().catch(() => {});
    } finally {
      this.isProcessingQueue = false;
    }
  }

  async handleUninstall(ctx: Context) {
    if (this.isProcessingQueue) {
      await ctx.reply('⏳ Processing another request, please wait...');
      return;
    }

    const args = ctx.message && 'text' in ctx.message 
      ? ctx.message.text.split(' ').slice(1) 
      : [];

    if (args.length === 0) {
      await ctx.reply('❌ Please provide Bundle ID\nExample: /uninstall com.example.app');
      return;
    }

    const bundleId = args[0];

    this.isProcessingQueue = true;
    const statusMsg = await ctx.reply('🗑️ Uninstalling app...');

    try {
      await this.ssh.connect();
      await this.device.uninstallApp(bundleId);

      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        undefined,
        '✅ App uninstalled successfully!'
      );

      await this.ssh.disconnect();
    } catch (error: any) {
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        undefined,
        `❌ Error: ${error.message}`
      );
      await this.ssh.disconnect().catch(() => {});
    } finally {
      this.isProcessingQueue = false;
    }
  }

  async handlePublic(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId || !this.queue.isOwner(userId)) {
      await ctx.reply('❌ Only owner can use this command');
      return;
    }

    const args = ctx.message && 'text' in ctx.message 
      ? ctx.message.text.split(' ').slice(1) 
      : [];

    if (args.length === 0) {
      const mode = this.queue.getPublicMode() ? 'ON' : 'OFF';
      await ctx.reply(`📢 Public mode: ${mode}\n\nUsage: /public on or /public off`);
      return;
    }

    const action = args[0].toLowerCase();
    if (action === 'on') {
      this.queue.setPublicMode(true);
      await ctx.reply('✅ Public mode enabled - everyone can use the bot');
    } else if (action === 'off') {
      this.queue.setPublicMode(false);
      await ctx.reply('🔒 Public mode disabled - only admins can use the bot');
    } else {
      await ctx.reply('❌ Usage: /public on or /public off');
    }
  }

  async handleStatus(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) {
      return;
    }

    const status = this.queue.getStatus();
    let message = '📊 Queue Status:\n\n';

    // Public mode
    message += `📢 Mode: ${status.publicMode ? 'PUBLIC' : 'PRIVATE'}\n`;
    message += `👥 Admin count: ${status.adminCount}\n\n`;

    // Currently processing
    if (status.processing) {
      const proc = status.processing;
      const userType = this.queue.isOwner(proc.userId) ? '👑 Owner' : 
                      this.queue.isAdmin(proc.userId) ? '⭐ Admin' : '👤 User';
      message += `🔄 Processing:\n`;
      message += `  ${userType}: ${proc.trackName} (${proc.version})\n`;
      message += `  Bundle ID: ${proc.bundleId}\n\n`;
    } else {
      message += `✅ No apps being processed\n\n`;
    }

    // Queue
    if (status.queue.length === 0) {
      message += `📭 Queue is empty`;
    } else {
      message += `📋 Queue (${status.queue.length} app):\n`;
      status.queue.slice(0, 10).forEach((item, index) => {
        const userType = this.queue.isOwner(item.userId) ? '👑' : 
                        this.queue.isAdmin(item.userId) ? '⭐' : '👤';
        message += `  ${index + 1}. ${userType} ${item.trackName} (${item.version})\n`;
      });
      if (status.queue.length > 10) {
        message += `  ... and ${status.queue.length - 10} more apps`;
      }
    }

    // User's position
    const userPosition = this.queue.getUserPosition(userId);
    if (userPosition >= 0) {
      message += `\n\n📍 Your position: ${userPosition === 0 ? 'Processing' : userPosition}`;
    }

    await ctx.reply(message);
  }

  async handleAddAdmin(ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId || !this.queue.isOwner(userId)) {
      await ctx.reply('❌ Only owner can use this command');
      return;
    }

    const args = ctx.message && 'text' in ctx.message 
      ? ctx.message.text.split(' ').slice(1) 
      : [];

    if (args.length < 2 || args[0].toLowerCase() !== 'admin') {
      await ctx.reply('❌ Usage: /add admin <user_id>\nExample: /add admin 123456789');
      return;
    }

    const adminId = parseInt(args[1]);
    if (isNaN(adminId)) {
      await ctx.reply('❌ Invalid User ID');
      return;
    }

    this.queue.addAdmin(adminId);
    await ctx.reply(`✅ Added admin: ${adminId}`);
  }

  async handleList(ctx: Context) {
    // Remove isProcessing check since we use queue now

    this.isProcessingQueue = true;
    const statusMsg = await ctx.reply('📋 Getting list of apps...');

    try {
      await this.ssh.connect();
      const apps = await this.device.listInstalledApps();

      if (apps.length === 0) {
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          statusMsg.message_id,
          undefined,
          '📋 No apps installed.'
        );
      } else {
        const appList = apps.slice(0, 50).join('\n'); // Limit to 50 apps
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          statusMsg.message_id,
          undefined,
          `📋 App list (${apps.length}):\n\n<code>${appList}</code>`,
          { parse_mode: 'HTML' }
        );
      }

      await this.ssh.disconnect();
    } catch (error: any) {
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        undefined,
        `❌ Error: ${error.message}`
      );
      await this.ssh.disconnect().catch(() => {});
    } finally {
      this.isProcessingQueue = false;
    }
  }
}
