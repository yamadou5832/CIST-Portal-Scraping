import type { PushSubscription } from "web-push";

export interface StoredPushSubscription extends PushSubscription {
  id: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

export interface PushSubscriptionUpsertResult {
  subscription: StoredPushSubscription;
  created: boolean;
}

export interface PushNotificationPayload {
  type: "office_memo";
  id: string;
  title: string;
  body: string;
  url: string;
  tag: string;
}
