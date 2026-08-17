/**
 * Served from /assets/<ASSET_VERSION>/app.css, never inlined: an inline <style> cannot 404,
 * and the ASSET_VERSION fault needs a genuine mechanism (every metric green, product broken).
 */
export const APP_CSS = `:root {
  --bg: #10131a;
  --panel: #181d27;
  --line: #2a3140;
  --text: #e7ecf3;
  --muted: #97a3b6;
  --ok: #3fb950;
  --degraded: #d29922;
  --down: #f85149;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
main { max-width: 880px; margin: 0 auto; padding: 32px 20px 64px; }
header { display: flex; align-items: baseline; gap: 16px; border-bottom: 1px solid var(--line); padding-bottom: 12px; }
header h1 { font-size: 20px; margin: 0; letter-spacing: -0.01em; }
header nav a { color: var(--muted); text-decoration: none; margin-right: 12px; }
header nav a:hover { color: var(--text); }
h2 { font-size: 16px; margin: 28px 0 12px; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-weight: 500; font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 4px 16px 16px; }
form { display: flex; gap: 8px; align-items: center; }
input[type="number"] { width: 64px; background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; }
button { background: var(--text); color: var(--bg); border: 0; border-radius: 6px; padding: 7px 14px; font-weight: 600; cursor: pointer; }
button:hover { opacity: 0.88; }
.pill { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
.hop-ok, .status-settled { background: rgba(63,185,80,0.16); color: var(--ok); }
.hop-degraded, .status-placed { background: rgba(210,153,34,0.16); color: var(--degraded); }
.hop-unreachable, .status-failed { background: rgba(248,81,73,0.16); color: var(--down); }
.muted { color: var(--muted); }
.detail { color: var(--muted); font-size: 13px; }
.error { border-left: 3px solid var(--down); padding-left: 14px; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
`;