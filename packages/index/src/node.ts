import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Embedder, readSafetensors, StaticEmbedder } from "./embeddings.ts";

/** Model2Vec's potion-base-8M (MIT): a new model or revision is a new pin, and its vectors never mix with these. */
export const DEFAULT_MODEL = {
  repository: "minishlab/potion-base-8M",
  revision: "bf8b056651a2c21b8d2565580b8569da283cab23",
  files: {
    "model.safetensors": "f65d0f325faadc1e121c319e2faa41170d3fa07d8c89abd48ca5358d9a223de2",
    "tokenizer.json": "e67e803f624fb4d67dea1c730d06e1067e1b14d830e2c2202569e3ef0f70bb50",
  },
} as const;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function modelDir(modelsDir: string): string {
  return join(modelsDir, `${DEFAULT_MODEL.repository.replace("/", "--")}@${DEFAULT_MODEL.revision.slice(0, 7)}`);
}

/** Downloads any file that is missing or fails its hash, unless `offline`. */
export async function loadLocalEmbedder(
  modelsDir: string,
  options: { fetch?: typeof fetch; offline?: boolean } = {},
): Promise<Embedder> {
  const model = DEFAULT_MODEL;
  const fetchFile = options.fetch ?? fetch;
  const dir = modelDir(modelsDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const files: Record<string, Uint8Array> = {};
  for (const [name, expected] of Object.entries(model.files)) {
    const path = join(dir, name);
    let bytes = existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
    if (!bytes || sha256(bytes) !== expected) {
      if (options.offline) throw new Error(`${path} is missing or damaged, and downloading is off`);
      const url = `https://huggingface.co/${model.repository}/resolve/${model.revision}/${name}`;
      const response = await fetchFile(url);
      if (!response.ok) throw new Error(`could not download ${url}: HTTP ${response.status}`);
      bytes = new Uint8Array(await response.arrayBuffer());
      const actual = sha256(bytes);
      if (actual !== expected) throw new Error(`${url} has SHA-256 ${actual}, expected ${expected}`);
      // Each process writes its own partial file: two downloading at once must not rename one under the other.
      const partial = `${path}.${process.pid}.partial`;
      writeFileSync(partial, bytes, { mode: 0o600 });
      renameSync(partial, path);
    }
    files[name] = bytes;
  }

  const { shape, data } = readSafetensors(files["model.safetensors"] as Uint8Array);
  const tokenizer = JSON.parse(new TextDecoder().decode(files["tokenizer.json"])) as object;
  return new StaticEmbedder(`${model.repository}@${model.revision.slice(0, 7)}`, tokenizer, data, shape[1] ?? 0);
}
