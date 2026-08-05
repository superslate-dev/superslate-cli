# superslate

Create a buyer-owned, production-oriented SaaS application from a licensed superslate release.

```sh
pnpm dlx superslate@latest my-saas
```

The same package works with Bun:

```sh
bunx superslate@latest my-saas
```

It can also be launched through npm with `npx superslate@latest my-saas`. The launcher does not
change the generated toolchain: superslate always installs the canonical `pnpm-lock.yaml` with pnpm.
This keeps local development, CI, upgrades, and support on one reproducible package-manager path.

The CLI guides you through the application name, brand, dependency installation, Git initialization,
and whether to start local development immediately. It derives the internal workspace namespace from
the brand, generates a unique Better Auth secret locally, selects an available local Postgres port,
and refuses to overwrite a non-empty directory. The namespace groups private monorepo packages and
does not need to exist on npm.

## Source access

The npm package is a public bootstrapper; it does not contain the paid foundation source. Your
purchase receipt carries a licence key, and that key is the only thing you need. Node is the only
prerequisite — there is no GitHub account, no CLI to install, and no token to paste.

The CLI prompts for the key, or takes it from `--license-key` or `SUPERSLATE_LICENSE_KEY`. It
exchanges the key for the newest release your licence entitles you to, downloads that release's
archive, SHA-256 file, and manifest, and verifies both records before extracting source. Pass
`--source-version 1.2.3` to reproduce a specific release instead.

Your key is sent in a request body and an `Authorization` header, never in a URL, and it is never
written to a log. A refunded licence stops downloading immediately.

Your purchase also includes read access to the private source repository, for browsing source,
watching releases, and opening issues. Connect GitHub in the customer portal to accept it. It is a
perk, not part of the download path.

## Verifying the bootstrapper

The bootstrapper drives `git`, `tar`, and `docker` on your machine, so it is auditable before you
run it. Its source is public at
[superslate-dev/superslate-cli](https://github.com/superslate-dev/superslate-cli), it declares no
runtime dependencies, and every release is built and published from CI with npm provenance linking
the tarball to the commit and workflow that produced it:

```sh
npm view superslate dist.attestations
```

## Licensing

The bootstrapper is MIT licensed. The MIT grant covers this npm package and the source it is built
from; it does not cover the superslate Product Source, which the package does not contain. Product
Source is delivered through an authorized entitlement under the Source Product Commercial License
supplied with your order.

## Options

```text
--license-key <key> Licence key from your purchase (or set SUPERSLATE_LICENSE_KEY)
--source-version <version> Pin an immutable release instead of taking the newest one
--scope <namespace> Advanced override for the workspace namespace derived from the brand
--brand <name>     Override the display name derived from the app name
--no-install       Generate without installing dependencies
--no-git           Generate without initializing Git
--start            Start Postgres and the development servers after creation
--no-start         Create the application without starting it
--yes              Accept all recommended defaults
--from <path>      Use a local source checkout for maintainer or pre-release testing
```

When automatic startup is selected, Ctrl+C stops the application development servers. The detached
Postgres container remains available for the next run; stop it later with `docker compose down` from
the generated directory.

For reproducible automation, select an exact CLI version instead of `latest`:

```sh
pnpm dlx superslate@1.2.3 my-saas --yes --no-start
```

Product information: [superslate.dev](https://superslate.dev)
