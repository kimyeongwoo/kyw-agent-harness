import { existsSync, mkdirSync } from 'fs';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'crypto';
import { resolve } from 'path';
import { BROKER_DB_FILE, BROKER_PEER_STALE_MS, PAYLOADS_DIR } from '../lib/constants.js';
import type {
  AgentKind,
  BrokerEnqueueResponse,
  BrokerHistoryMessage,
  BrokerHistoryResponse,
  BrokerInspectionConversation,
  BrokerInspectionMessage,
  BrokerInspectionPeer,
  BrokerInspectionReceipt,
  BrokerPeerRegistration,
  BrokerPeerSession,
  BrokerPollMessage,
  BrokerPollResponse,
  BrokerReceiptState,
  BrokerResetResponse,
  BrokerWorkspaceInspectionOptions,
  BrokerWorkspaceInspection,
  WakeMethod,
} from '../lib/broker-types.js';
import type { MessageAttachment } from '../lib/types.js';
import { BROKER_SCHEMA_SQL } from './schema.js';
import { isProcessAlive } from '../lib/process-utils.js';

interface ConversationRow {
  conversation_id: string;
  workspace_root: string;
  slot: string;
  status: 'active' | 'archived';
  last_message_seq: number;
  created_at: string;
  updated_at: string;
}

interface PeerRow {
  peer_id: string;
  conversation_id: string;
  agent_kind: AgentKind;
  workspace_root: string;
  slot: string;
  pid: number | null;
  cwd: string;
  git_root: string | null;
  pane_target: string | null;
  wake_method: WakeMethod;
  capabilities_json: string;
  status: 'active' | 'stale' | 'closed';
  registered_at: string;
  last_seen_at: string;
}

interface ReceiptRow {
  conversation_id: string;
  recipient_kind: AgentKind;
  last_ack_seq: number;
  last_auto_reply_seq: number;
  updated_at: string;
}

interface MessageRow {
  message_id: string;
  conversation_id: string;
  seq: number;
  sender_peer_id: string;
  sender_kind: AgentKind;
  recipient_kind: AgentKind;
  content: string;
  content_preview: string;
  attachment_count: number;
  requires_attachment_read: 0 | 1;
  created_at: string;
}

interface AttachmentRow {
  attachment_id: string;
  message_id: string;
  kind: 'oversized-message';
  path: string;
  char_count: number;
  required: 0 | 1;
  created_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizePreview(text: string, maxChars = 280): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(normalized);
  if (chars.length <= maxChars) return normalized;
  return `${chars.slice(0, maxChars).join('')}...`;
}

function createId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function oppositeKind(kind: AgentKind): AgentKind {
  return kind === 'claude' ? 'codex' : 'claude';
}

export class BrokerStore {
  private readonly db: Database;

  constructor(dbPath = BROKER_DB_FILE) {
    mkdirSync(resolve(dbPath, '..'), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.exec(BROKER_SCHEMA_SQL);
    this.ensureMigrations();
  }

  close(): void {
    this.db.close(false);
  }

  resolveConversation(workspaceRoot: string, slot: string): BrokerPeerSession {
    const conversation = this.ensureActiveConversation(workspaceRoot, slot);
    return {
      peer_id: '',
      conversation_id: conversation.conversation_id,
      slot,
      workspace_root: workspaceRoot,
    };
  }

  registerPeer(input: BrokerPeerRegistration): BrokerPeerSession {
    this.cleanupStalePeers(input.workspace_root, input.slot);
    const conversation = this.ensureActiveConversation(input.workspace_root, input.slot);
    const peerId = createId(`peer_${input.agent_kind}`);
    const registeredAt = nowIso();

    const tx = this.db.transaction(() => {
      this.db.query(
        `UPDATE peers
         SET status = 'stale', last_seen_at = ?
         WHERE workspace_root = ? AND slot = ? AND agent_kind = ? AND status = 'active'`,
      ).run(registeredAt, input.workspace_root, input.slot, input.agent_kind);

      this.db.query(
        `INSERT INTO peers (
          peer_id, conversation_id, agent_kind, workspace_root, slot, pid, cwd, git_root,
          pane_target, wake_method, capabilities_json, status, registered_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).run(
        peerId,
        conversation.conversation_id,
        input.agent_kind,
        input.workspace_root,
        input.slot,
        input.pid,
        input.cwd,
        input.git_root ?? null,
        input.pane_target ?? null,
        input.wake_method,
        JSON.stringify(input.capabilities ?? {}),
        registeredAt,
        registeredAt,
      );
    });

    tx();

    return {
      peer_id: peerId,
      conversation_id: conversation.conversation_id,
      slot: input.slot,
      workspace_root: input.workspace_root,
      pane_target: input.pane_target,
    };
  }

  heartbeat(peerId: string): BrokerPeerSession {
    const peer = this.getPeer(peerId);
    if (!peer || peer.status !== 'active') {
      throw new Error(`Unknown or inactive peer: ${peerId}`);
    }

    this.cleanupStalePeers(peer.workspace_root, peer.slot);
    const updatedAt = nowIso();
    this.db.query('UPDATE peers SET last_seen_at = ? WHERE peer_id = ?').run(updatedAt, peerId);

    const refreshedPeer = this.getPeer(peerId);
    if (!refreshedPeer || refreshedPeer.status !== 'active') {
      throw new Error(`Peer became inactive: ${peerId}`);
    }

    const conversation = this.getConversation(refreshedPeer.conversation_id);
    if (!conversation) {
      throw new Error(`Conversation not found for peer: ${peerId}`);
    }

    return {
      peer_id: refreshedPeer.peer_id,
      conversation_id: refreshedPeer.conversation_id,
      slot: refreshedPeer.slot,
      workspace_root: refreshedPeer.workspace_root,
      pane_target: refreshedPeer.pane_target ?? undefined,
    };
  }

  pollInbox(conversationId: string, recipientKind: AgentKind, limit: number): BrokerPollResponse {
    this.requireConversation(conversationId);
    const receipt = this.ensureReceipt(conversationId, recipientKind, 0);
    const rows = this.db.query(
      `SELECT *
       FROM messages
       WHERE conversation_id = ? AND recipient_kind = ? AND seq > ?
       ORDER BY seq ASC
       LIMIT ?`,
    ).all(conversationId, recipientKind, receipt.last_ack_seq, limit + 1) as MessageRow[];

    const hasMore = rows.length > limit;
    const selectedRows = hasMore ? rows.slice(0, limit) : rows;
    const messages = this.attachmentsForMessages(selectedRows).map((message) => ({
      message_id: message.message_id,
      seq: message.seq,
      sender_kind: message.sender_kind,
      sender_peer_id: message.sender_peer_id,
      content: message.content,
      attachments: message.attachments,
      created_at: message.created_at,
    })) satisfies BrokerPollMessage[];

    return {
      conversation_id: conversationId,
      messages,
      max_seq: messages[messages.length - 1]?.seq ?? receipt.last_ack_seq,
      has_more: hasMore,
    };
  }

  ackInbox(conversationId: string, recipientKind: AgentKind, ackSeq: number): void {
    const receipt = this.ensureReceipt(conversationId, recipientKind, 0, 0);
    const updatedAt = nowIso();
    this.db.query(
      `UPDATE receipts
       SET last_ack_seq = ?, updated_at = ?
       WHERE conversation_id = ? AND recipient_kind = ?`,
    ).run(Math.max(receipt.last_ack_seq, ackSeq), updatedAt, conversationId, recipientKind);
  }

  getReceiptState(conversationId: string, recipientKind: AgentKind): BrokerReceiptState {
    return this.ensureReceipt(conversationId, recipientKind, 0, 0);
  }

  markAutoReplyHandled(conversationId: string, recipientKind: AgentKind, handledSeq: number): BrokerReceiptState {
    const receipt = this.ensureReceipt(conversationId, recipientKind, 0, 0);
    const updatedAt = nowIso();
    this.db.query(
      `UPDATE receipts
       SET last_auto_reply_seq = ?, updated_at = ?
       WHERE conversation_id = ? AND recipient_kind = ?`,
    ).run(Math.max(receipt.last_auto_reply_seq, handledSeq), updatedAt, conversationId, recipientKind);
    return this.ensureReceipt(conversationId, recipientKind, 0, 0);
  }

  enqueueMessage(input: {
    conversation_id: string;
    message_id: string;
    sender_peer_id: string;
    sender_kind: AgentKind;
    recipient_kind: AgentKind;
    content: string;
    attachments?: MessageAttachment[];
    automation_handled_seq?: number;
  }): BrokerEnqueueResponse {
    const senderPeer = this.getPeer(input.sender_peer_id);
    if (!senderPeer || senderPeer.status !== 'active') {
      throw new Error(`Active sender peer not found: ${input.sender_peer_id}`);
    }

    const tx = this.db.transaction(() => {
      const conversation = this.requireConversation(input.conversation_id);
      const createdAt = nowIso();
      const seq = conversation.last_message_seq + 1;
      const attachments = input.attachments ?? [];

      this.db.query(
        `INSERT INTO messages (
          message_id, conversation_id, seq, sender_peer_id, sender_kind, recipient_kind,
          content, content_preview, attachment_count, requires_attachment_read, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.message_id,
        input.conversation_id,
        seq,
        input.sender_peer_id,
        input.sender_kind,
        input.recipient_kind,
        input.content,
        normalizePreview(input.content),
        attachments.length,
        attachments.some((a) => a.required) ? 1 : 0,
        createdAt,
      );

      for (const attachment of attachments) {
        this.db.query(
          `INSERT INTO attachments (
            attachment_id, message_id, kind, path, char_count, required, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(createId('att'), input.message_id, attachment.kind, attachment.path, attachment.char_count, attachment.required ? 1 : 0, createdAt);
      }

      this.db.query(
        'UPDATE conversations SET last_message_seq = ?, updated_at = ? WHERE conversation_id = ?',
      ).run(seq, createdAt, input.conversation_id);

      if (typeof input.automation_handled_seq === 'number') {
        const senderReceipt = this.ensureReceipt(input.conversation_id, input.sender_kind, 0, 0);
        this.db.query(
          `UPDATE receipts
           SET last_auto_reply_seq = ?, updated_at = ?
           WHERE conversation_id = ? AND recipient_kind = ?`,
        ).run(
          Math.max(senderReceipt.last_auto_reply_seq, input.automation_handled_seq),
          createdAt,
          input.conversation_id,
          input.sender_kind,
        );
      }

      const recipientPeer = this.db.query(
        `SELECT pane_target, wake_method
         FROM peers
         WHERE conversation_id = ? AND agent_kind = ? AND status = 'active'
         ORDER BY last_seen_at DESC
         LIMIT 1`,
      ).get(input.conversation_id, input.recipient_kind) as { pane_target: string | null; wake_method: WakeMethod | null } | null;

      return {
        conversation_id: input.conversation_id,
        message_id: input.message_id,
        seq,
        recipient_pane_target: recipientPeer?.pane_target ?? undefined,
        recipient_wake_method: recipientPeer?.wake_method ?? undefined,
      } satisfies BrokerEnqueueResponse;
    });

    return tx();
  }

  getHistory(conversationId: string, limit: number): BrokerHistoryResponse {
    this.requireConversation(conversationId);
    const countRow = this.db.query(
      'SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?',
    ).get(conversationId) as { count: number };

    const rows = this.db.query(
      `SELECT *
       FROM messages
       WHERE conversation_id = ?
       ORDER BY seq DESC
       LIMIT ?`,
    ).all(conversationId, limit) as MessageRow[];

    const messages = this.attachmentsForMessages(rows.reverse()).map((message) => ({
      message_id: message.message_id,
      seq: message.seq,
      sender_kind: message.sender_kind,
      recipient_kind: message.recipient_kind,
      content: message.content,
      attachments: message.attachments,
      created_at: message.created_at,
    })) satisfies BrokerHistoryMessage[];

    return {
      messages,
      returned_messages: messages.length,
      has_more: countRow.count > limit,
      limit,
    };
  }

  resetConversation(workspaceRoot: string, slot: string): BrokerResetResponse {
    const tx = this.db.transaction(() => {
      const activeConversation = this.getActiveConversation(workspaceRoot, slot);
      const archivedAt = nowIso();

      if (activeConversation) {
        this.db.query(
          `UPDATE conversations SET status = 'archived', updated_at = ? WHERE conversation_id = ?`,
        ).run(archivedAt, activeConversation.conversation_id);
      }

      const freshConversation = this.createConversation(workspaceRoot, slot, 'active');
      this.db.query(
        `UPDATE peers
         SET conversation_id = ?, last_seen_at = ?
         WHERE workspace_root = ? AND slot = ? AND status = 'active'`,
      ).run(freshConversation.conversation_id, archivedAt, workspaceRoot, slot);

      return {
        conversation_id: freshConversation.conversation_id,
      } satisfies BrokerResetResponse;
    });

    return tx();
  }

  inspectWorkspace(workspaceRoot: string, options: BrokerWorkspaceInspectionOptions = {}): BrokerWorkspaceInspection {
    this.cleanupStalePeers(workspaceRoot);

    const listConversationRows = (status: 'active' | 'archived') => {
      if (options.slot) {
        return this.db.query(
          `SELECT conversation_id, slot, status, last_message_seq, updated_at
           FROM conversations
           WHERE workspace_root = ? AND status = ? AND slot = ?
           ORDER BY updated_at DESC`,
        ).all(workspaceRoot, status, options.slot) as Array<Pick<ConversationRow, 'conversation_id' | 'slot' | 'status' | 'last_message_seq' | 'updated_at'>>;
      }

      return this.db.query(
        `SELECT conversation_id, slot, status, last_message_seq, updated_at
         FROM conversations
         WHERE workspace_root = ? AND status = ?
         ORDER BY slot ASC, updated_at DESC`,
      ).all(workspaceRoot, status) as Array<Pick<ConversationRow, 'conversation_id' | 'slot' | 'status' | 'last_message_seq' | 'updated_at'>>;
    };

    const buildInspectionConversation = (
      conversation: Pick<ConversationRow, 'conversation_id' | 'slot' | 'status' | 'last_message_seq' | 'updated_at'>,
    ): BrokerInspectionConversation => {
      const peers = this.db.query(
        `SELECT peer_id, agent_kind, pid, pane_target, status, last_seen_at
         FROM peers WHERE conversation_id = ? ORDER BY agent_kind ASC, last_seen_at DESC`,
      ).all(conversation.conversation_id) as Array<{
        peer_id: string; agent_kind: AgentKind; pid: number | null; pane_target: string | null;
        status: 'active' | 'stale' | 'closed'; last_seen_at: string;
      }>;

      const receipts = this.db.query(
        `SELECT recipient_kind, last_ack_seq, last_auto_reply_seq, updated_at
         FROM receipts WHERE conversation_id = ? ORDER BY recipient_kind ASC`,
      ).all(conversation.conversation_id) as BrokerInspectionReceipt[];

      const inspectionMessages = options.include_messages
        ? this.attachmentsForMessages(
            (this.db.query(
              `SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?`,
            ).all(conversation.conversation_id, Math.max(1, options.message_limit ?? 20)) as MessageRow[]).reverse(),
          ).map((m) => ({
            message_id: m.message_id, seq: m.seq, sender_kind: m.sender_kind, recipient_kind: m.recipient_kind,
            content: m.content, attachments: m.attachments, created_at: m.created_at,
          })) satisfies BrokerInspectionMessage[]
        : undefined;

      return {
        conversation_id: conversation.conversation_id,
        slot: conversation.slot,
        status: conversation.status,
        last_message_seq: conversation.last_message_seq,
        updated_at: conversation.updated_at,
        peers: peers.map((p) => ({
          peer_id: p.peer_id, agent_kind: p.agent_kind, pid: p.pid,
          pane_target: p.pane_target ?? undefined, status: p.status, last_seen_at: p.last_seen_at,
        })) satisfies BrokerInspectionPeer[],
        receipts,
        ...(inspectionMessages ? { messages: inspectionMessages } : {}),
      } satisfies BrokerInspectionConversation;
    };

    const activeConversations = listConversationRows('active').map(buildInspectionConversation);
    const archivedConversations = options.include_archived
      ? listConversationRows('archived').map(buildInspectionConversation)
      : undefined;

    const archivedCount = (this.db.query(
      `SELECT COUNT(*) AS count FROM conversations
       WHERE workspace_root = ? AND status = 'archived'${options.slot ? ' AND slot = ?' : ''}`,
    ).get(...(options.slot ? [workspaceRoot, options.slot] : [workspaceRoot])) as { count: number }).count;

    const activePeerCount = (this.db.query(
      `SELECT COUNT(*) AS count FROM peers
       WHERE workspace_root = ? AND status = 'active'${options.slot ? ' AND slot = ?' : ''}`,
    ).get(...(options.slot ? [workspaceRoot, options.slot] : [workspaceRoot])) as { count: number }).count;

    return {
      workspace_root: workspaceRoot,
      active_conversations: activeConversations,
      ...(archivedConversations ? { archived_conversations: archivedConversations } : {}),
      archived_conversation_count: archivedCount,
      active_peer_count: activePeerCount,
    };
  }

  getBrokerStats(): { active_conversations: number; active_peers: number } {
    this.cleanupStalePeers();
    const activeConversations = (this.db.query(
      `SELECT COUNT(*) AS count FROM conversations WHERE status = 'active'`,
    ).get() as { count: number }).count;
    const activePeers = (this.db.query(
      `SELECT COUNT(*) AS count FROM peers WHERE status = 'active'`,
    ).get() as { count: number }).count;
    return { active_conversations: activeConversations, active_peers: activePeers };
  }

  private cleanupStalePeers(workspaceRoot?: string, slot?: string): void {
    const rows = (workspaceRoot && slot)
      ? this.db.query(
          `SELECT peer_id, pid, last_seen_at FROM peers
           WHERE status = 'active' AND workspace_root = ? AND slot = ?`,
        ).all(workspaceRoot, slot)
      : workspaceRoot
        ? this.db.query(
            `SELECT peer_id, pid, last_seen_at FROM peers
             WHERE status = 'active' AND workspace_root = ?`,
          ).all(workspaceRoot)
        : this.db.query(
            `SELECT peer_id, pid, last_seen_at FROM peers WHERE status = 'active'`,
          ).all();

    const threshold = Date.now() - BROKER_PEER_STALE_MS;
    for (const row of rows as Array<{ peer_id: string; pid: number | null; last_seen_at: string }>) {
      const tooOld = Date.parse(row.last_seen_at) < threshold;
      if (tooOld || !isProcessAlive(row.pid)) {
        this.db.query(
          `UPDATE peers SET status = 'stale', last_seen_at = ? WHERE peer_id = ?`,
        ).run(nowIso(), row.peer_id);
      }
    }
  }

  private createConversation(workspaceRoot: string, slot: string, status: 'active' | 'archived'): ConversationRow {
    const conversationId = createId('conv');
    const createdAt = nowIso();
    this.db.query(
      `INSERT INTO conversations (
        conversation_id, workspace_root, slot, status, last_message_seq, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 0, ?, ?)`,
    ).run(conversationId, workspaceRoot, slot, status, createdAt, createdAt);
    this.ensureReceipt(conversationId, 'claude', 0, 0);
    this.ensureReceipt(conversationId, 'codex', 0, 0);
    return this.requireConversation(conversationId);
  }

  private ensureActiveConversation(workspaceRoot: string, slot: string): ConversationRow {
    return this.getActiveConversation(workspaceRoot, slot)
      ?? this.createConversation(workspaceRoot, slot, 'active');
  }

  private getActiveConversation(workspaceRoot: string, slot: string): ConversationRow | null {
    return this.db.query(
      `SELECT * FROM conversations WHERE workspace_root = ? AND slot = ? AND status = 'active' LIMIT 1`,
    ).get(workspaceRoot, slot) as ConversationRow | null;
  }

  private getConversation(conversationId: string): ConversationRow | null {
    return this.db.query(
      'SELECT * FROM conversations WHERE conversation_id = ? LIMIT 1',
    ).get(conversationId) as ConversationRow | null;
  }

  private requireConversation(conversationId: string): ConversationRow {
    const conversation = this.getConversation(conversationId);
    if (!conversation) throw new Error(`Conversation not found: ${conversationId}`);
    return conversation;
  }

  private getPeer(peerId: string): PeerRow | null {
    return this.db.query(
      'SELECT * FROM peers WHERE peer_id = ? LIMIT 1',
    ).get(peerId) as PeerRow | null;
  }

  private ensureReceipt(conversationId: string, recipientKind: AgentKind, lastAckSeq: number, lastAutoReplySeq: number): ReceiptRow {
    const existing = this.db.query(
      `SELECT * FROM receipts WHERE conversation_id = ? AND recipient_kind = ?`,
    ).get(conversationId, recipientKind) as ReceiptRow | null;
    if (existing) return existing;

    const updatedAt = nowIso();
    this.db.query(
      `INSERT INTO receipts (conversation_id, recipient_kind, last_ack_seq, last_auto_reply_seq, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(conversationId, recipientKind, lastAckSeq, lastAutoReplySeq, updatedAt);

    return {
      conversation_id: conversationId,
      recipient_kind: recipientKind,
      last_ack_seq: lastAckSeq,
      last_auto_reply_seq: lastAutoReplySeq,
      updated_at: updatedAt,
    };
  }

  private ensureMigrations(): void {
    const receiptColumns = this.db.query(`PRAGMA table_info(receipts)`).all() as Array<{ name: string }>;
    if (!receiptColumns.some((column) => column.name === 'last_auto_reply_seq')) {
      this.db.exec(`ALTER TABLE receipts ADD COLUMN last_auto_reply_seq INTEGER NOT NULL DEFAULT 0`);
    }
  }

  private attachmentsForMessages<T extends MessageRow>(rows: T[]): Array<T & { attachments?: MessageAttachment[] }> {
    if (rows.length === 0) return [];

    const messageIds = rows.map((r) => r.message_id);
    const placeholders = messageIds.map(() => '?').join(', ');
    const attachmentRows = this.db.query(
      `SELECT * FROM attachments WHERE message_id IN (${placeholders}) ORDER BY created_at ASC`,
    ).all(...messageIds) as AttachmentRow[];

    const byMsgId = new Map<string, MessageAttachment[]>();
    for (const row of attachmentRows) {
      const list = byMsgId.get(row.message_id) ?? [];
      list.push({ kind: row.kind, path: row.path, required: row.required === 1, char_count: row.char_count });
      byMsgId.set(row.message_id, list);
    }

    return rows.map((r) => ({ ...r, attachments: byMsgId.get(r.message_id) }));
  }
}

export function createBrokerStore(dbPath = BROKER_DB_FILE): BrokerStore {
  if (!existsSync(PAYLOADS_DIR)) {
    mkdirSync(PAYLOADS_DIR, { recursive: true });
  }
  return new BrokerStore(dbPath);
}
