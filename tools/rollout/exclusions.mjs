import { isDeepStrictEqual } from "node:util";

// Approved source exclusions, not repository exemptions. A changed archive,
// integrity pin, or additional non-npm source must be reviewed again.
export const REGISTRY_EXCLUSIONS = ["oagen", "oagen-emitters"].map(
  (repository) => ({
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
  }),
);

export async function readRegistryExclusions(repository, readSource) {
  const rule = REGISTRY_EXCLUSIONS.find(
    (entry) => entry.repository === repository,
  );
  if (!rule) return [];
  // Read errors are audit errors, not permission to apply an exclusion.
  const lock = JSON.parse(await readSource(rule.lockfile));
  const manifest = JSON.parse(await readSource("package.json"));
  const packages = lock?.packages;
  // npm install can change the lock: do not excuse an unrecorded manifest edit.
  const manifestMatches =
    manifest &&
    typeof manifest === "object" &&
    !Array.isArray(manifest) &&
    !manifest.workspaces &&
    !manifest.overrides &&
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
                (spec) =>
                  typeof spec === "string" &&
                  (spec === rule.resolved ||
                    !/[:/#]/.test(spec) ||
                    /^npm:(?:@[\w.-]+\/)?[\w.-]+@[\w.*^~|<>= +-]+$/.test(spec)),
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
