import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

const execFile = promisify(execFileCallback);
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_PAGE_SIZE = 100;
const MAX_REPOSITORY_COUNT = 10_000;
const MAX_REPOSITORY_PAGES = MAX_REPOSITORY_COUNT / DEFAULT_PAGE_SIZE;

export function statusFromText(text) {
  const match = String(text).match(/\bHTTP ([0-9]{3})(?:\)|:)/);
  return match ? Number(match[1]) : undefined;
}

function retryAfterFromText(text) {
  const match = String(text).match(/retry-after:\s*([0-9]+)/i);
  return match ? Number(match[1]) * 1_000 : undefined;
}

function parseJson(stdout, description) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${description} returned invalid JSON: ${error.message}`);
  }
}

export class GhCommandError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "GhCommandError";
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.exitCode = options.exitCode;
  }
}

export async function executeGh(args) {
  try {
    return await execFile("gh", args, {
      encoding: "utf8",
      env: process.env,
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = String(error.stderr ?? "");
    const stdout = String(error.stdout ?? "");
    const status = statusFromText(stderr) ?? statusFromText(stdout);
    const retryAfterMs =
      retryAfterFromText(stderr) ?? retryAfterFromText(stdout);
    const detail =
      stderr.trim() || `gh exited with code ${error.code ?? "unknown"}`;
    throw new GhCommandError(detail, {
      cause: error,
      exitCode: error.code,
      retryAfterMs,
      status,
    });
  }
}

export class GitHubClient {
  constructor(options = {}) {
    this.execute = options.execute ?? executeGh;
    this.sleep = options.sleep ?? sleep;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.defaultRetryDelayMs = options.defaultRetryDelayMs ?? 1_000;
    this.transientRetryDelayMs = options.transientRetryDelayMs ?? 5_000;

    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new Error("maxAttempts must be a positive integer");
    }
  }

  async run(args, description) {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await this.execute(args);
      } catch (error) {
        const rateLimited403 =
          error.status === 403 &&
          (error.retryAfterMs !== undefined ||
            /rate.?limit/i.test(error.message));
        const transientNetwork =
          error.status === undefined &&
          /timeout|timed out|connection re|unexpected EOF|temporary failure/i.test(
            error.message,
          );
        const retryable =
          error.status === 429 || rateLimited403 || transientNetwork;
        if (!retryable || attempt === this.maxAttempts) {
          throw new Error(`${description} failed: ${error.message}`, {
            cause: error,
          });
        }

        const baseDelayMs = transientNetwork
          ? this.transientRetryDelayMs
          : this.defaultRetryDelayMs;
        const delay =
          error.retryAfterMs ?? baseDelayMs * 2 ** Math.max(0, attempt - 1);
        await this.sleep(delay);
      }
    }

    throw new Error(`${description} failed without an attempt`);
  }

  async api(endpoint, description = `GitHub API ${endpoint}`) {
    const { stdout } = await this.run(
      ["api", "--method", "GET", endpoint],
      description,
    );
    return parseJson(stdout, description);
  }

  async getRef(repository, ref) {
    return this.api(
      `repos/${repository}/git/ref/${ref}`,
      `read ${repository} ref ${ref}`,
    );
  }

  async getCommit(repository, sha) {
    return this.api(
      `repos/${repository}/git/commits/${sha}`,
      `read ${repository} commit ${sha}`,
    );
  }

  async getTree(repository, sha, recursive = false) {
    const suffix = recursive ? "?recursive=1" : "";
    return this.api(
      `repos/${repository}/git/trees/${sha}${suffix}`,
      `read ${repository} tree ${sha}`,
    );
  }

  async getText(repository, path, ref) {
    const response = await this.api(
      `repos/${repository}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
      `read ${repository}/${path} at ${ref}`,
    );
    const content =
      typeof response?.content === "string"
        ? response.content.replaceAll("\n", "")
        : undefined;
    if (
      response?.type !== "file" ||
      response.encoding !== "base64" ||
      content === undefined ||
      !Number.isSafeInteger(response.size) ||
      response.size < 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        content,
      )
    ) {
      throw new Error(
        `${repository}/${path} at ${ref} is not a complete base64 GitHub file response`,
      );
    }
    const bytes = Buffer.from(content, "base64");
    if (
      bytes.length !== response.size ||
      bytes.toString("base64") !== content
    ) {
      throw new Error(
        `${repository}/${path} at ${ref} has incomplete or malformed content`,
      );
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }

  async listRestRepositories(organization) {
    const repositories = [];

    for (let page = 1; page <= MAX_REPOSITORY_PAGES + 1; page += 1) {
      const response = await this.api(
        `orgs/${organization}/repos?type=all&per_page=${DEFAULT_PAGE_SIZE}&page=${page}`,
        `list ${organization} repositories via REST page ${page}`,
      );
      if (!Array.isArray(response)) {
        throw new Error(`REST repository page ${page} is not an array`);
      }
      if (page === MAX_REPOSITORY_PAGES + 1) {
        if (response.length > 0) {
          throw new Error(
            `REST repository inventory exceeded ${MAX_REPOSITORY_COUNT} entries`,
          );
        }
        return repositories;
      }
      repositories.push(...response);
      if (response.length < DEFAULT_PAGE_SIZE) {
        return repositories;
      }
    }

    throw new Error("REST repository pagination ended unexpectedly");
  }

  async listGraphqlRepositories(organization) {
    const description = `list ${organization} repositories via GraphQL`;
    const { stdout } = await this.run(
      [
        "repo",
        "list",
        organization,
        "--limit",
        String(MAX_REPOSITORY_COUNT),
        "--json",
        "name,isArchived,visibility",
      ],
      description,
    );
    const response = parseJson(stdout, description);
    if (!Array.isArray(response)) {
      throw new Error("GraphQL repository inventory is not an array");
    }
    if (response.length === MAX_REPOSITORY_COUNT) {
      throw new Error(
        `GraphQL repository inventory reached its ${MAX_REPOSITORY_COUNT}-entry limit and may be truncated`,
      );
    }
    return response;
  }
}
