/**
 * The page the browser is left on after Google sends it back to the loopback server: one card in
 * the board's soft look (bwat web/pages/board/ui/soft.css, the --sf-* tokens), light or dark as
 * the system is. Self-contained, because the server that served it closes straight after.
 */

// The board header's lens, as drawn in bwat web/pages/board/board.html.
const LENS =
  '<svg viewBox="0 0 68.84 68.84" width="36" height="36" aria-hidden="true" focusable="false"><circle cx="34.42" cy="34.42" r="34.42" fill="#231f20"/>' +
  '<path fill="#f15a36" d="M44.56,51.63c-2.98,1.76-6.44,2.78-10.14,2.78-11.05,0-20-8.95-20-20s8.950-20,20-20,20,8.95,20,20c0,3.71-1.03,7.17-2.78,10.14l2.19,2.19c2.27-3.57,3.59-7.8,3.59-12.34,0-12.7-10.3-23-23-23s-23,10.3-23,23,10.3,23,23,23c4.54,0,8.77-1.32,12.34-3.59l-2.19-2.19Z"/>' +
  '<path fill="#fff" d="M55.54,51.3l-6.46-6.46c2.09-2.94,3.34-6.53,3.34-10.42,0-9.94-8.06-18-18-18s-18,8.06-18,18,8.06,18,18,18c3.89,0,7.48-1.24,10.42-3.34l6.46,6.46c1.17,1.17,3.07,1.17,4.24,0s1.17-3.07,0-4.24ZM34.42,48.42c-7.73,0-14-6.27-14-14s6.27-14,14-14,14,6.27,14,14-6.27,14-14,14Z"/>' +
  '<circle cx="34.42" cy="34.42" r="14" fill="#231f20"/></svg>';

const STYLE = `
:root{color-scheme:light dark;
  --sf-page:#f1f4f7;--sf-card:#fff;--sf-title:#22262e;--sf-ink:#1d2129;--sf-ink-3:#5b6270;
  --sf-shadow-panel:0 1px 3px #1d212912,0 14px 44px #1d212924}
@media (prefers-color-scheme:dark){:root{
  --sf-page:#14161b;--sf-card:#1f232a;--sf-title:#e3e6ea;--sf-ink:#e8eaed;--sf-ink-3:#a3aab5;
  --sf-shadow-panel:0 0 0 1px #ffffff0d,0 16px 48px #0000008c}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--sf-page);color:var(--sf-ink);
  font:15px/1.5 "Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,sans-serif}
main{width:100%;max-width:380px;padding:32px 28px 30px;border-radius:16px;background:var(--sf-card);box-shadow:var(--sf-shadow-panel);
  text-align:center;animation:in .24s ease-out}
.brand{display:inline-flex;align-items:center;gap:9px;font-size:20px;font-weight:700;letter-spacing:-.4px}
h1{margin:22px 0 6px;color:var(--sf-title);font-size:22px;font-weight:600;letter-spacing:-.3px;line-height:1.3}
p{margin:0;color:var(--sf-ink-3);text-wrap:balance}
@keyframes in{from{opacity:0}}
@media (prefers-reduced-motion:reduce){main{animation:none}}
`;

const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export function signInPage(heading: string, line: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>bwat</title><link rel="icon" href="data:,"><style>${STYLE}</style></head>
<body><main><div class="brand">${LENS}<span>bwat</span></div><h1>${escape(heading)}</h1><p>${escape(line)}</p></main></body></html>
`;
}

const FORM_STYLE = `
form{display:grid;gap:12px;text-align:left;margin:18px 0 0}
label{display:grid;gap:4px;font-size:13px;font-weight:600;color:var(--sf-ink)}
input{font:inherit;font-weight:400;padding:9px 12px;border-radius:10px;border:1px solid color-mix(in srgb,var(--sf-ink-3) 45%,transparent);
  background:var(--sf-page);color:var(--sf-ink)}
#code{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;letter-spacing:.5px;text-transform:uppercase}
button{font:inherit;font-weight:600;padding:9px 20px;border:0;border-radius:999px;background:#2f6fed;color:#fff;cursor:pointer}
@media (prefers-color-scheme:dark){button{background:#6b9bff;color:#14161b}}
.error{margin:12px 0 0;color:var(--sf-ink)}
`;

/**
 * The page a code sign-in opens (auth/code.ts): the install's code and an email,
 * posted back to the same one-shot server. `error` is the last try's refusal, or empty.
 */
export function codePage(error: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>bwat: sign in</title><link rel="icon" href="data:,"><style>${STYLE}${FORM_STYLE}</style></head>
<body><main><div class="brand">${LENS}<span>bwat</span></div><h1>Sign in to bwat</h1>
<p>Type the code <code>./bwat setup</code> showed, and your email. Anyone with the code can sign in, as any email.</p>
<form method="post">
<label for="code">Install code<input id="code" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" required></label>
<label for="email">Your email<input id="email" name="email" type="email" autocomplete="email" required></label>
<button type="submit">Sign in</button>
</form>${error ? `<p class="error" role="alert">${escape(error)}</p>` : ''}</main></body></html>
`;
}
