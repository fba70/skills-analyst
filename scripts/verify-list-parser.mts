import "dotenv/config";

import { parseListMarkdown, repoFromUrl } from "../src/server/connectors/awesome-list";

/**
 * Checks the curated-list parser against the cases that actually bite.
 *
 *   pnpm verify:lists
 *
 * Same shape as `verify-analyzers.mts`: no test framework in this repo, so a verification
 * script that exits non-zero is the regression guard.
 *
 * Every case here is a real failure mode of an awesome list, not a hypothetical. Lists are
 * mostly shields.io badges pointing at the list's own repo; they link into subdirectories
 * of the repo they mean; and `github.com/sponsors/<user>` parses as a perfectly plausible
 * `sponsors/<user>` repository unless something stops it. Getting any of these wrong turns
 * a discovery pass into hundreds of junk candidates that a curator then has to reject one
 * at a time.
 */

const cases: Array<[string, string | null]> = [
  ["https://github.com/owner/repo", "owner/repo"],
  ["https://github.com/owner/repo/tree/main/skills/foo", "owner/repo"],
  ["https://www.github.com/owner/repo.git", "owner/repo"],
  ["https://github.com/sponsors/someone", null],
  ["https://github.com/orgs/acme/repositories", null],
  ["https://github.com/topics/claude", null],
  ["https://github.com/owner", null],
  ["https://gitlab.com/owner/repo", null],
  ["https://img.shields.io/badge/x", null],
];
let bad = 0;
for (const [input, expected] of cases) {
  const got = repoFromUrl(input);
  const actual = got ? `${got.owner}/${got.repo}` : null;
  const ok = actual === expected;
  if (!ok) bad += 1;
  console.info(`${ok ? "PASS" : "FAIL"}  ${input.padEnd(52)} -> ${actual} (expected ${expected})`);
}

const md = `# Awesome
[![badge](https://img.shields.io/x)](https://github.com/me/mylist)
## Vendors
- [Anthropic](https://github.com/anthropics/skills) — official
- [dup](https://github.com/anthropics/skills) — same repo again
## Community
- [gstack](https://github.com/garrytan/gstack)
\`\`\`
git clone https://github.com/should/beignored
\`\`\`
`;
const parsed = parseListMarkdown(md, { selfRepo: { owner: "me", repo: "mylist" } });
console.info("\ncandidates:", parsed.candidates.map((c) => `${c.owner}/${c.repo}@${c.section}`));
const ids = parsed.candidates.map((c) => `${c.owner}/${c.repo}`);
const expect = ["anthropics/skills", "garrytan/gstack"];
const listOk = JSON.stringify(ids) === JSON.stringify(expect);
console.info(listOk ? "PASS  list parse" : `FAIL  list parse: got ${JSON.stringify(ids)}`);
if (!listOk) bad += 1;
process.exit(bad > 0 ? 1 : 0);
