import { normalize } from '@larksuiteoapi/node-sdk';

const base = {
  event_id: 'evt_image_1',
  sender: {
    sender_id: { open_id: 'ou_sender' },
    sender_type: 'user',
    tenant_key: 'tenant_1',
  },
  message: {
    message_id: 'om_image_1',
    create_time: '1760000000000',
    chat_id: 'oc_chat',
    chat_type: 'group',
    message_type: 'image',
    content: JSON.stringify({ image_key: 'img_v3_demo' }),
  },
};

const normalized = await normalize(base, {
  includeRaw: true,
  stripBotMentions: true,
});

console.log(JSON.stringify({
  raw: normalized.raw,
  normalized: {
    messageId: normalized.messageId,
    chatId: normalized.chatId,
    rawContentType: normalized.rawContentType,
    content: normalized.content,
    resources: normalized.resources,
    hasMessageResourceGetter: typeof normalized.messageResource?.get === 'function',
    hasDownloadResource: typeof normalized.downloadResource === 'function',
  },
}, null, 2));
