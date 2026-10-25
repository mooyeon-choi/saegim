# Contributing to Saegim

Saegim reconstructs local motion graphics as editable vectors. Useful contributions include reproducible analysis fixes, editor improvements, comparison tools, documentation and synthetic test cases.

## Run locally

Follow the [quick start](README.md#quick-start). Use Node.js 22 for the same major version as CI. Python 3.10 or newer is required; CI uses 3.12. The current editor interface is primarily Korean.

Read [AGENTS.md](AGENTS.md), [architecture](docs/architecture.md) and [script contracts](docs/scripts.md) before changing data formats or workflows. App schema 1/2, object-scene-v1 and the parametric experiments are separate formats.

## Make a change

Keep the change focused on a reproducible problem. Preserve editable text, IDs, layer order, clipping, gradients, cuts and time modes. Avoid adding a particular video's palette, coordinates or object names to production code. Put input media and local research in ignored `artifacts/` or `.data/` directories.

AI-assisted contributions are welcome. Review generated changes, describe what they do and report checks you actually ran. Explain any remaining uncertainty instead of presenting a rendered frame count as reconstruction accuracy.

Use small synthetic fixtures whenever possible. Share real media only when you have permission, and remove personal paths and private content from logs. A standalone SVG/JSON reproduction is often easier to review than a large video.

## Validate

Run checks relevant to the change, plus the build:

```sh
npm test -- --maxWorkers=1
.venv/bin/python -m pytest tests/backend
npm run build
```

For editor/export changes, run the relevant files with `npx playwright test tests/e2e/<file>.spec.ts`. For workflow or element export changes, use `npm run test:workflow` and `npm run test:elements`. Windows uses `.venv/Scripts/python.exe`.

For public-source changes, run `npm run release:check` and `npm run release:package`, then inspect the ZIP. New reusable scripts need a `.gitignore` allow-list entry, a `scripts/catalog.json` entry and documentation. Packaging never commits or publishes files.

In a pull request, explain the observable change, the checks and results, and any limits. For visual changes include aligned source/baseline/current crops or overlays, identifying the exact frames reviewed. Do not attach private research artifacts by default.
