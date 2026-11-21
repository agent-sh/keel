// A host on this machine or a private network: the web tools do not reach
// it, and the daemon's own git does not fetch from it for a confined session.
// By the name alone (nothing is resolved): a loopback, link-local or private
// address, localhost, and a name with no dot, which resolves on the local
// network.
const PRIVATE_HOST = /^(localhost|.*\.localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?$|\[?f[cd])/i;
export const privateHost = (hostname: string) => !hostname.includes(".") || PRIVATE_HOST.test(hostname);
