import { parseDocument } from "yaml";

// yaml.parse() emits source-bearing warnings directly to stderr. Keep parsing
// non-emitting and reject unsupported constructs instead of guessing at them.
export function parseYamlSource(text) {
  const document = parseDocument(text, {
    logLevel: "error",
    stringKeys: true,
    prettyErrors: false,
  });
  const diagnostics = [...document.errors, ...document.warnings];
  if (diagnostics.length > 0) {
    throw new Error(
      `YAML requires review: ${[...new Set(diagnostics.map((item) => item.code))].join(", ")}`,
    );
  }
  return document.toJS({ maxAliasCount: 100 });
}
