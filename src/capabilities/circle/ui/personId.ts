/** A person id is a 64-hex public key; nobody reads one, so nobody sees one. */
export const short = (id: string): string => `${id.slice(0, 8)}…${id.slice(-4)}`
