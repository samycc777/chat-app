// A mention is stored in a message as <@userId>, so it still points at the right person after they
// change their name, and is shown as @Name. @everyone is written as it is.
export const MENTION = /<@([0-9a-f-]{36})>/gi;
const EVERYONE = /(^|\s)@everyone\b/i;

export type MessagePart = { text: string; href?: string; mention?: string };

export function mentionsUser(content: string | null | undefined, userId: string) {
  if (!content) return false;
  return content.toLowerCase().includes(`<@${userId.toLowerCase()}>`) || EVERYONE.test(content);
}

// Shows mentions by name, for places that only display plain text such as reply previews.
export function readableText(content: string | null | undefined, nameOf: (userId: string) => string | undefined) {
  return (content ?? '').replace(MENTION, (_match, userId: string) => `@${nameOf(userId) ?? '…'}`);
}

// Turns web addresses into links and mentions into highlighted names; trailing punctuation stays
// outside a link.
const TOKEN = /<@([0-9a-f-]{36})>|(?<![^\s])@everyone\b|\bhttps?:\/\/[^\s<>"']+|\bwww\.[^\s<>"']+/gi;
export function messageParts(text: string, nameOf: (userId: string) => string | undefined): MessagePart[] {
  const parts: MessagePart[] = [];
  let position = 0;
  for (const match of text.matchAll(TOKEN)) {
    const start = match.index ?? 0;
    let token = match[0];
    let part: MessagePart;
    if (match[1]) {
      part = { text: `@${nameOf(match[1]) ?? '…'}`, mention: match[1].toLowerCase() };
    } else if (token.toLowerCase() === '@everyone') {
      part = { text: token, mention: 'everyone' };
    } else {
      token = token.replace(/[.,:;!?،؛؟)\]}'"]+$/u, '');
      part = { text: token, href: token.toLowerCase().startsWith('www.') ? `https://${token}` : token };
    }
    if (start > position) parts.push({ text: text.slice(position, start) });
    parts.push(part);
    position = start + token.length;
  }
  if (position < text.length) parts.push({ text: text.slice(position) });
  return parts;
}

// While typing, a mention is shown as @Name in the message box and turned into <@userId> when the
// message is sent. Longer names go first, so "@Abu Bakr" is not taken for "@Abu".
export function encodeMentions(text: string, chosen: Map<string, string>) {
  let result = text;
  for (const [name, userId] of [...chosen].sort((a, b) => b[0].length - a[0].length)) {
    result = result.split(`@${name}`).join(`<@${userId}>`);
  }
  return result;
}

export function decodeMentions(content: string, nameOf: (userId: string) => string | undefined) {
  const chosen = new Map<string, string>();
  const text = content.replace(MENTION, (_match, userId: string) => {
    const name = nameOf(userId);
    if (!name) return _match;
    chosen.set(name, userId.toLowerCase());
    return `@${name}`;
  });
  return { text, chosen };
}
