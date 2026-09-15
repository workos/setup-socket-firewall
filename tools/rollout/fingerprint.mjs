import { createHash } from "node:crypto";
import { parseYamlSource } from "./yaml.mjs";

// Sort object keys, not arrays: command/step order is semantically significant.
export function canonicalJson(value) {
  return (
    JSON.stringify(value, (_key, item) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(
            Object.entries(item).sort(([a], [b]) =>
              a < b ? -1 : a > b ? 1 : 0,
            ),
          )
        : item,
    ) ?? "null"
  );
}

export function fingerprint(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function fingerprintYaml(text) {
  try {
    return fingerprint(parseYamlSource(text));
  } catch {
    return fingerprint(text);
  }
}
