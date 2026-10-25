# Third-party notices

## Bundled fonts

The following fonts carry SIL Open Font License 1.1 notices. Keep those notices with redistributed font files.

| Files | Attribution and license |
| --- | --- |
| `public/fonts/BodoniModa.ttf`, `public/fonts/BodoniModa-Display.ttf` | Copyright 2020 The Bodoni Moda Project Authors. [Project named in the notice](https://github.com/indestructible-type/Bodoni). [Included OFL text](public/fonts/OFL-BodoniModa.txt). The Display file is a derived font instance. |
| `public/fonts/DMSerifDisplay-Regular.ttf` | Copyright 2014–2018 Adobe; Copyright 2019 Google LLC. The notice reserves the font name “Source”. [Included OFL text](public/fonts/OFL-DMSerifDisplay.txt). |

## Dependencies

JavaScript dependencies and versions are recorded in `package.json` and `package-lock.json`; Python requirements are in `requirements.txt`. Dependencies retain their own license terms. Installed packages and downloaded browser/FFmpeg binaries are not included in the source ZIP.

## Input and output media

The public source package excludes user-uploaded videos and private case-specific masks, observations and renders. The basic shape GIFs (`conversion.gif`, `title-edit.gif`, `color-edit.gif`) in `docs/assets/` and projects in `examples/reconstruction-demo/` use the repository's independently drawn synthetic fixture. They are documentation examples distributed under this project's MIT license; see [their provenance](examples/reconstruction-demo/README.md). They contain no third-party source video or embedded font binaries.

The separate `character-*.gif` documentation assets and `examples/character-gradient/` use a character video generated specifically for this demonstration with Higgsfield / Seedance 2.5, without reference media. A title was composited before local analysis. These are AI-derived media examples, not the independently drawn fixture or a third-party reference film. [Generation details and transformations](examples/character-gradient/README.md) accompany the assets. No font binaries or service credentials are embedded in these examples.

The `rich-*.gif` assets and `examples/rich-motion/` use a separate Higgsfield / Seedance 2.5 film made with three original Dream Stage styleframes from earlier work as references. It is a stylized 2.5D AI-derived example. The complete prepared source is included; the editable JSON examples cover its final two seconds. No third-party reference film is included. [Source preparation and verification](examples/rich-motion/README.md).

Saegim's original project source is distributed under the [MIT License](LICENSE). Bundled fonts and dependencies retain the separate licenses noted above.
