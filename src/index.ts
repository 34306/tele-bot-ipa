import { Telegraf } from 'telegraf';
import * as dotenv from 'dotenv';
import { SSHService } from './services/sshService';
import { UploadService } from './services/uploadService';
import { BotHandlers } from './bot/handlers';

// Load environment variables
dotenv.config();

// Validate required environment variables
const requiredEnvVars = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_API_ID',
  'TELEGRAM_API_HASH',
  'USER_SESSION_STRING',
  'BACKUP_CHANNEL_ID',
  'SSH_HOST',
  'SSH_USERNAME',
  'SSH_PASSWORD',
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

// Initialize services
const ssh = new SSHService(
  process.env.SSH_HOST!,
  parseInt(process.env.SSH_PORT || '22'),
  process.env.SSH_USERNAME!,
  process.env.SSH_PASSWORD!
);

const uploadService = new UploadService(
  parseInt(process.env.TELEGRAM_API_ID!),
  process.env.TELEGRAM_API_HASH!,
  process.env.USER_SESSION_STRING!,
  process.env.BACKUP_CHANNEL_ID!
);

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
const handlers = new BotHandlers(
  ssh,
  uploadService,
  bot,
  process.env.IPATOOL_PATH
);

// Expose queue for middleware access
const queue = handlers.queue;

// Allowed user ID (owner)
const ALLOWED_USER_ID = 1255350210;

// Middleware to check if user is allowed
// Allow owner, admins, and free users (if public mode is on) in both private chats and channels
bot.use((ctx, next) => {
  const userId = ctx.from?.id;
  const chatType = ctx.chat?.type;
  
  // Allow private chats and channels (supergroup, channel, group)
  if (chatType !== 'private' && chatType !== 'supergroup' && chatType !== 'channel' && chatType !== 'group') {
    return; // Silently ignore unknown chat types
  }
  
  // For channels/groups, we need a user to send the command
  if (!userId) {
    return; // Silently ignore if no user
  }
  
  // Owner can always use
  if (userId === ALLOWED_USER_ID) {
    return next();
  }
  
  // Check if user can use bot (admin or public mode)
  if (queue && !queue.canUseBot(userId)) {
    return; // Silently ignore if not allowed
  }
  
  return next();
});

// Register command handlers
bot.start((ctx) => handlers.handleStart(ctx));
bot.help((ctx) => handlers.handleHelp(ctx));
bot.command('request', (ctx) => handlers.handleRequest(ctx));
bot.command('download', (ctx) => handlers.handleDownload(ctx));
bot.command('decrypt', (ctx) => handlers.handleDecrypt(ctx));
bot.command('download_and_decrypt', (ctx) => handlers.handleDownloadAndDecrypt(ctx));
bot.command('install', (ctx) => handlers.handleInstall(ctx));
bot.command('uninstall', (ctx) => handlers.handleUninstall(ctx));
bot.command('list', (ctx) => handlers.handleList(ctx));
bot.command('public', (ctx) => handlers.handlePublic(ctx));
bot.command('status', (ctx) => handlers.handleStatus(ctx));
bot.command('add', (ctx) => handlers.handleAddAdmin(ctx));

// Error handling
bot.catch((err: any, ctx) => {
  // Ignore all errors silently
  // Only log for debugging
  const errorMessage = err?.message || err?.toString() || '';
  const isTimeout = errorMessage.includes('timeout') || 
                    errorMessage.includes('TimeoutError') || 
                    errorMessage.includes('90000') ||
                    errorMessage.includes('Promise timed out');
  
  if (isTimeout) {
    console.warn(`[Bot] Timeout error caught (likely from upload): ${errorMessage}`);
  } else {
    console.error(`[Bot] Error for ${ctx.updateType}:`, err);
  }
  
  // Don't send any error message to user
  // Errors are already handled in individual handlers
  return;
});

// Start bot
console.log('Starting Telegram IPA Bot...');
bot.launch().then(() => {
  console.log('Bot is running!');
}).catch((error) => {
  console.error('Failed to start bot:', error);
  process.exit(1);
});

// Graceful shutdown
process.once('SIGINT', () => {
  console.log('Shutting down...');
  bot.stop('SIGINT');
  Promise.all([
    ssh.disconnect().catch(() => {}),
    uploadService.disconnect().catch(() => {})
  ]).then(() => {
    process.exit(0);
  }).catch(() => {
    process.exit(0);
  });
});

process.once('SIGTERM', () => {
  console.log('Shutting down...');
  bot.stop('SIGTERM');
  Promise.all([
    ssh.disconnect().catch(() => {}),
    uploadService.disconnect().catch(() => {})
  ]).then(() => {
    process.exit(0);
  }).catch(() => {
    process.exit(0);
  });
});
