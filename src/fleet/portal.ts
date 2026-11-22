// The portal: the owner opens a dev server one of a session's processes runs
// on a loopback port, inside the workbench. "A process of the session" is one
// the daemon started for one of the session's commands, or one of the
// processes those started: found by what the daemon holds a command by (its
// cgroup, its process group: src/tools/jobs.ts sessionRoots) and the pid tree
// below, read from /proc (Linux only; elsewhere no port is listed). Never
// by a variable in a process's environment, which the process sets itself: a
// command could name another session there and show its port in that
// session's portal. Portals live in memory: none is open after a restart.
import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { sessionRoots } from "../tools/jobs.ts";
import { IN_SANDBOX } from "../safety/net-proxy.ts";
const RELAY = IN_SANDBOX.relay;

// `ns`: the process is in a network namespace of its own (a sandboxed command's): the port is on that namespace's
// loopback, and the daemon reaches it through reachInto (src/safety/net-proxy.ts).
export type PortInfo = { port: number; pid: number; process: string; open: boolean; point?: boolean; url?: string; ns?: string };

const OWNERSHIP_MS = 2_000; // an ownership answer is reused for 2 s

type Listener = { port: number; inode: string };

// `of`: a process whose network namespace's table is read (a sandboxed command's); else the daemon's own.
function listeners(of?: string): Listener[] {
  const out: Listener[] = [];
  for (const t of of ? [`/proc/${of}/net/tcp`, `/proc/${of}/net/tcp6`] : ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text: string;
    try { text = readFileSync(t, "utf8"); } catch { continue; }
    for (const line of text.split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f[3] !== "0A" || !f[1]) continue;
      const [addr, portHex] = f[1].split(":");
      // Loopback or every address: the daemon reaches it on 127.0.0.1.
      if (!/^(0100007F|00000000|0{24}0{8}|0{24}01000000|0000000000000000FFFF00000100007F)$/i.test(addr!)) continue;
      out.push({ port: parseInt(portHex!, 16), inode: f[9]! });
    }
  }
  return out;
}

let cache: { at: number; bySession: Map<string, PortInfo[]> } | undefined;

// Ports each session's processes listen on. `roots`: the processes the daemon holds each session's commands by.
export function sessionPorts(roots: Map<string, number[]> = sessionRoots()): Map<string, PortInfo[]> {
  if (cache && Date.now() - cache.at < OWNERSHIP_MS) return cache.bySession;
  const bySession = new Map<string, PortInfo[]>();
  const mine = (() => { try { return readlinkSync("/proc/self/ns/net"); } catch { return ""; } })();
  const tables = new Map<string, Map<string, number>>([[mine, new Map(listeners().map((l) => [l.inode, l.port]))]]);
  // The table of a process's own network namespace: read once per namespace.
  const tableOf = (pid: string): { ns: string; byInode: Map<string, number> } => {
    let ns = mine;
    try { ns = readlinkSync(`/proc/${pid}/ns/net`); } catch {} // gone, or not ours to read: the daemon's own table
    let t = tables.get(ns);
    if (!t) tables.set(ns, (t = new Map(listeners(pid).map((l) => [l.inode, l.port]))));
    return { ns, byInode: t };
  };
  const uid = process.getuid?.();
  if (roots.size) {
    // The pid tree: a process the daemon holds, and what it started.
    const kids = new Map<number, number[]>();
    let names: string[] = [];
    try { names = readdirSync("/proc").filter((p) => /^\d+$/.test(p)); } catch {}
    for (const n of names) {
      try {
        const st = readFileSync(`/proc/${n}/stat`, "latin1");
        const parent = Number(st.slice(st.lastIndexOf(") ") + 2).split(" ")[1]);
        const list = kids.get(parent);
        if (list) list.push(Number(n)); else kids.set(parent, [Number(n)]);
      } catch {} // gone
    }
    for (const [session, held] of roots) {
      const seen = new Set<number>();
      const todo = [...held];
      while (todo.length) {
        const pid = todo.pop()!;
        if (seen.has(pid)) continue;
        seen.add(pid);
        todo.push(...(kids.get(pid) ?? []));
        try {
          if (uid !== undefined && statSync(`/proc/${pid}`).uid !== uid) continue;
          // (The sandbox's own relay listens there for the command's proxy variables: not a server of the session's.)
          if (readFileSync(`/proc/${pid}/cmdline`, "latin1").split("\0")[1] === RELAY) continue;
          const { ns, byInode } = tableOf(String(pid));
          if (!byInode.size) continue;
          for (const fd of readdirSync(`/proc/${pid}/fd`)) {
            let link: string;
            try { link = readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
            const ino = link.match(/^socket:\[(\d+)\]$/)?.[1];
            const port = ino ? byInode.get(ino) : undefined;
            if (port === undefined) continue;
            const list = bySession.get(session) ?? [];
            if (!list.some((p) => p.port === port)) {
              const name = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
              list.push({ port, pid, process: name, open: false, ...(ns !== mine ? { ns } : {}) });
            }
            bySession.set(session, list);
          }
        } catch {} // gone
      }
    }
  }
  cache = { at: Date.now(), bySession };
  return bySession;
}

export const forgetOwnership = () => void (cache = undefined);

// ---- open portals

type Open = { key: string; point: boolean };
const open = new Map<string, Open>(); // `${session}:${port}`

export function setOpen(session: string, port: number, on: boolean, point = false): Open | undefined {
  const k = `${session}:${port}`;
  if (!on) { open.delete(k); return undefined; }
  const cur = open.get(k);
  const o = { key: cur?.key ?? Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("hex"), point };
  open.set(k, o);
  return o;
}

export const portalOf = (session: string, port: number) => open.get(`${session}:${port}`);
export const portalPath = (session: string, port: number, key: string) => `/portal/${session}/${port}/${key}`;

// ---- rewriting what the dev server sends so it stays inside the portal

// Root-relative src, href and action of HTML, and the imports and url() of
// scripts and styles, point back into the portal.
export function rewriteHtml(html: string, prefix: string, point: boolean): string {
  const fixed = html.replace(/(\s(?:src|href|action|poster|data)\s*=\s*)(["'])\/(?!\/)/gi, `$1$2${prefix}/`);
  const script = `<script>${shim(prefix)}${point ? picker : ""}</script>`;
  return /<head[^>]*>/i.test(fixed) ? fixed.replace(/<head[^>]*>/i, (h) => h + script) : script + fixed;
}

export function rewriteCode(text: string, prefix: string): string {
  return text
    .replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])\/(?!\/)/g, `$1$2${prefix}/`)
    .replace(/(url\(\s*["']?)\/(?!\/)/g, `$1${prefix}/`);
}

// What the page's own scripts ask for by a root-relative or same-host URL,
// sockets (a dev server's hot reload) included.
const shim = (prefix: string) => `(function(){var P=${JSON.stringify(prefix)};
function fix(u){try{if(typeof u!=="string")u=String(u);if(u.startsWith("//"))return u;if(u.startsWith("/")&&!u.startsWith(P+"/"))return P+u;var x=new URL(u,location.href);if(x.host===location.host&&!x.pathname.startsWith(P+"/"))return P+x.pathname+x.search+x.hash;}catch(e){}return u}
var f=window.fetch;window.fetch=function(i,o){return f.call(this,typeof i==="string"||i instanceof URL?fix(i):new Request(fix(i.url),i),o)};
var xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){arguments[1]=fix(u);return xo.apply(this,arguments)};
if(window.EventSource){var E=window.EventSource;window.EventSource=function(u,c){return new E(fix(u),c)}}
if(window.WebSocket){var W=window.WebSocket;var WS=function(u,p){var x=new URL(String(u),location.href);if(x.host===location.host&&!x.pathname.startsWith(P+"/"))x.pathname=P+x.pathname;return p===undefined?new W(x.href):new W(x.href,p)};WS.prototype=W.prototype;["CONNECTING","OPEN","CLOSING","CLOSED"].forEach(function(k){WS[k]=W[k]});window.WebSocket=WS}
["src","href","action","poster","data"].forEach(function(a){[HTMLScriptElement,HTMLLinkElement,HTMLImageElement,HTMLAnchorElement,HTMLFormElement,HTMLIFrameElement,HTMLSourceElement,HTMLVideoElement,HTMLObjectElement].forEach(function(C){var d=Object.getOwnPropertyDescriptor(C.prototype,a);if(d&&d.set){Object.defineProperty(C.prototype,a,{get:d.get,set:function(v){d.set.call(this,fix(v))},configurable:true})}})});
var sa=Element.prototype.setAttribute;Element.prototype.setAttribute=function(n,v){if(/^(src|href|action|poster|data)$/i.test(n))v=fix(v);return sa.call(this,n,v)};
new MutationObserver(function(ms){ms.forEach(function(m){m.addedNodes.forEach(function(n){if(n.nodeType===1)["src","href","action"].forEach(function(a){var v=n.getAttribute&&n.getAttribute(a);if(v&&v.startsWith("/")&&!v.startsWith(P+"/"))sa.call(n,a,P+v)})})})}).observe(document.documentElement,{childList:true,subtree:true});
})();`;

// The element picker: a click posts what was picked to the workbench instead of acting.
const picker = `(function(){function sel(e){var p=[];while(e&&e.nodeType===1&&p.length<6){var s=e.tagName.toLowerCase();if(e.id){s+="#"+e.id;p.unshift(s);break}if(e.classList.length)s+="."+[].slice.call(e.classList,0,2).join(".");p.unshift(s);e=e.parentElement}return p.join(" > ")}
document.addEventListener("click",function(ev){ev.preventDefault();ev.stopPropagation();var r=ev.target.getBoundingClientRect();parent.postMessage({type:"keel_point",add:ev.shiftKey,selector:sel(ev.target),text:(ev.target.innerText||"").slice(0,300),rect:{x:r.x,y:r.y,width:r.width,height:r.height},viewport:{width:innerWidth,height:innerHeight},url:location.href},"*")},true);
document.addEventListener("keydown",function(ev){if(ev.key==="Escape")parent.postMessage({type:"keel_point_exit"},"*")});})();`;

// A dev server's redirect: root-relative or on its own address goes inside the
// portal, relative passes, anything else is dropped (the answer goes nowhere).
export function redirectTo(location: string, port: number, prefix: string): string | null {
  if (location.startsWith("/") && !location.startsWith("//") && !location.includes("\\")) return prefix + location;
  try {
    const u = new URL(location);
    if (["127.0.0.1", "localhost"].includes(u.hostname) && Number(u.port) === port && !location.includes("\\")) return prefix + u.pathname + u.search + u.hash;
    return null;
  } catch {
    return /^[a-z][a-z0-9+.-]*:/i.test(location) || location.includes("\\") ? null : location;
  }
}
