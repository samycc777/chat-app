// An iPhone keeps an app added to the Home Screen apart from Safari: it starts with empty storage,
// so it would not know the invite or who this is. The manifest link is pointed at one that carries
// them, and the server puts them in the app's start link, so the Home Screen app opens signed in as
// the same person (see the manifest route in server/index.ts, and Auth.vue, which reads them).
const link = () => document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
const stored = (key: string) => { try { return localStorage.getItem(key) || ''; } catch { return ''; } };

export function rememberForHomeScreen(displayName: string) {
  const invite = stored('inviteKey'), visitor = stored('visitorId');
  if (!invite) return;
  const query = new URLSearchParams({ invite, name: displayName });
  if (visitor) query.set('visitor', visitor);
  link()?.setAttribute('href', `/manifest.webmanifest?${query}`);
}

// After signing out, an app added from here starts at the join screen, like a new person's would.
export function forgetForHomeScreen() {
  link()?.setAttribute('href', '/manifest.webmanifest');
}
