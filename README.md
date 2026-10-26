# TetraFi developer docs

The public developer site for TetraFi, built with [Mintlify](https://mintlify.com). Pages are MDX with YAML frontmatter, and `docs.json` holds the navigation, redirects and theme.

## How it deploys

- **This repository is public** (`github.com/tetrafi/docs`). Every push, including a branch push, publishes its content to the world. Run the leak gate before any push.
- The Mintlify GitHub app deploys the default branch, `main`, to [tetrafi.mintlify.app](https://tetrafi.mintlify.app). Each deploy appears as a `mintlify[bot]` deployment of ref `main` (`gh api repos/tetrafi/docs/deployments`).
- Work happens on a branch (today `docs-publish`), opens a pull request into `main`, and is squash-merged. The merge is the release.
- There are no pull-request preview deployments.

## Checks before a push

```
npm run leaks     # internal ids, internal hosts, retired API surfaces, credential-shaped strings
npm run check     # snippets match their runnable sources, then mint validate and broken links
```

- `npm run leaks` (`scripts/leak-gate.mjs`) scans every file a push would carry. A hit is a line to fix, never a line to allow.
- Field names that are internal today are allowed only while the public API spec still contains them.

## Code samples

Every request sample on the site comes from a runnable source:

- `samples/http/*.sh` holds the curl samples, owned by this repository.
- `tetrafi-ui/packages/sdk/examples/*.ts` holds the TypeScript SDK samples, read from the sibling checkout.

A region `# region <name>` … `# endregion` (shell) or `// #region <name>` … `// #endregion` (TypeScript) becomes `snippets/samples/<name>.mdx` through `npm run sync`. Pages import that snippet and hold no inline request samples.

A live test runs every source against a TetraFi environment and fails when:
- a page holds an unsourced sample;
- a snippet has drifted from its source;
- a sample exits non-zero.

## Retiring a page

Never delete a page:
1. Move it with `mv` into `.archive/<same path>`. `.archive/` is gitignored, so the file stays local and is never published.
2. Commit the removal.
3. Add a `redirects` entry in `docs.json` from the old URL to its replacement.
4. Remove it from the navigation.

## Previewing locally

Use the Mintlify CLI, pinned in `package.json`:

- `npm run validate` and `npm run broken-links` are static checks.
- `npm run dev` starts a local preview server. Use it only where local servers are allowed.
