import { logger } from "../lib/logger";

/**
 * Boundary to the social platform. The brief lets us assume the system can already
 * reply to comments and send messages, so this is the interface automation steps call
 * plus a logging stand-in. Replace it with `setSocialMediaClient` for a real integration.
 *
 * `idempotencyKey` is unique per step execution (`<runId>-<sequence>`): a real client
 * should forward it, or dedupe on it, so a retried step never posts twice.
 */
export interface SocialMediaClient {
  sendDm(params: {
    accountId: string;
    contactId: string;
    text: string;
    idempotencyKey: string;
  }): Promise<{ messageId: string }>;

  commentOnPost(params: {
    accountId: string;
    commentId: string;
    text: string;
    idempotencyKey: string;
  }): Promise<{ replyId: string }>;
}

export function createDummySocialMediaClient(): SocialMediaClient {
  return {
    async sendDm(params) {
      logger.info({
        event: "social_media_dm_sent",
        source: "socialMediaClient",
        ...params,
      });
      return { messageId: `msg_${params.idempotencyKey}` };
    },
    async commentOnPost(params) {
      logger.info({
        event: "social_media_comment_reply_sent",
        source: "socialMediaClient",
        ...params,
      });
      return { replyId: `reply_${params.idempotencyKey}` };
    },
  };
}

let client: SocialMediaClient | undefined;

export function getSocialMediaClient(): SocialMediaClient {
  client ??= createDummySocialMediaClient();
  return client;
}

export function setSocialMediaClient(next: SocialMediaClient): void {
  client = next;
}
