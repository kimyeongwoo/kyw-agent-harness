import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { resolve } from 'path';
import { BrokerStore, createBrokerStore } from '../src/broker/db';

const TEST_WORKSPACE = resolve(import.meta.dir, '.test-workspace-broker');
const TEST_DB = resolve(TEST_WORKSPACE, 'test-broker.db');

let store: BrokerStore;
let testCounter = 0;

beforeEach(() => {
  testCounter++;
  mkdirSync(TEST_WORKSPACE, { recursive: true });
  store = new BrokerStore(resolve(TEST_WORKSPACE, `test-broker-${testCounter}.db`));
});

afterEach(() => {
  try { store.close(); } catch {}
  try { rmSync(TEST_WORKSPACE, { recursive: true, force: true }); } catch {}
});

describe('BrokerStore', () => {
  it('creates a conversation on first resolve', () => {
    const session = store.resolveConversation('/test/workspace', 'default');
    expect(session.conversation_id).toMatch(/^conv_/);
    expect(session.slot).toBe('default');
    expect(session.workspace_root).toBe('/test/workspace');
  });

  it('returns the same conversation on repeated resolve', () => {
    const first = store.resolveConversation('/test/workspace', 'default');
    const second = store.resolveConversation('/test/workspace', 'default');
    expect(first.conversation_id).toBe(second.conversation_id);
  });

  it('registers a peer and returns session info', () => {
    const session = store.registerPeer({
      agent_kind: 'claude',
      workspace_root: '/test/workspace',
      slot: 'default',
      cwd: '/test/workspace',
      pid: process.pid,
      wake_method: 'none',
      capabilities: { attachments: true },
    });
    expect(session.peer_id).toMatch(/^peer_claude_/);
    expect(session.conversation_id).toMatch(/^conv_/);
  });

  it('heartbeat refreshes peer session', () => {
    const session = store.registerPeer({
      agent_kind: 'claude',
      workspace_root: '/test/workspace',
      slot: 'default',
      cwd: '/test/workspace',
      pid: process.pid,
      wake_method: 'none',
      capabilities: {},
    });
    const refreshed = store.heartbeat(session.peer_id);
    expect(refreshed.peer_id).toBe(session.peer_id);
    expect(refreshed.conversation_id).toBe(session.conversation_id);
  });

  it('enqueues and polls a message', () => {
    const claudeSession = store.registerPeer({
      agent_kind: 'claude',
      workspace_root: '/test/workspace',
      slot: 'default',
      cwd: '/test/workspace',
      pid: process.pid,
      wake_method: 'none',
      capabilities: {},
    });

    const enqueueResult = store.enqueueMessage({
      conversation_id: claudeSession.conversation_id,
      message_id: 'msg_test_1',
      sender_peer_id: claudeSession.peer_id,
      sender_kind: 'claude',
      recipient_kind: 'codex',
      content: 'Hello from Claude',
    });

    expect(enqueueResult.seq).toBe(1);
    expect(enqueueResult.message_id).toBe('msg_test_1');

    const pollResult = store.pollInbox(claudeSession.conversation_id, 'codex', 10);
    expect(pollResult.messages).toHaveLength(1);
    expect(pollResult.messages[0].content).toBe('Hello from Claude');
    expect(pollResult.messages[0].sender_kind).toBe('claude');
    expect(pollResult.max_seq).toBe(1);
  });

  it('ack advances the read cursor', () => {
    const session = store.registerPeer({
      agent_kind: 'claude',
      workspace_root: '/test/workspace',
      slot: 'default',
      cwd: '/test/workspace',
      pid: process.pid,
      wake_method: 'none',
      capabilities: {},
    });

    store.enqueueMessage({
      conversation_id: session.conversation_id,
      message_id: 'msg_1',
      sender_peer_id: session.peer_id,
      sender_kind: 'claude',
      recipient_kind: 'codex',
      content: 'First message',
    });

    store.ackInbox(session.conversation_id, 'codex', 1);

    const pollResult = store.pollInbox(session.conversation_id, 'codex', 10);
    expect(pollResult.messages).toHaveLength(0);
  });

  it('getHistory returns messages in chronological order', () => {
    const session = store.registerPeer({
      agent_kind: 'claude',
      workspace_root: '/test/workspace',
      slot: 'default',
      cwd: '/test/workspace',
      pid: process.pid,
      wake_method: 'none',
      capabilities: {},
    });

    for (let i = 1; i <= 3; i++) {
      store.enqueueMessage({
        conversation_id: session.conversation_id,
        message_id: `msg_${i}`,
        sender_peer_id: session.peer_id,
        sender_kind: 'claude',
        recipient_kind: 'codex',
        content: `Message ${i}`,
      });
    }

    const history = store.getHistory(session.conversation_id, 10);
    expect(history.messages).toHaveLength(3);
    expect(history.messages[0].content).toBe('Message 1');
    expect(history.messages[2].content).toBe('Message 3');
    expect(history.returned_messages).toBe(3);
  });

  it('resetConversation archives old and creates fresh', () => {
    const session = store.registerPeer({
      agent_kind: 'claude',
      workspace_root: '/test/workspace',
      slot: 'default',
      cwd: '/test/workspace',
      pid: process.pid,
      wake_method: 'none',
      capabilities: {},
    });

    store.enqueueMessage({
      conversation_id: session.conversation_id,
      message_id: 'msg_old',
      sender_peer_id: session.peer_id,
      sender_kind: 'claude',
      recipient_kind: 'codex',
      content: 'Old message',
    });

    const resetResult = store.resetConversation('/test/workspace', 'default');
    expect(resetResult.conversation_id).not.toBe(session.conversation_id);

    const history = store.getHistory(resetResult.conversation_id, 10);
    expect(history.messages).toHaveLength(0);
  });

  it('inspectWorkspace reports active conversations', () => {
    store.registerPeer({
      agent_kind: 'claude',
      workspace_root: '/test/workspace',
      slot: 'default',
      cwd: '/test/workspace',
      pid: process.pid,
      wake_method: 'none',
      capabilities: {},
    });

    const inspection = store.inspectWorkspace('/test/workspace');
    expect(inspection.active_conversations).toHaveLength(1);
    expect(inspection.active_conversations[0].slot).toBe('default');
    expect(inspection.active_peer_count).toBe(1);
  });

  it('getBrokerStats returns counts', () => {
    store.registerPeer({
      agent_kind: 'claude',
      workspace_root: '/test/workspace',
      slot: 'default',
      cwd: '/test/workspace',
      pid: process.pid,
      wake_method: 'none',
      capabilities: {},
    });

    const stats = store.getBrokerStats();
    expect(stats.active_conversations).toBe(1);
    expect(stats.active_peers).toBe(1);
  });

  it('handles attachments on enqueue and poll', () => {
    const session = store.registerPeer({
      agent_kind: 'claude',
      workspace_root: '/test/workspace',
      slot: 'default',
      cwd: '/test/workspace',
      pid: process.pid,
      wake_method: 'none',
      capabilities: {},
    });

    store.enqueueMessage({
      conversation_id: session.conversation_id,
      message_id: 'msg_att',
      sender_peer_id: session.peer_id,
      sender_kind: 'claude',
      recipient_kind: 'codex',
      content: 'Message with attachment',
      attachments: [{
        kind: 'oversized-message',
        path: 'test/file.md',
        required: true,
        char_count: 15000,
      }],
    });

    const pollResult = store.pollInbox(session.conversation_id, 'codex', 10);
    expect(pollResult.messages[0].attachments).toHaveLength(1);
    expect(pollResult.messages[0].attachments![0].path).toBe('test/file.md');
    expect(pollResult.messages[0].attachments![0].required).toBe(true);
  });
});
