export interface ChannelBinding {
  platform: string; // "discord"
  conversationId: string; // channel, DM or thread ID
  meta?: Record<string, unknown>;
}

export interface OutboundMessage {
  text: string;
  files?: { blobId: string; name: string }[];
  replyToExternalId?: string;
}

export interface MessagePlatform {
  readonly id: string;
  readonly label: string;
  send(binding: ChannelBinding, msg: OutboundMessage): Promise<{ externalId: string }>;
  edit?(binding: ChannelBinding, externalId: string, msg: OutboundMessage): Promise<void>;
  typing?(binding: ChannelBinding): Promise<void>;
}
