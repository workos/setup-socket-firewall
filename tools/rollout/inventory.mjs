function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sorted(values) {
  return [...values].sort(compareStrings);
}

function indexRepositories(repositories, source) {
  assert(Array.isArray(repositories), `${source} inventory is not an array`);
  const indexed = new Map();

  for (const repository of repositories) {
    assert(
      repository && typeof repository.name === "string" && repository.name,
      `${source} inventory contains a repository without a name`,
    );
    assert(
      !indexed.has(repository.name),
      `${source} inventory contains duplicate repository ${repository.name}`,
    );
    const archived =
      source === "REST" ? repository.archived : repository.isArchived;
    assert(
      typeof archived === "boolean",
      `${source} repository ${repository.name} has invalid archived state`,
    );
    indexed.set(repository.name, repository);
  }

  return indexed;
}

function difference(left, right) {
  return sorted([...left].filter((name) => !right.has(name)));
}

function normalizedVisibility(repository, source) {
  const visibility = String(repository.visibility ?? "").toLowerCase();
  assert(
    ["internal", "private", "public"].includes(visibility),
    `${source} repository ${repository.name} has invalid visibility`,
  );
  return visibility;
}

export function reconcileRepositoryInventories(
  restRepositories,
  graphqlRepositories,
) {
  const rest = indexRepositories(restRepositories, "REST");
  const graphql = indexRepositories(graphqlRepositories, "GraphQL");
  const restNames = new Set(rest.keys());
  const graphqlNames = new Set(graphql.keys());
  const restActive = new Set(
    [...rest]
      .filter(([, repository]) => repository.archived === false)
      .map(([name]) => name),
  );
  const graphqlActive = new Set(
    [...graphql]
      .filter(([, repository]) => repository.isArchived === false)
      .map(([name]) => name),
  );

  const visibilityMismatches = sorted(restNames)
    .filter((name) => graphql.has(name))
    .filter(
      (name) =>
        normalizedVisibility(rest.get(name), "REST") !==
        normalizedVisibility(graphql.get(name), "GraphQL"),
    );
  const differences = {
    activeOnlyGraphql: difference(graphqlActive, restActive),
    activeOnlyRest: difference(restActive, graphqlActive),
    allOnlyGraphql: difference(graphqlNames, restNames),
    allOnlyRest: difference(restNames, graphqlNames),
    visibilityMismatches,
  };
  const mismatchCount = Object.values(differences).reduce(
    (total, names) => total + names.length,
    0,
  );
  assert(
    mismatchCount === 0,
    `REST and GraphQL repository inventories differ: ${JSON.stringify(differences)}`,
  );

  const repositories = sorted(restActive).map((name) => {
    const repository = rest.get(name);
    assert(
      typeof repository.default_branch === "string" &&
        repository.default_branch,
      `active REST repository ${name} has no default branch`,
    );
    return {
      defaultBranch: repository.default_branch,
      name,
      visibility: normalizedVisibility(repository, "REST"),
    };
  });

  const visibility = { internal: 0, private: 0, public: 0 };
  for (const repository of repositories) {
    visibility[repository.visibility] += 1;
  }

  return {
    activeCount: repositories.length,
    archivedCount: rest.size - repositories.length,
    differences,
    repositories,
    schemaVersion: 1,
    totalCount: rest.size,
    visibility,
  };
}

export async function captureRepositoryInventory(client, organization) {
  const [restRepositories, graphqlRepositories] = await Promise.all([
    client.listRestRepositories(organization),
    client.listGraphqlRepositories(organization),
  ]);
  return reconcileRepositoryInventories(restRepositories, graphqlRepositories);
}
