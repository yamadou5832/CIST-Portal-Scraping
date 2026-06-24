import webPush, { WebPushError, type PushSubscription } from "web-push";

import type { PushConfig } from "../config.js";
import type { PushSubscriptionStore } from "./subscription-store.js";
import type { PushNotificationPayload } from "./types.js";

export class PushService {
  constructor(
    private readonly config: PushConfig,
    private readonly store: PushSubscriptionStore,
  ) {
    webPush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
  }

  getPublicKey(): string {
    return this.config.vapidPublicKey;
  }

  async sendToAll(payload: PushNotificationPayload): Promise<void> {
    const subscriptions = this.store.listSubscriptions();
    await Promise.all(subscriptions.map((subscription) => this.send(subscription, payload)));
  }

  async sendToUser(userId: string, payload: PushNotificationPayload): Promise<void> {
    const subscriptions = this.store.listSubscriptions(userId);
    await Promise.all(subscriptions.map((subscription) => this.send(subscription, payload)));
  }

  private async send(subscription: PushSubscription, payload: PushNotificationPayload): Promise<void> {
    try {
      await webPush.sendNotification(subscription, JSON.stringify(payload));
    } catch (error) {
      if (error instanceof WebPushError && (error.statusCode === 404 || error.statusCode === 410)) {
        this.store.deleteSubscriptionByEndpointForAnyUser(subscription.endpoint);
        return;
      }

      throw error;
    }
  }
}
