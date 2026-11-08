/**
 * Notices when OpenTunes is open with an iPod in another tab or window of the same browser, so the
 * page can warn: two tabs changing one iPod at once could damage its library. A tab cannot compare
 * folder handles with another tab, so any other tab with an iPod open counts.
 */
export interface TabWatcher {
  /** Says whether this tab has an iPod open. Other tabs hear it. */
  announce(open: boolean): void;
  close(): void;
}

type Message = { type: 'open' | 'closed' | 'who'; from: string };

const CHANNEL = 'opentunes-ipod-open';

/** `onChange` gets true while at least one other tab says it has an iPod open. Does nothing where BroadcastChannel is missing. */
export function watchOtherTabs(onChange: (otherOpen: boolean) => void, make: (name: string) => BroadcastChannel | null = defaultChannel): TabWatcher {
  const channel = make(CHANNEL);
  if (!channel) return { announce: () => undefined, close: () => undefined };
  const me = Math.random().toString(36).slice(2);
  const others = new Set<string>();
  let mine = false;
  const post = (type: Message['type']): void => channel.postMessage({ type, from: me } satisfies Message);
  channel.onmessage = (event: MessageEvent<Message>) => {
    const message = event.data;
    if (!message || message.from === me) return;
    if (message.type === 'open') others.add(message.from);
    else if (message.type === 'closed') others.delete(message.from);
    else if (message.type === 'who' && mine) post('open');
    onChange(others.size > 0);
  };
  // A tab that opens late asks who already has an iPod open.
  post('who');
  return {
    announce(open: boolean): void {
      mine = open;
      post(open ? 'open' : 'closed');
    },
    close(): void {
      if (mine) post('closed');
      channel.close();
    },
  };
}

function defaultChannel(name: string): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel === 'function' ? new BroadcastChannel(name) : null;
  } catch {
    return null;
  }
}
