export interface MessageAttachment {
  kind: 'oversized-message';
  path: string;
  required: boolean;
  char_count: number;
}

export interface BridgeMessage {
  id: string;
  sender: 'claude' | 'codex';
  content: string;
  attachments?: MessageAttachment[];
  timestamp: string;
  turn: number;
}

export interface HealthStatus {
  server: 'claude-mcp' | 'codex-mcp';
  uptime_ms: number;
  started_at: string;
  error_count: number;
  pid?: number;
  last_error?: string;
  last_message_at?: string;
  platform: 'unix' | 'windows';
  mux_available: boolean;
  peer_id?: string;
  conversation_id?: string;
  slot?: string;
  broker_connected?: boolean;
  broker_pid?: number;
  broker_port?: number;
  broker_uptime_ms?: number;
  wake_target?: string;
  pane_target?: string;
  wake_method?: 'none' | 'mux_send_keys' | 'http_post';
  wake_count?: number;
  last_wake_at?: string;
  multi_instance_warning?: boolean;
  auto_reply_enabled?: boolean;
  auto_reply_disabled_reason?: string;
  auto_reply_last_reply_at?: string;
  auto_reply_last_error?: string;
  message_loop_running?: boolean;
  message_loop_last_error?: string;
  message_loop_last_notified_seq?: number;
  message_loop_last_notified_at?: string;
  message_loop_notification_count?: number;
}
