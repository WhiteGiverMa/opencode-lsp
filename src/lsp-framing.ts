/**
 * LSP base-protocol framing (Content-Length headers) with hard bounds so an
 * untrusted peer cannot grow the reader without limit. Unrecoverable framing
 * faults (invalid/oversized length, header past its bound) are reported once
 * via `onFatal` and stop the reader; recoverable bad frames are dropped.
 */
export type LspMessage = Record<string, unknown>;

export const MAX_HEADER_BYTES = 8 * 1024;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

const HEADER_END = "\r\n\r\n";

export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "ascii"), body]);
}

export class LspFrameReader {
  #buffer: Buffer = Buffer.alloc(0);
  #fatal = false;
  readonly #onMessage: (message: LspMessage) => void;
  readonly #onError: (error: Error) => void;
  readonly #onFatal: (error: Error) => void;

  constructor(
    onMessage: (message: LspMessage) => void,
    onError: (error: Error) => void,
    onFatal: (error: Error) => void = () => {},
  ) {
    this.#onMessage = onMessage;
    this.#onError = onError;
    this.#onFatal = onFatal;
  }

  push(chunk: Buffer): void {
    if (this.#fatal) return;
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    if (this.#buffer.length > MAX_HEADER_BYTES + MAX_FRAME_BYTES) {
      this.#fail(`frame buffer exceeded ${MAX_HEADER_BYTES + MAX_FRAME_BYTES} bytes`);
      return;
    }
    for (;;) {
      const headerEnd = this.#buffer.indexOf(HEADER_END);
      if (headerEnd === -1) {
        if (this.#buffer.length > MAX_HEADER_BYTES) {
          this.#fail(`header exceeded ${MAX_HEADER_BYTES} bytes without a delimiter`);
        }
        return;
      }
      if (headerEnd > MAX_HEADER_BYTES) {
        this.#fail(`header exceeded ${MAX_HEADER_BYTES} bytes`);
        return;
      }
      const header = this.#buffer.subarray(0, headerEnd).toString("ascii");
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (match === null) {
        this.#fail("malformed frame: missing Content-Length header");
        return;
      }
      const length = Number(match[1]);
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_FRAME_BYTES) {
        this.#fail(`invalid Content-Length: ${match[1]}`);
        return;
      }
      const start = headerEnd + HEADER_END.length;
      if (this.#buffer.length - start < length) return;
      const body = this.#buffer.subarray(start, start + length).toString("utf8");
      this.#buffer = this.#buffer.subarray(start + length);
      this.#deliver(body);
    }
  }

  #deliver(body: string): void {
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        this.#onError(new Error("Dropped non-object LSP message"));
        return;
      }
      this.#onMessage(parsed as LspMessage);
    } catch {
      this.#onError(new Error("Dropped LSP message with invalid JSON"));
    }
  }

  #fail(message: string): void {
    if (this.#fatal) return;
    this.#fatal = true;
    this.#buffer = Buffer.alloc(0);
    this.#onFatal(new Error(message));
  }
}
