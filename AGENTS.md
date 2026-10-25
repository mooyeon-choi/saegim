# Repository guidance

This repository reconstructs local 2D motion graphics as editable HTML/SVG. Keep the general application usable without any particular reference video.

- Read README.md and docs/scripts.md before changing the workflow. Use the repository skill in .agents/skills/motion-graphics-reconstruction when handling reconstruction tasks.
- Derive dimensions, duration, sample times and shot boundaries from inputs. Keep source titles, palettes, object identities, masks and manual corrections out of production code.
- Preserve edited text as real text, stable IDs, z-order, clipping, gradients and time semantics. Do not interpolate across real cuts or hide incompatible geometry by blending whole frames.
- App schema 1/2, object-scene-v1 and the parametric experiment schema are distinct. Validate their inputs and do not claim they are interchangeable.
- Keep uploaded media, generated output and experiment notes in ignored folders. Do not delete local research artifacts merely because they are excluded from publication.
- New reusable scripts need a .gitignore allow-list entry and scripts/catalog.json entry. Avoid absolute user-home paths and external keys.
- Use npm test -- --maxWorkers=1 for engine changes, Python pytest tests/backend for API changes, and relevant Playwright tests for editor/export changes. Run npm run build before handing off source changes.
- For publication preparation run npm run release:check and npm run release:package. Review actual package contents; these commands must not stage, commit, create remotes or upload.
- Report measured checks and observed defects honestly. Output FPS is not reconstruction accuracy. Do not claim full visual review after only sampling frames.
