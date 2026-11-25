// Whether a page shows a feed now (src/server/scope.ts): a module that reads a lot to make a feed's frame
// reads only while somebody hears it. The server sets `of` when it starts; until then nothing is heard.
// `lists`: whether a page shows the session list (a socket hears the rows).
export const feedHeard: { of: (name: string) => boolean; lists: () => boolean } = { of: () => false, lists: () => false };
