# Editable motion example

`project.json` is an authored schema 1 project based on the application's built-in sample. It contains editable text, basic shapes and keyframes, with no third-party video or external assets.

Import it in the web editor, or render it after installing the dependencies:

```sh
npm run workflow -- render \
  --project examples/editable-motion/project.json \
  --out-dir artifacts/example-render --width 960
```

The renderer writes standalone HTML and a silent MP4 preview. Use a fresh output directory or add `--overwrite` intentionally.

This demonstrates the editable project format. It is not an automatic reconstruction benchmark. For synthetic source-video analysis checks, see [the fixture workflow](../../docs/scripts.md#외부-영상-없이-검증하기).
