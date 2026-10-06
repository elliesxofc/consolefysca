// Default fysca server the console talks to, e.g. "https://your-fysca-host".
// Leave it blank to type the address on the sign-in screen instead. Either
// way, whatever you sign in with is remembered on the phone.
//
// seasons lists quick-pick servers shown as buttons on the sign-in screen,
// so switching seasons doesn't mean memorizing or retyping a domain. Add
// more entries here as new seasons come online.
window.FYSC_CONFIG = {
  apiBase: 'https://datafyscs9.lilianax.lol',
  seasons: [
    { label: 'Season 9', apiBase: 'https://datafyscs9.lilianax.lol' },
    { label: 'Season 1', apiBase: 'https://fyscs1-private-canada5493.tnstats.dev' }
  ]
};
