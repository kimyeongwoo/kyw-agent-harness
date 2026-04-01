import { describe, expect, it } from 'bun:test';
import { createStandbyLoop } from '../src/standby/loop.js';

function createPollResult() {
  return {
    conversation_id: 'conv_test',
    messages: [{
      message_id: 'msg_1',
      seq: 1,
      sender_kind: 'claude' as const,
      sender_peer_id: 'peer_1',
      content: 'Please review this and decide whether to reply.',
      created_at: new Date().toISOString(),
    }],
    max_seq: 1,
    has_more: false,
  };
}

async function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms`);
    }
    await Bun.sleep(10);
  }
}

describe('createStandbyLoop', () => {
  it('stops without replying when the model returns the stop token', async () => {
    const acked: number[] = [];
    const enqueued: Array<{ content: string }> = [];

    const loop = createStandbyLoop({
      agentKind: 'codex',
      brokerClient: {
        pollInbox: async () => createPollResult(),
        getHistory: async () => ({ messages: [], returned_messages: 0, has_more: false, limit: 12 }),
        enqueueMessage: async (message: { content: string }) => {
          enqueued.push(message);
          return { conversation_id: 'conv_test', message_id: 'reply_1', seq: 2 };
        },
        ackInbox: async (seq: number) => {
          acked.push(seq);
        },
      } as any,
      server: {
        createMessage: async () => ({ content: { type: 'text', text: '[[STANDBY_STOP]]' } }),
        getClientCapabilities: () => ({ sampling: {} }),
      } as any,
      logPrefix: '[test-standby]',
    });

    loop.start();
    await waitFor(() => loop.getStatus().disabled_reason !== undefined);

    expect(enqueued).toHaveLength(0);
    expect(acked).toEqual([1]);
    expect(loop.getStatus().disabled_reason).toContain('no further reply required');
  });

  it('sends a final reply and then stops when the model returns the reply-and-stop token', async () => {
    const acked: number[] = [];
    const enqueued: Array<{ content: string }> = [];

    const loop = createStandbyLoop({
      agentKind: 'claude',
      brokerClient: {
        pollInbox: async () => createPollResult(),
        getHistory: async () => ({ messages: [], returned_messages: 0, has_more: false, limit: 12 }),
        enqueueMessage: async (message: { content: string }) => {
          enqueued.push(message);
          return { conversation_id: 'conv_test', message_id: 'reply_1', seq: 2 };
        },
        ackInbox: async (seq: number) => {
          acked.push(seq);
        },
      } as any,
      server: {
        createMessage: async () => ({
          content: { type: 'text', text: '[[STANDBY_REPLY_AND_STOP]]\nFinal closing reply.' },
        }),
        getClientCapabilities: () => ({ sampling: {} }),
      } as any,
      logPrefix: '[test-standby]',
    });

    loop.start();
    await waitFor(() => loop.getStatus().disabled_reason !== undefined);

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.content).toBe('Final closing reply.');
    expect(acked).toEqual([1]);
    expect(loop.getStatus().disabled_reason).toContain('after final reply');
  });

  it('requests a high-intelligence sampling run and allows up to 10 minutes', async () => {
    let capturedParams: any;
    let capturedOptions: any;
    let firstPoll = true;

    const loop = createStandbyLoop({
      agentKind: 'codex',
      brokerClient: {
        pollInbox: async () => {
          if (firstPoll) {
            firstPoll = false;
            return createPollResult();
          }
          return { conversation_id: 'conv_test', messages: [], max_seq: 1, has_more: false };
        },
        getHistory: async () => ({ messages: [], returned_messages: 0, has_more: false, limit: 12 }),
        enqueueMessage: async () => ({ conversation_id: 'conv_test', message_id: 'reply_1', seq: 2 }),
        ackInbox: async () => {},
      } as any,
      server: {
        createMessage: async (params: unknown, options: unknown) => {
          capturedParams = params;
          capturedOptions = options;
          return { content: { type: 'text', text: 'Deliberate response.' } };
        },
        getClientCapabilities: () => ({ sampling: {} }),
      } as any,
      logPrefix: '[test-standby]',
    });

    loop.start();
    await waitFor(() => loop.getStatus().last_reply_at !== undefined);
    loop.stop();

    expect(capturedParams.modelPreferences).toEqual({
      costPriority: 0,
      speedPriority: 0,
      intelligencePriority: 1,
    });
    expect(capturedParams.maxTokens).toBe(2400);
    expect(capturedOptions).toEqual({
      timeout: 600000,
      maxTotalTimeout: 600000,
      resetTimeoutOnProgress: true,
    });
    expect(capturedParams.systemPrompt).toContain('peer can wait up to 10 minutes');
  });
});
