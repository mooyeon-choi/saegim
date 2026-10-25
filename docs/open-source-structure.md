# Open-source structure references

Reviewed on 2026-10-25. These projects informed documentation and repository layout; no implementation was copied as part of publication preparation.

| Reference | Observed pattern | Saegim decision |
| --- | --- | --- |
| [REA](https://github.com/morluto/rea) | Agent skills alongside source, docs, tests, examples and contribution guidance | Make skills visible; document setup, actual validation and limits |
| [fframes](https://github.com/dmtrKovalenko/fframes) | Video tooling, skills and examples; inspection and final rendering are separate concerns | Document editable projects, previews and source comparison as distinct steps |
| [Continue](https://github.com/continuedev/continue) | Component boundaries and contribution/security documentation | Explain editor, engine and analysis boundaries and provide contributor entry points |

Saegim remains one repository: editor, renderer, analysis API and CLI share schemas and validation. Splitting them into published packages would add versioning work without an established independent API contract.

The public package contains source, skills, tests, documentation, licenses, an authored synthetic example and deliberately reviewed reconstruction/edit examples for the README, including a separately documented AI-generated character source. User uploads, private experiments, unselected generated projects and per-video corrections remain excluded. Local research artifacts remain on disk.

Source checking and packaging only inspect and package files. Git commits, remote creation and uploading are separate actions. Historical `FRAMEFORM_*` variables and local storage identifiers remain compatible while the public name is Saegim.
