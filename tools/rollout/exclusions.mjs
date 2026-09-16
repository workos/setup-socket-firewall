import { isDeepStrictEqual } from "node:util";
import { parseYamlSource } from "./yaml.mjs";

// Approved source exclusions, not repository exemptions. A changed archive,
// integrity pin, or additional non-npm source must be reviewed again.
export const REGISTRY_EXCLUSIONS = [
  "oagen",
  "oagen-emitters",
  "openapi-spec",
].map((repository) => ({
  id: `${repository}-tree-sitter-kotlin`,
  repository,
  lockfile: "package-lock.json",
  packagePath: "node_modules/tree-sitter-kotlin",
  version: "0.4.0",
  resolved:
    "https://github.com/fwcd/tree-sitter-kotlin/archive/f66d2908542e93c0204c6c241f794afe4e9cd5d1.tar.gz",
  integrity:
    "sha512-7pk1Tg/gXh+6hM4E0F2rPKeLyA/bNlYyqVu6T1Md/AV/vloakbvEZG0R4CYwUfVtgFAMZRbOtA8JBzX1SFatBA==",
  workflows: [
    ".github/workflows/ci.yml",
    ".github/workflows/lint.yml",
    ".github/workflows/release.yml",
  ],
  reason:
    "The pinned tree-sitter-kotlin GitHub archive intentionally downloads outside Socket Firewall; npm-registry dependencies still use SFW.",
  approvedBy: "matt.peake@workos.com",
  approvalRequestId: "24cb3145-70c0-471a-86b6-3f5d7b5860a0",
  approvalUrl:
    "https://tars.workos.tools/conversations/pi_ae1489a3e5ee424ebd2cac9260cbad13",
  ...(repository === "openapi-spec"
    ? {
        approvalRequestId: "bf1c082e-4112-484a-8683-f36854138690",
        // Record the project-config exception; do not waive any step overrides.
        workflows: [],
        projectNpmrc: [
          "omit-lockfile-registry-resolved=true",
          "replace-registry-host=npmjs",
        ],
        registryOverrides: true,
        registryOverridesApprovalRequestId:
          "61c52b1b-8081-48fa-9c8d-e2462e931ef7",
      }
    : {}),
}));

const workosTarball =
  "https://codeload.github.com/fwcd/tree-sitter-kotlin/tar.gz/f66d2908542e93c0204c6c241f794afe4e9cd5d1";
REGISTRY_EXCLUSIONS.push({
  ...REGISTRY_EXCLUSIONS[0],
  id: "workos-tree-sitter-kotlin",
  repository: "workos",
  manifest: "common/config/rush/pnpm-config.json",
  lockfile: "common/config/rush/pnpm-lock.yaml",
  specifier:
    "github:fwcd/tree-sitter-kotlin#f66d2908542e93c0204c6c241f794afe4e9cd5d1",
  resolved: workosTarball,
  packagePath: `tree-sitter-kotlin@${workosTarball}`,
  workflows: [],
  approvalRequestId: "61c52b1b-8081-48fa-9c8d-e2462e931ef7",
});

const mapping = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const registrySpec = (value) =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  ![".", "..", "~"].includes(value) &&
  !/\.t(?:gz|ar(?:\.gz)?)$/i.test(value) &&
  /^(?:npm:(?:@[\w.-]+\/)?[\w.-]+@)?[\w.*^~|<>= +-]+$/.test(value);

async function readWorkosSource(rule, readSource) {
  // Rush JSONC: preserve quoted strings, replace comments with whitespace so
  // malformed adjacent tokens cannot become valid JSON by concatenation.
  const manifest = JSON.parse(
    (await readSource(rule.manifest)).replace(
      /"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
      (part) => (part.startsWith('"') ? part : " "),
    ),
  );
  const lock = parseYamlSource(await readSource(rule.lockfile));
  const entry = lock?.packages?.[rule.packagePath];
  const matched =
    manifest?.globalOverrides?.["tree-sitter-kotlin"] === rule.specifier &&
    lock?.lockfileVersion === "9.0" &&
    isDeepStrictEqual(manifest.globalOverrides, lock.overrides) &&
    Object.entries(lock.overrides).every(([name, spec]) =>
      name === "tree-sitter-kotlin"
        ? spec === rule.specifier
        : registrySpec(spec),
    ) &&
    mapping(lock.packages) &&
    entry?.version === rule.version &&
    isDeepStrictEqual(entry.resolution, {
      gitHosted: true,
      integrity: rule.integrity,
      tarball: rule.resolved,
    }) &&
    Object.entries(lock.packages).every(([path, item]) => {
      if (path === rule.packagePath) return true;
      const resolution = item?.resolution;
      // Other locked sources must be registry packages or local vendored files,
      // not another network exception. This does not certify workspace scripts.
      return (
        mapping(resolution) &&
        typeof resolution.integrity === "string" &&
        Object.keys(resolution).every((key) =>
          ["integrity", "tarball"].includes(key),
        ) &&
        (resolution.tarball === undefined ||
          (typeof resolution.tarball === "string" &&
            (resolution.tarball.startsWith("https://registry.npmjs.org/") ||
              /^file:(?!\/)[\w./@-]+\.tgz$/.test(resolution.tarball))))
      );
    });
  return [{ ...rule, status: matched ? "matched" : "stale" }];
}

export async function readRegistryExclusions(repository, readSource) {
  const rule = REGISTRY_EXCLUSIONS.find(
    (entry) => entry.repository === repository,
  );
  if (!rule) return [];
  if (repository === "workos") return readWorkosSource(rule, readSource);
  // Read errors are audit errors, not permission to apply an exclusion.
  const lock = JSON.parse(await readSource(rule.lockfile));
  const manifest = JSON.parse(await readSource("package.json"));
  const packages = lock?.packages;
  const configMatches =
    !rule.projectNpmrc ||
    isDeepStrictEqual(
      (await readSource(".npmrc"))
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !/^[#;]/.test(line))
        .toSorted(),
      rule.projectNpmrc.toSorted(),
    );
  // npm install can change the lock: do not excuse an unrecorded manifest edit.
  const manifestMatches =
    manifest &&
    typeof manifest === "object" &&
    !Array.isArray(manifest) &&
    !manifest.workspaces &&
    (rule.registryOverrides
      ? manifest.overrides === undefined ||
        (mapping(manifest.overrides) &&
          Object.values(manifest.overrides).every(registrySpec))
      : manifest.overrides === undefined) &&
    [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
      "peerDependenciesMeta",
      "bundledDependencies",
      "bundleDependencies",
    ].every((key) =>
      isDeepStrictEqual(manifest[key] ?? {}, packages?.[""]?.[key] ?? {}),
    );
  const valid =
    lock?.lockfileVersion === 3 &&
    manifestMatches &&
    configMatches &&
    packages &&
    typeof packages === "object" &&
    !Array.isArray(packages) &&
    Object.values(packages).every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        (entry.resolved === undefined || typeof entry.resolved === "string") &&
        [
          "dependencies",
          "devDependencies",
          "optionalDependencies",
          "peerDependencies",
        ].every(
          (key) =>
            entry[key] === undefined ||
            (entry[key] &&
              typeof entry[key] === "object" &&
              !Array.isArray(entry[key]) &&
              Object.values(entry[key]).every(
                (spec) => spec === rule.resolved || registrySpec(spec),
              )),
        ),
    );
  const external = valid
    ? Object.entries(packages).filter(
        ([, entry]) =>
          entry.resolved !== undefined &&
          !entry.resolved.startsWith("https://registry.npmjs.org/"),
      )
    : [];
  const match =
    valid &&
    external.length === 1 &&
    external[0][0] === rule.packagePath &&
    ["version", "resolved", "integrity"].every(
      (key) => external[0][1][key] === rule[key],
    );
  return [{ ...rule, status: match ? "matched" : "stale" }];
}
