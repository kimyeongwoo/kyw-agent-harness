import type { MessageAttachment } from './types.js';

export type AgentKind = 'claude' | 'codex';
export type WakeMethod = 'none' | 'mux_send_keys' | 'http_post';

export interface BrokerRuntimeManifest {
  pid: number;
  port: number;
  token: string;
  version: '2';
  started_at: string;
}

export interface BrokerPeerRegistration {
  agent_kind: AgentKind;
  workspace_root: string;
  slot: string;
  cwd: string;
  git_root?: string;
  pid: number;
  pane_target?: string;
  wake_method: WakeMethod;
  capabilities: Record<string, boolean>;
}

export interface BrokerPeerSession {
  peer_id: string;
  conversation_id: string;
  slot: string;
  workspace_root: string;
  pane_target?: string;
}

export interface BrokerPollMessage {
  message_id: string;
  seq: number;
  sender_kind: AgentKind;
  sender_peer_id: string;
  content: string;
  attachments?: MessageAttachment[];
  created_at: string;
}

export interface BrokerPollResponse {
  conversation_id: string;
  messages: BrokerPollMessage[];
  max_seq: number;
  has_more: boolean;
}

export interface BrokerEnqueueResponse {
  conversation_id: string;
  message_id: string;
  seq: number;
  recipient_pane_target?: string;
  recipient_wake_method?: WakeMethod;
}

export interface BrokerHistoryMessage {
  message_id: string;
  seq: number;
  sender_kind: AgentKind;
  recipient_kind: AgentKind;
  content: string;
  attachments?: MessageAttachment[];
  created_at: string;
}

export interface BrokerHistoryResponse {
  messages: BrokerHistoryMessage[];
  returned_messages: number;
  has_more: boolean;
  limit: number;
}

export interface BrokerResetResponse {
  conversation_id: string;
}

export interface BrokerHealthResponse {
  pid: number;
  port: number;
  started_at: string;
  uptime_ms: number;
  backend: 'broker';
}

export interface BrokerReceiptState {
  conversation_id: string;
  recipient_kind: AgentKind;
  last_ack_seq: number;
  last_auto_reply_seq: number;
  updated_at: string;
}

export interface BrokerInspectionPeer {
  peer_id: string;
  agent_kind: AgentKind;
  pid: number | null;
  pane_target?: string;
  status: 'active' | 'stale' | 'closed';
  last_seen_at: string;
}

export interface BrokerInspectionReceipt {
  recipient_kind: AgentKind;
  last_ack_seq: number;
  last_auto_reply_seq: number;
  updated_at: string;
}

export interface BrokerInspectionMessage {
  message_id: string;
  seq: number;
  sender_kind: AgentKind;
  recipient_kind: AgentKind;
  content: string;
  attachments?: MessageAttachment[];
  created_at: string;
}

export interface BrokerInspectionConversation {
  conversation_id: string;
  slot: string;
  status: 'active' | 'archived';
  last_message_seq: number;
  updated_at: string;
  peers: BrokerInspectionPeer[];
  receipts: BrokerInspectionReceipt[];
  messages?: BrokerInspectionMessage[];
}

export interface BrokerWorkspaceInspection {
  workspace_root: string;
  active_conversations: BrokerInspectionConversation[];
  archived_conversations?: BrokerInspectionConversation[];
  archived_conversation_count: number;
  active_peer_count: number;
}

export interface BrokerWorkspaceInspectionOptions {
  slot?: string;
  include_archived?: boolean;
  include_messages?: boolean;
  message_limit?: number;
}
