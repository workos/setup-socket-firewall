export const ORGANIZATION = "workos";
export const ACTION_REPOSITORY = "workos/setup-socket-firewall";
export const RELEASE_CHANNEL = "v1";
export const RELEASE_BRANCH = `action-release/${RELEASE_CHANNEL}`;
export const APPROVED_RELEASE_SHA = "ca93dd8aa351f54f4729fe3377a9be23c631c25d";

export const EXPECTED_RELEASE_TREE = Object.freeze([
  Object.freeze({ mode: "100644", path: "LICENSE", type: "blob" }),
  Object.freeze({ mode: "100644", path: "action.yml", type: "blob" }),
  Object.freeze({ mode: "040000", path: "scripts", type: "tree" }),
  Object.freeze({
    mode: "100755",
    path: "scripts/configure.sh",
    type: "blob",
  }),
  Object.freeze({
    mode: "100755",
    path: "scripts/teardown.sh",
    type: "blob",
  }),
  Object.freeze({ mode: "040000", path: "teardown", type: "tree" }),
  Object.freeze({
    mode: "100644",
    path: "teardown/action.yml",
    type: "blob",
  }),
]);
