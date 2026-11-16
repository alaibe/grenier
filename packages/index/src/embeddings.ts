import { Tokenizer } from "@huggingface/tokenizers";

/** Turns texts into vectors whose cosine says how alike they are. */
export interface Embedder {
  /** Names the model, so vectors from different models are never compared. */
  readonly model: string;
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

/**
 * A Model2Vec static model: one vector per token, averaged over a text's tokens and normalised. No neural network
 * runs, so it needs no native code and embeds a question in well under a millisecond.
 */
export class StaticEmbedder implements Embedder {
  readonly #tokenizer: Tokenizer;
  readonly #table: Float32Array;
  readonly #unknown: number | undefined;

  constructor(
    readonly model: string,
    tokenizerJson: object,
    table: Float32Array,
    readonly dimensions: number,
  ) {
    if (table.length % dimensions !== 0) throw new Error(`${model}: the table is not a whole number of vectors`);
    this.#tokenizer = new Tokenizer(tokenizerJson, {});
    this.#table = table;
    const vocab = (tokenizerJson as { model?: { vocab?: Record<string, number>; unk_token?: string } }).model;
    this.#unknown = vocab?.unk_token ? vocab.vocab?.[vocab.unk_token] : undefined;
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    return texts.map((text) => this.#embedOne(text));
  }

  #embedOne(text: string): Float32Array {
    const vector = new Float32Array(this.dimensions);
    const ids = this.#tokenizer.encode(text, { add_special_tokens: false }).ids.filter((id) => id !== this.#unknown);
    const rows = this.#table.length / this.dimensions;
    let count = 0;
    for (const id of ids.slice(0, 512)) {
      if (id < 0 || id >= rows) continue;
      const offset = id * this.dimensions;
      for (let i = 0; i < this.dimensions; i++) vector[i] = (vector[i] ?? 0) + (this.#table[offset + i] ?? 0);
      count++;
    }
    if (count === 0) return vector;
    return normalise(vector);
  }
}

function normalise(vector: Float32Array): Float32Array {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm === 0) return vector;
  for (let i = 0; i < vector.length; i++) vector[i] = (vector[i] ?? 0) / norm;
  return vector;
}

/** Cosine similarity, from -1 to 1; 0 when either vector is all zeros. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
}

/** Reads the one F32 tensor of a safetensors file. */
export function readSafetensors(bytes: Uint8Array): { shape: number[]; data: Float32Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = Number(view.getBigUint64(0, true));
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLength))) as Record<
    string,
    { dtype: string; shape: number[]; data_offsets: [number, number] }
  >;
  const tensor = Object.entries(header).find(([name]) => name !== "__metadata__")?.[1];
  if (tensor?.dtype !== "F32") throw new Error("expected one F32 tensor in the safetensors file");
  const [start, end] = tensor.data_offsets;
  const raw = bytes.slice(8 + headerLength + start, 8 + headerLength + end);
  return { shape: tensor.shape, data: new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4) };
}
