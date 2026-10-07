import type { Embedder } from './types.js';

/**
 * Documents per forward pass.
 *
 * A batch is padded to its longest member and run as one graph execution, so
 * activation memory grows with the batch. The caller's array length is
 * whatever a row set happened to render to, which is not a size to hand a
 * model unchecked.
 */
const EMBED_CHUNK_SIZE = 32;

/**
 * Characters per forward pass.
 *
 * A document count is not a size. 32 documents is a few kilobytes of ordinary
 * narrative and 12MB of 400KB facts, and the tokenizer walks every character
 * of both before the model truncates anything. Whichever cap binds first,
 * binds — and a chunk is never empty, so one document longer than the whole
 * budget still goes through on its own rather than wedging the loop.
 */
const EMBED_CHUNK_CHARS = 256 * 1024;

/**
 * Word pieces per document, special tokens included.
 *
 * all-MiniLM-L6-v2 was trained at 256 and Chroma's default embedding function
 * truncates there, but the Xenova tokenizer config says 512 and the
 * feature-extraction pipeline offers no max_length override. Left at 512, a
 * 1,000-token document embeds to a vector at cosine ~0.8 from the one Chroma
 * stored for the same text (measured 2026-10-07), so reused Chroma vectors and
 * fresh ones would not be comparable.
 */
const MAX_TOKENS = 256;

/**
 * Put back the [SEP] that transformers.js truncation cuts off.
 *
 * transformers.js 4.3.1 adds [CLS] and [SEP] and then cuts the whole sequence
 * to max_length (tokenization_utils.js truncateHelper), so a document longer
 * than MAX_TOKENS ends [CLS] + 255 word pieces with no [SEP]. Chroma's Rust
 * tokenizer reserves room for both: [CLS] + 254 word pieces + [SEP]. The first
 * 255 ids agree, so overwriting the last one with [SEP] yields Chroma's ids
 * exactly. A row that already ends in [SEP] (a document of exactly
 * MAX_TOKENS) is left alone, so this is a no-op once the library is fixed.
 *
 * `ids` and `mask` are row-major [rows, rowLength], as the tokenizer returns them.
 */
export function restoreTruncatedSep(
  ids: BigInt64Array,
  mask: BigInt64Array,
  rowLength: number,
  sepId: bigint,
): void {
  if (rowLength < MAX_TOKENS) return;
  for (let row = 0; row < ids.length / rowLength; row++) {
    const last = row * rowLength + MAX_TOKENS - 1;
    if (mask[last] === 1n && ids[last] !== sepId) ids[last] = sepId;
  }
}

/**
 * all-MiniLM-L6-v2 via transformers.js, in-process.
 *
 * Same model and dimensionality Chroma used (its default embedding function),
 * so vectors written by Chroma can be reused as-is. Adapted from
 * thedotmack/claude-mem#3694.
 *
 * onnxruntime-node MUST stay pinned to 1.21.0. From 1.24 they stopped shipping a
 * darwin/x64 binary, which would silently strand every Intel Mac user — and Intel
 * Macs are exactly where the #3012 reports came from. 1.21.0 ships all six
 * targets: {linux,darwin,win32} x {x64,arm64}.
 */
export class LocalEmbedder implements Embedder {
  readonly modelId = 'Xenova/all-MiniLM-L6-v2';
  readonly dims = 384;

  private model: { tokenizer: any; model: any } | null = null;
  private loading: Promise<{ tokenizer: any; model: any }> | null = null;

  /**
   * Model init costs ~3s, so it is deferred until something is actually
   * embedded — a process that only reads never pays it. Concurrent callers
   * share one in-flight load rather than racing to initialise twice.
   */
  private async ready(): Promise<{ tokenizer: any; model: any }> {
    if (this.model) return this.model;
    if (!this.loading) {
      this.loading = (async () => {
        const { AutoTokenizer, AutoModel } = await import('@huggingface/transformers');
        const tokenizer = await AutoTokenizer.from_pretrained(this.modelId);
        const model = await AutoModel.from_pretrained(this.modelId, { dtype: 'fp32' });
        this.model = { tokenizer, model };
        return this.model;
      })();
      // A failed load (no network for the first download, say) must not stick:
      // the next caller retries instead of awaiting the same rejection forever.
      this.loading.catch(() => { this.loading = null; });
    }
    return this.loading;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const vectors: Float32Array[] = [];
    let start = 0;
    while (start < texts.length) {
      const end = this.chunkEnd(texts, start);
      const chunk = await this.encode(texts.slice(start, end));
      for (const vector of chunk) vectors.push(vector);
      start = end;
    }
    return vectors;
  }

  /** Exclusive end of the chunk beginning at `start`; always past `start`. */
  private chunkEnd(texts: string[], start: number): number {
    let end = start;
    let chars = 0;
    while (end < texts.length) {
      if (end > start && (end - start >= EMBED_CHUNK_SIZE || chars + texts[end].length > EMBED_CHUNK_CHARS)) {
        break;
      }
      chars += texts[end].length;
      end++;
    }
    return end;
  }

  protected async encode(texts: string[]): Promise<Float32Array[]> {
    const { tokenizer, model } = await this.ready();
    const { mean_pooling } = await import('@huggingface/transformers');
    const inputs = tokenizer(texts, { padding: true, truncation: true, max_length: MAX_TOKENS });
    restoreTruncatedSep(
      inputs.input_ids.data,
      inputs.attention_mask.data,
      inputs.input_ids.dims[1],
      BigInt(tokenizer.sep_token_id),
    );
    const { last_hidden_state } = await model(inputs);
    // Unit-length, so cosine reduces to a dot product at query time.
    const flat = mean_pooling(last_hidden_state, inputs.attention_mask).normalize(2, -1).data as Float32Array;
    return texts.map((_, i) => {
      const slice = new Float32Array(this.dims);
      slice.set(flat.subarray(i * this.dims, (i + 1) * this.dims));
      return slice;
    });
  }
}
