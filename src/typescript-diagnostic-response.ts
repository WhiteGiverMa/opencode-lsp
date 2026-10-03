import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

interface Position { line: number; character: number }
interface Range { start: Position; end: Position }
export interface TypeScriptDiagnostic {
  range: Range;
  message: string;
  severity: number;
  code: number;
  source: string;
  relatedInformation?: Array<{ location: { uri: string; range: Range }; message: string }>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function position(value: unknown): Position {
  if (!record(value) || !Number.isInteger(value.line) || !Number.isInteger(value.offset)
    || typeof value.line !== "number" || typeof value.offset !== "number" || value.line < 1 || value.offset < 1) {
    throw new Error("Invalid TypeScript diagnostic position");
  }
  return { line: value.line - 1, character: value.offset - 1 };
}
function range(start: unknown, end: unknown): Range {
  const result = { start: position(start), end: position(end) };
  if (result.end.line < result.start.line || result.end.line === result.start.line && result.end.character < result.start.character) {
    throw new Error("Invalid TypeScript diagnostic range");
  }
  return result;
}
export function parseTypeScriptDiagnostics(reply: unknown, command: string): TypeScriptDiagnostic[] {
  if (!record(reply) || reply.type !== "response" || reply.success !== true || reply.command !== command || !Array.isArray(reply.body)) {
    throw new Error(`Invalid or unsuccessful TypeScript ${command} reply`);
  }
  return reply.body.map((value: unknown) => {
    if (!record(value) || typeof value.message !== "string" || typeof value.code !== "number" || typeof value.category !== "string") {
      throw new Error("Invalid TypeScript diagnostic payload");
    }
    const result: TypeScriptDiagnostic = {
      range: range(value.startLocation, value.endLocation),
      message: value.message,
      severity: value.category === "warning" ? 2 : value.category === "suggestion" ? 4 : 1,
      code: value.code,
      source: typeof value.source === "string" ? value.source : "typescript",
    };
    if (value.relatedInformation !== undefined) {
      if (!Array.isArray(value.relatedInformation)) throw new Error("Invalid TypeScript related diagnostics");
      result.relatedInformation = value.relatedInformation.flatMap((related: unknown) => {
        if (!record(related) || typeof related.message !== "string") {
          throw new Error("Invalid TypeScript related diagnostic");
        }
        if (related.span === undefined) return [];
        if (!record(related.span) || typeof related.span.file !== "string" || !isAbsolute(related.span.file)) {
          throw new Error("Invalid TypeScript related diagnostic location");
        }
        return [{ message: related.message, location: {
          uri: pathToFileURL(related.span.file).href, range: range(related.span.start, related.span.end)
        } }];
      });
    }
    return result;
  });
}
