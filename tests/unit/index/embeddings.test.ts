import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cosine, readSafetensors, StaticEmbedder } from "@grenier/index";
import { loadLocalEmbedder, modelDir } from "@grenier/index/node";
import { describe, expect, it } from "vitest";

const tokenizer = {
  added_tokens: [],
  normalizer: {
    type: "BertNormalizer",
    clean_text: true,
    handle_chinese_chars: true,
    strip_accents: null,
    lowercase: true,
  },
  pre_tokenizer: { type: "BertPreTokenizer" },
  post_processor: null,
  decoder: null,
  model: {
    type: "WordPiece",
    unk_token: "[UNK]",
    continuing_subword_prefix: "##",
    max_input_chars_per_word: 100,
    vocab: { "[UNK]": 0, proxy: 1, stream: 2, "##ing": 3, budget: 4 },
  },
};

// One 2-dimensional vector per token: [UNK], proxy, stream, ##ing, budget.
const table = Float32Array.from([9, 9, 1, 0, 0.8, 0.6, 0, 1, 0, -1]);

function expectClose(actual: Float32Array | undefined, expected: number[]) {
  expect(actual?.length).toBe(expected.length);
  expected.forEach((value, index) => {
    expect(actual?.[index]).toBeCloseTo(value, 6);
  });
}

describe("StaticEmbedder", () => {
  const embedder = new StaticEmbedder("tiny", tokenizer, table, 2);

  it("averages the vectors of a text's tokens, skips unknown ones, and normalises", async () => {
    const [proxyStream] = await embedder.embed(["Proxy stream?"]);
    const length = Math.hypot(1.8, 0.6);
    expectClose(proxyStream, [1.8 / length, 0.6 / length]);
  });

  it("splits a word into word pieces, as the model was trained", async () => {
    const [streaming] = await embedder.embed(["streaming"]);
    const length = Math.hypot(0.8, 1.6);
    expectClose(streaming, [0.8 / length, 1.6 / length]);
  });
});

describe("cosine", () => {
  it("is 1 for the same direction, 0 for orthogonal or empty vectors", () => {
    expect(cosine(Float32Array.from([1, 1]), Float32Array.from([2, 2]))).toBeCloseTo(1, 6);
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBe(0);
    expect(cosine(Float32Array.from([0, 0]), Float32Array.from([1, 1]))).toBe(0);
  });
});

describe("readSafetensors", () => {
  it("reads the F32 tensor of a file", () => {
    const header = new TextEncoder().encode(
      JSON.stringify({ embeddings: { dtype: "F32", shape: [2, 2], data_offsets: [0, 16] } }),
    );
    const bytes = new Uint8Array(8 + header.length + 16);
    new DataView(bytes.buffer).setBigUint64(0, BigInt(header.length), true);
    bytes.set(header, 8);
    bytes.set(new Uint8Array(Float32Array.from([1, 2, 3, 4]).buffer), 8 + header.length);
    expect(readSafetensors(bytes)).toEqual({ shape: [2, 2], data: Float32Array.from([1, 2, 3, 4]) });
  });
});

describe("loadLocalEmbedder", () => {
  it("refuses a download that does not match its pinned hash, and writes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grenier-models-"));
    try {
      const fetchStub = (async () => new Response("not the model")) as unknown as typeof fetch;
      await expect(loadLocalEmbedder(dir, { fetch: fetchStub })).rejects.toThrow(
        /has SHA-256 [0-9a-f]{64}, expected f65d0f32/,
      );
      expect(readdirSync(modelDir(dir))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
