export const ORGANIZATION = "workos";
export const ACTION_REPOSITORY = "workos/setup-socket-firewall";
export const RELEASE_CHANNEL = "v1";
export const RELEASE_BRANCH = `action-release/${RELEASE_CHANNEL}`;
export const APPROVED_RELEASE_SHA = "ca93dd8aa351f54f4729fe3377a9be23c631c25d";

// Runtime blobs read from the immutable approved release, not mutable discovery refs.
export const APPROVED_RUNTIME_BLOBS = Object.freeze({
  "action.yml": "156de46f25b2facc56cd7a5b2ea9e78b3de4ea1d",
  "scripts/configure.sh": "155d6aab883d58211a4bb3fbfa70b27a2d96dae2",
  "scripts/teardown.sh": "a1ddc2f06a65c607f2af2ae0395bada78e236913",
  "teardown/action.yml": "d47a0abeaaa0d6717e5ce9cdbc45c3356ea3726c",
});

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
