import { api } from './api';

// An iPhone keeps an app added to the Home Screen apart from Safari: it starts with empty storage,
// so it would not know the invite or who this is. The manifest link is pointed at one that carries
// the invite, the name and a short-lived hand-off pass, and the server puts them in the app's start
// link, so the Home Screen app opens as the same person (see the manifest route in server/index.ts,
// makeHandoff in server/auth.ts, and Auth.vue, which reads them). The device's own identity never
// goes in the link: it would stay there, and anyone who copied it could be this person for good.
const link = () => document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
const stored = (key: string) => { try { return localStorage.getItem(key) || ''; } catch { return ''; } };

export async function rememberForHomeScreen(displayName: string) {
  const invite = stored('inviteKey');
  if (!invite) return;
  const query = new URLSearchParams({ invite, name: displayName });
  link()?.setAttribute('href', `/manifest.webmanifest?${query}`);
  // Without a pass, the Home Screen app still opens at this room with the name filled in.
  try {
    const { handoff } = await api.getHandoff();
    if (stored('inviteKey') !== invite) return;
    query.set('handoff', handoff);
    link()?.setAttribute('href', `/manifest.webmanifest?${query}`);
  } catch { /* Offline or signed out meanwhile. */ }
}

// After signing out, an app added from here starts at the join screen, like a new person's would.
export function forgetForHomeScreen() {
  link()?.setAttribute('href', '/manifest.webmanifest');
}
