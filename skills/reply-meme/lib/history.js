import fs from 'node:fs';
import path from 'node:path';
import { fingerprint } from './image.js';

// One process, per-conversation history; raw messages and chat identifiers are not saved.
export function createHistory(directory) {
  const file = path.join(directory, 'history.json');
  let chats = {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw?.version === 1 && raw.chats && typeof raw.chats === 'object') chats = raw.chats;
  } catch { /* missing/corrupt file starts fresh */ }
  const key = (chatKey) => fingerprint(String(chatKey));
  const get = (chatKey) => {
    const k = key(chatKey);
    const old = chats[k];
    if (!old || !Array.isArray(old.items)) chats[k] = { items: [], lastAuto: 0, updated: 0 };
    return chats[k];
  };
  const persist = () => {
    chats = Object.fromEntries(Object.entries(chats).sort((a, b) => (b[1]?.updated || 0) - (a[1]?.updated || 0)).slice(0, 200));
    try {
      fs.mkdirSync(directory, { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ version: 1, chats }));
      fs.renameSync(temp, file);
    } catch { /* memory history remains useful if disk is read-only */ }
  };
  return {
    seen(chatKey, urlHash, hash) {
      return get(chatKey).items.some((x) => x && ((urlHash && x.urlHash === urlHash) || (hash && x.hash === hash)));
    },
    cooling(chatKey, seconds) { return Date.now() - (Number(get(chatKey).lastAuto) || 0) < seconds * 1000; },
    mark(chatKey, item, auto) {
      const chat = get(chatKey);
      chat.items = chat.items.filter((x) => x?.hash !== item.hash);
      chat.items.push({ urlHash: item.urlHash, hash: item.hash });
      chat.items = chat.items.slice(-80);
      chat.updated = Date.now();
      if (auto) chat.lastAuto = chat.updated;
      persist();
    }
  };
}
