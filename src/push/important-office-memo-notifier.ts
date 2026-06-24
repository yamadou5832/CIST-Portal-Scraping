import type { AuthService } from "../auth/auth-service.js";
import type { PortalScraperService } from "../scraper.js";
import type { ReceivedOfficeMemo } from "../types.js";
import type { PushService } from "./push-service.js";
import type { PushSubscriptionStore } from "./subscription-store.js";
import type { PushNotificationPayload } from "./types.js";

export class ImportantOfficeMemoNotifier {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly scraper: PortalScraperService,
    private readonly authService: AuthService,
    private readonly pushService: PushService,
    private readonly store: PushSubscriptionStore,
    private readonly pollIntervalMs: number,
    private readonly notificationUrl: string,
  ) {}

  start(): void {
    void this.checkOnce();
    this.timer = setInterval(() => {
      void this.checkOnce();
    }, this.pollIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async checkOnce(): Promise<void> {
    if (this.running || this.stopped) {
      return;
    }

    this.running = true;
    try {
      for (const userId of this.store.listSubscribedUserIds()) {
        await this.checkUser(userId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Push notification polling failed: ${message}`);
    } finally {
      this.running = false;
    }
  }

  private async checkUser(userId: string): Promise<void> {
    const shouldBootstrapOnly = !this.store.isOfficeMemoBootstrapComplete(userId);
    const { items } = await this.scraper.fetchReceivedOfficeMemos(this.authService.getPortalCredentials(userId), {
      filter: "all",
      page: 1,
    });
    const importantMemos = items.filter((item) => item.isImportant);

    for (const memo of importantMemos) {
      if (this.store.hasSeenOfficeMemo(userId, memo.officeMemoId)) {
        continue;
      }

      if (shouldBootstrapOnly) {
        this.store.markOfficeMemoSeen(userId, memo.officeMemoId, false);
        continue;
      }

      await this.pushService.sendToUser(userId, this.buildPayload(memo));
      this.store.markOfficeMemoSeen(userId, memo.officeMemoId, true);
    }

    if (shouldBootstrapOnly) {
      this.store.markOfficeMemoBootstrapComplete(userId);
    }
  }

  private buildPayload(memo: ReceivedOfficeMemo): PushNotificationPayload {
    return {
      type: "office_memo",
      id: memo.officeMemoId,
      title: "重要な連絡があります",
      body: memo.title || "ポータルで内容を確認してください",
      url: this.notificationUrl,
      tag: `office-memo-${memo.officeMemoId}`,
    };
  }
}
