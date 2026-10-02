/**
 * Explicit bidirectional mapping between the local cwd-rooted workspace and the
 * remote URI the Godot editor uses for the same project.
 *
 * Only protocol URI fields are rewritten: values whose key is `uri` or ends in
 * `Uri`, plus the keys of `WorkspaceEdit.changes`. Arbitrary strings (document
 * text, `newText`, `newName`, ...) are never touched, so a source string that
 * merely begins with `file:///...` stays byte-identical. URIs outside the
 * mapped root are returned unchanged for the runtime to reject.
 */
export interface UriMapper {
  toRemote(uri: string): string;
  toLocal(uri: string): string;
}

type JsonObject = Record<string, unknown>;

const URI_KEY_SUFFIX = "Uri";

function withTrailingSlash(uri: string): string {
  return uri.endsWith("/") ? uri : `${uri}/`;
}

function mapUnder(value: string, fromRoot: string, fromPrefix: string, toRoot: string, toPrefix: string): string {
  if (value === fromRoot) return toRoot;
  if (value.startsWith(fromPrefix)) return toPrefix + value.slice(fromPrefix.length);
  return value;
}

export function createUriMapper(localRootUri: string, remoteRootUri: string): UriMapper {
  const localPrefix = withTrailingSlash(localRootUri);
  const remotePrefix = withTrailingSlash(remoteRootUri);
  return {
    toRemote: (uri) => mapUnder(uri, localRootUri, localPrefix, remoteRootUri, remotePrefix),
    toLocal: (uri) => mapUnder(uri, remoteRootUri, remotePrefix, localRootUri, localPrefix),
  };
}

function isUriKey(key: string): boolean {
  return key === "uri" || key.endsWith(URI_KEY_SUFFIX);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function rewriteProtocolUris(value: unknown, map: (uri: string) => string): unknown {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => rewriteProtocolUris(item, map));
  if (!isJsonObject(value)) return value;
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "changes" && isJsonObject(item)) {
      const changes: JsonObject = {};
      for (const [uri, edits] of Object.entries(item)) changes[map(uri)] = rewriteProtocolUris(edits, map);
      result[key] = changes;
    } else if (typeof item === "string" && isUriKey(key)) {
      result[key] = map(item);
    } else {
      result[key] = rewriteProtocolUris(item, map);
    }
  }
  return result;
}
