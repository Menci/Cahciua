// TDLib's "message id" is `server_id << 20` (with the bottom 20 bits encoding
// message-type flags, all zero for normal server messages). We want server ids
// everywhere outside this file — they match the message ids users see in
// t.me/<chat>/<id> links, are far less ugly in rendered IC, and survive a
// platform swap. Conversion is exact for normal server messages and only
// happens at the precise edge where we hand a value to / receive one from
// TDLib. Use multiplication / division (not bit shifts) because JS bitwise
// operators are 32-bit; the unshifted product can exceed 2^32.

const SHIFT = 1 << 20;

export const tdLibToServerMessageId = (tdLibId: number): number => Math.floor(tdLibId / SHIFT);

export const serverToTdLibMessageId = (serverId: number): number => serverId * SHIFT;
