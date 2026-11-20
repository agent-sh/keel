// True inside a desktop shell's system webview (WebKitGTK on Linux). There the
// toolkit draws the right-click menu and the title-bar, so the page draws its
// own; in a browser tab the browser's menu stays.
const ua = navigator.userAgent;
export const inShell =
  "__electrobunWebviewId" in window ||
  (/AppleWebKit/.test(ua) && /Linux/.test(ua) && !/Chrom|Android/.test(ua));
if (inShell) document.documentElement.dataset.shell = "";
