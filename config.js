// Default fysca server the console talks to, e.g. "https://your-fysca-host".
// Leave it blank to type the address on the sign-in screen instead. Either
// way, whatever you sign in with is remembered on the phone.
//
// seasons lists quick-pick servers shown as buttons on the sign-in screen,
// so switching seasons doesn't mean memorizing or retyping a domain.
//
// Kept EMPTY on purpose: this file is public (GitHub Pages), so any address
// written here can be read by anyone with "inspect element" -- and these are
// the fysca servers themselves, not the grind proxy. Type the address on the
// sign-in screen instead; the phone remembers it after the first sign-in.
window.FYSC_CONFIG = {
  apiBase: '',
  seasons: []
};
