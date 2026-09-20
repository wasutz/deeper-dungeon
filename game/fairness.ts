/**
 * Commit-and-reveal room draws.
 *
 * The run nonce is drawn and hashed before the first room, and the commitment is shown to the
 * player straight away. Every room is a pure function of (nonce, play ID, depth), so no room
 * result can react to a BANK or DESCEND choice. Revealing the nonce when the run ends lets the
 * player recompute every roll — the "Verify" panel prints the exact preimages.
 *
 * SHA-256 is implemented here rather than taken from WebCrypto because the game runs in a
 * sandboxed iframe with an opaque origin, where `crypto.subtle` is not guaranteed to exist.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));

export function sha256Hex(message: string): string {
  const bytes = new TextEncoder().encode(message);
  const blocks = Math.ceil((bytes.length + 9) / 64);
  const buffer = new Uint8Array(blocks * 64);
  buffer.set(bytes);
  buffer[bytes.length] = 0x80;
  new DataView(buffer.buffer).setUint32(buffer.length - 4, bytes.length * 8, false);

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const schedule = new Uint32Array(64);
  const view = new DataView(buffer.buffer);

  for (let block = 0; block < blocks; block++) {
    for (let index = 0; index < 16; index++) schedule[index] = view.getUint32(block * 64 + index * 4, false);
    for (let index = 16; index < 64; index++) {
      const a = schedule[index - 15], b = schedule[index - 2];
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      schedule[index] = (schedule[index - 16] + s0 + schedule[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const temp1 = (h + s1 + ((e & f) ^ (~e & g)) + K[index] + schedule[index]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const temp2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    const round = [a, b, c, d, e, f, g, h];
    for (let index = 0; index < 8; index++) hash[index] = (hash[index] + round[index]) >>> 0;
  }
  return [...hash].map(word => word.toString(16).padStart(8, "0")).join("");
}

export function createRunNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export type RoomDraw = Readonly<{ preimage: string; hash: string; roll: number }>;

/**
 * The first 32 bits of the digest, folded into the contract's 10000-bucket roll space.
 *
 * `tag` extends the preimage for a draw that is not the room itself -- a Lucky Charm reroll, or
 * the item an empty room yields. Each tag gets its own independent digest at the same depth, so
 * one committed nonce still recomputes every one of them and none can collide with the room roll.
 *
 * 2^32 is not a multiple of 10000, so 7296 of the buckets carry one extra preimage: a published
 * 15.00% band is really 15.0000094%. That is kept rather than rejection-sampled because a
 * verifier has to be able to recompute a room from one digest, with no retry loop to replay.
 */
export function drawRoom(nonce: string, playId: bigint, depth: number, tag?: string): RoomDraw {
  const preimage = tag === undefined ? `${nonce}:${playId}:${depth}` : `${nonce}:${playId}:${depth}:${tag}`;
  const hash = sha256Hex(preimage);
  return { preimage, hash, roll: Number(BigInt(`0x${hash.slice(0, 8)}`) % 10_000n) };
}
