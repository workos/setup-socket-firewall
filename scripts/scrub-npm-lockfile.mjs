import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const firewall = 'https://socket-firewall.workos.dev/';
const registry = 'https://registry.npmjs.org/';

export function scrubNpmLockfile(source) {
  const lock = JSON.parse(source);
  if (!lock || Array.isArray(lock) || ![1, 2, 3].includes(lock.lockfileVersion)) {
    throw new Error('expected an npm lockfile with lockfileVersion 1, 2, or 3');
  }

  // Match whole JSON tokens, not substrings inside strings. JSON.parse above
  // validates the grammar; retaining the original text avoids formatting churn.
  const tokens = /"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g;
  let previous;
  let beforePrevious;
  return source.replace(tokens, (token) => {
    let replacement = token;
    if (token.startsWith('"') && previous === ':' && beforePrevious?.startsWith('"')) {
      const key = JSON.parse(beforePrevious);
      const value = JSON.parse(token);
      if (key === 'resolved' && value.startsWith(firewall)) {
        replacement = JSON.stringify(registry + value.slice(firewall.length));
      }
    }
    beforePrevious = previous;
    previous = token;
    return replacement;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(scrubNpmLockfile(readFileSync(process.argv[2], 'utf8')));
  } catch {
    // Do not echo parser errors: they can include lockfile URLs or credentials.
    console.error('npm lockfile scrub failed: expected valid JSON and lockfileVersion 1, 2, or 3');
    process.exitCode = 1;
  }
}
