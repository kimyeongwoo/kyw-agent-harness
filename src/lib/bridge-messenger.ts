import { randomUUID } from 'crypto';
import type { AgentKind } from './broker-types.js';
import type { BrokerClient } from './broker-client.js';
import { prepareMessagePayload } from './payloads.js';
import { sendWakeup } from './adapter-utils.js';

export interface BridgeSendResult {
  sent: true;
  message_id: string;
  trigger_sent: boolean;
}

export async function sendBridgeMessage(options: {
  brokerClient: BrokerClient;
  senderKind: AgentKind;
  recipientKind: AgentKind;
  text: string;
  wakeText: string;
}): Promise<BridgeSendResult> {
  const session = await options.brokerClient.ensureRegistered();
  const messageId = randomUUID();
  const preparedPayload = await prepareMessagePayload(
    options.senderKind,
    session.conversation_id,
    options.text,
    { messageId },
  );
  const enqueueResult = await options.brokerClient.enqueueMessage({
    messageId,
    recipientKind: options.recipientKind,
    content: preparedPayload.content,
    attachments: preparedPayload.attachments,
  });
  const triggerSent = await sendWakeup(
    enqueueResult.conversation_id,
    options.recipientKind,
    enqueueResult.recipient_wake_method,
    enqueueResult.recipient_pane_target,
    options.wakeText,
  );
  return { sent: true, message_id: enqueueResult.message_id, trigger_sent: triggerSent };
}
