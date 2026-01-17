interface QueueItem {
  userId: number;
  chatId: number; // Chat where request was sent (can be private chat or channel/group)
  messageId?: number; // Message ID of the request (for replying)
  queueMessageId?: number; // Message ID of the "Added to queue" message (for deletion)
  username?: string;
  appId: string;
  bundleId: string;
  trackName: string;
  version: string;
  country: string;
  input: string;
  priority: number; // 0 = owner, 1 = admin, 2 = free user
  timestamp: number;
}

export class QueueService {
  private queue: QueueItem[] = [];
  private processing: QueueItem | null = null;
  private ownerId: number = 1255350210;
  private adminIds: Set<number> = new Set();
  private publicMode: boolean = false;
  private dailyLimits: Map<number, { count: number; date: string }> = new Map();
  private readonly FREE_USER_DAILY_LIMIT = 5;

  constructor() {
    // Owner is always admin
    this.adminIds.add(this.ownerId);
  }

  /**
   * Add admin by user ID
   */
  addAdmin(userId: number): void {
    this.adminIds.add(userId);
    console.log(`[QueueService] Added admin: ${userId}`);
  }

  /**
   * Remove admin by user ID (cannot remove owner)
   */
  removeAdmin(userId: number): void {
    if (userId !== this.ownerId) {
      this.adminIds.delete(userId);
      console.log(`[QueueService] Removed admin: ${userId}`);
    }
  }

  /**
   * Check if user is admin
   */
  isAdmin(userId: number): boolean {
    return this.adminIds.has(userId);
  }

  /**
   * Check if user is owner
   */
  isOwner(userId: number): boolean {
    return userId === this.ownerId;
  }

  /**
   * Set public mode
   */
  setPublicMode(enabled: boolean): void {
    this.publicMode = enabled;
    console.log(`[QueueService] Public mode: ${enabled ? 'ON' : 'OFF'}`);
  }

  /**
   * Get public mode
   */
  getPublicMode(): boolean {
    return this.publicMode;
  }

  /**
   * Check if user can use bot
   */
  canUseBot(userId: number): boolean {
    // Owner and admins can always use
    if (this.isOwner(userId) || this.isAdmin(userId)) {
      return true;
    }
    
    // Free users can only use if public mode is on
    return this.publicMode;
  }

  /**
   * Check daily limit for free users
   */
  checkDailyLimit(userId: number): { allowed: boolean; remaining: number } {
    // Owner and admins have no limit
    if (this.isOwner(userId) || this.isAdmin(userId)) {
      return { allowed: true, remaining: Infinity };
    }

    const today = new Date().toISOString().split('T')[0];
    const limit = this.dailyLimits.get(userId);

    if (!limit || limit.date !== today) {
      // Reset for new day
      this.dailyLimits.set(userId, { count: 0, date: today });
      return { allowed: true, remaining: this.FREE_USER_DAILY_LIMIT };
    }

    const remaining = this.FREE_USER_DAILY_LIMIT - limit.count;
    return { allowed: remaining > 0, remaining: Math.max(0, remaining) };
  }

  /**
   * Increment daily count for user
   */
  incrementDailyCount(userId: number): void {
    // Don't count for owner and admins
    if (this.isOwner(userId) || this.isAdmin(userId)) {
      return;
    }

    const today = new Date().toISOString().split('T')[0];
    const limit = this.dailyLimits.get(userId);

    if (!limit || limit.date !== today) {
      this.dailyLimits.set(userId, { count: 1, date: today });
    } else {
      limit.count++;
      this.dailyLimits.set(userId, limit);
    }
  }

  /**
   * Add item to queue
   */
  addToQueue(
    userId: number,
    chatId: number,
    messageId: number | undefined,
    username: string | undefined,
    appId: string,
    bundleId: string,
    trackName: string,
    version: string,
    country: string,
    input: string
  ): { success: boolean; position: number; message?: string } {
    // Check if user can use bot
    if (!this.canUseBot(userId)) {
      return {
        success: false,
        position: 0,
        message: '❌ Bot is currently in private mode. Only admins can use it.',
      };
    }

    // Check daily limit
    const limitCheck = this.checkDailyLimit(userId);
    if (!limitCheck.allowed) {
      return {
        success: false,
        position: 0,
        message: `❌ You have reached the limit of 5 apps/day. Please try again tomorrow.`,
      };
    }

    // Check if already in queue
    const existingIndex = this.queue.findIndex(
      (item) => item.userId === userId && item.bundleId === bundleId
    );
    if (existingIndex !== -1) {
      return {
        success: false,
        position: existingIndex + 1,
        message: `⚠️ You already have this app in queue at position ${existingIndex + 1}`,
      };
    }

    // Determine priority
    let priority = 2; // Free user
    if (this.isOwner(userId)) {
      priority = 0; // Owner
    } else if (this.isAdmin(userId)) {
      priority = 1; // Admin
    }

    const item: QueueItem = {
      userId,
      chatId,
      messageId,
      username,
      appId,
      bundleId,
      trackName,
      version,
      country,
      input,
      priority,
      timestamp: Date.now(),
    };

    // Insert based on priority (lower number = higher priority)
    let insertIndex = this.queue.length;
    for (let i = 0; i < this.queue.length; i++) {
      if (this.queue[i].priority > priority) {
        insertIndex = i;
        break;
      }
    }

    this.queue.splice(insertIndex, 0, item);

    const position = insertIndex + 1;
    console.log(`[QueueService] Added to queue: ${trackName} by user ${userId} at position ${position}`);

    return {
      success: true,
      position,
    };
  }

  /**
   * Get next item from queue
   */
  getNext(): QueueItem | null {
    if (this.queue.length === 0) {
      return null;
    }

    // Sort by priority (0 = highest) and timestamp
    this.queue.sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      return a.timestamp - b.timestamp;
    });

    return this.queue[0];
  }

  /**
   * Set queue message ID for an item (the "Added to queue" message)
   */
  setQueueMessageId(userId: number, bundleId: string, queueMessageId: number): void {
    const item = this.queue.find(
      (q) => q.userId === userId && q.bundleId === bundleId
    );
    if (item) {
      item.queueMessageId = queueMessageId;
      console.log(`[QueueService] Set queueMessageId ${queueMessageId} for ${bundleId}`);
    }
    // Also check processing item
    if (this.processing && this.processing.userId === userId && this.processing.bundleId === bundleId) {
      this.processing.queueMessageId = queueMessageId;
    }
  }

  /**
   * Start processing an item
   */
  startProcessing(item: QueueItem): void {
    // Remove from queue
    const index = this.queue.findIndex(
      (q) =>
        q.userId === item.userId &&
        q.bundleId === item.bundleId &&
        q.timestamp === item.timestamp
    );
    if (index !== -1) {
      this.queue.splice(index, 1);
    }

    this.processing = item;
    console.log(`[QueueService] Started processing: ${item.trackName} by user ${item.userId}`);
  }

  /**
   * Finish processing current item
   */
  finishProcessing(): void {
    if (this.processing) {
      console.log(`[QueueService] Finished processing: ${this.processing.trackName}`);
      this.incrementDailyCount(this.processing.userId);
      this.processing = null;
    }
  }

  /**
   * Get current processing item
   */
  getProcessing(): QueueItem | null {
    return this.processing;
  }

  /**
   * Get queue status
   */
  getStatus(): {
    processing: QueueItem | null;
    queue: QueueItem[];
    publicMode: boolean;
    adminCount: number;
  } {
    return {
      processing: this.processing,
      queue: [...this.queue],
      publicMode: this.publicMode,
      adminCount: this.adminIds.size,
    };
  }

  /**
   * Get user's position in queue
   */
  getUserPosition(userId: number): number {
    if (this.processing && this.processing.userId === userId) {
      return 0; // Currently processing
    }

    const index = this.queue.findIndex((item) => item.userId === userId);
    return index === -1 ? -1 : index + 1;
  }

  /**
   * Remove user's items from queue
   */
  removeUserItems(userId: number): number {
    const before = this.queue.length;
    this.queue = this.queue.filter((item) => item.userId !== userId);
    const removed = before - this.queue.length;
    if (removed > 0) {
      console.log(`[QueueService] Removed ${removed} item(s) for user ${userId}`);
    }
    return removed;
  }
}
