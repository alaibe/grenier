const MAX_JSON_BYTES = 16 * 1024 * 1024;

/** Reads a body as it passes through, without holding it back. */
export abstract class BodyReader<T> {
  readonly #streaming: boolean;
  readonly #decoder = new TextDecoder();
  #pending = "";
  #event = "";
  #data: string[] = [];
  #json: Uint8Array[] = [];
  #jsonBytes = 0;
  #ended = false;

  constructor(contentType: string | null) {
    this.#streaming = (contentType ?? "").includes("text/event-stream");
  }

  push(chunk: Uint8Array): void {
    if (!this.#streaming) {
      if (this.#jsonBytes + chunk.byteLength <= MAX_JSON_BYTES) this.#json.push(chunk);
      this.#jsonBytes += chunk.byteLength;
      return;
    }
    this.#pending += this.#decoder.decode(chunk, { stream: true });
    let newline = this.#pending.indexOf("\n");
    while (newline !== -1) {
      this.#line(this.#pending.slice(0, newline).replace(/\r$/, ""));
      this.#pending = this.#pending.slice(newline + 1);
      newline = this.#pending.indexOf("\n");
    }
  }

  /** Call it once the body has ended, or been cut off. */
  result(): T {
    if (!this.#ended) {
      this.#ended = true;
      if (this.#streaming) {
        if (this.#pending) this.#line(this.#pending);
        this.#line("");
      } else if (this.#jsonBytes <= MAX_JSON_BYTES) {
        const bytes = new Uint8Array(this.#jsonBytes);
        let offset = 0;
        for (const chunk of this.#json) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        this.onJson(new TextDecoder().decode(bytes));
      }
    }
    return this.read();
  }

  /** One complete event of a stream: its `event:` name ("" when it has none) and its `data:` lines joined. */
  protected abstract onEvent(event: string, data: string): void;
  protected abstract onJson(text: string): void;
  protected abstract read(): T;

  #line(line: string): void {
    if (line === "") {
      if (this.#data.length > 0) this.onEvent(this.#event, this.#data.join("\n"));
      this.#event = "";
      this.#data = [];
    } else if (line.startsWith("event:")) {
      this.#event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      this.#data.push(line.slice(5).replace(/^ /, ""));
    }
  }
}
