import { describe, expect, it } from 'bun:test';
import { restoreTruncatedSep } from '../../../src/services/vector/LocalEmbedder.js';

const CLS = 101n;
const SEP = 102n;

/** One row of `length` positions: [CLS], word pieces, then [SEP] unless cut. */
function row(length: number, withSep: boolean, padTo = length): { ids: bigint[]; mask: bigint[] } {
  const ids = [CLS, ...Array.from({ length: length - 2 }, (_, i) => BigInt(2000 + i)), withSep ? SEP : 9999n];
  const mask = ids.map(() => 1n);
  while (ids.length < padTo) { ids.push(0n); mask.push(0n); }
  return { ids, mask };
}

function batch(rows: Array<{ ids: bigint[]; mask: bigint[] }>) {
  return {
    ids: BigInt64Array.from(rows.flatMap(r => r.ids)),
    mask: BigInt64Array.from(rows.flatMap(r => r.mask)),
  };
}

describe('restoreTruncatedSep', () => {
  it('ends a truncated row in [SEP], as the Rust tokenizer does', () => {
    const { ids, mask } = batch([row(256, false)]);
    restoreTruncatedSep(ids, mask, 256, SEP);
    expect(ids[255]).toBe(SEP);
    expect(ids[254]).toBe(2000n + 253n);
    expect(ids[0]).toBe(CLS);
  });

  it('leaves a document of exactly 256 tokens and shorter padded rows alone', () => {
    const exact = row(256, true);
    const short = row(40, true, 256);
    const { ids, mask } = batch([exact, short]);
    const before = ids.slice();
    restoreTruncatedSep(ids, mask, 256, SEP);
    expect(ids).toEqual(before);
  });

  it('does nothing when no row reached the limit', () => {
    const { ids, mask } = batch([row(30, true), row(12, true, 30)]);
    const before = ids.slice();
    restoreTruncatedSep(ids, mask, 30, SEP);
    expect(ids).toEqual(before);
  });
});
