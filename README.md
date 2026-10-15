# VeilForge Lua Obfuscator (Netlify)

## Deploy
1. Upload this folder to a new GitHub repository.
2. In Netlify, choose **Add new project → Import an existing project** and select the repository.
3. Build command: leave empty. Publish directory: `public`. Functions directory: `netlify/functions` (configured in netlify.toml).
4. Deploy. The frontend calls `/api/obfuscate`, redirected to the Netlify Function.

For local development, install Netlify CLI (`npm install -g netlify-cli`) and run `netlify dev` from the project root.

## What this version does
- Lua-aware tokenization, strips comments and nonessential whitespace.
- Encodes short ASCII quoted strings using `string.char` expressions.
- Encodes ordinary nonnegative integer literals as hex.
- Offers upload, copy, download, basic stats and 250 KB upload limit.
- Does not execute user-provided Lua code.

## Limitations / important warnings
- **This is a starter engine, NOT MoonVeil-equivalent.** No VM virtualization, opaque predicates, anti-tamper, control-flow flattening or reliable scope-aware variable renaming.
- No complete Lua parser or semantic equivalence proof. In particular, Lua dialect extensions, nonstandard escapes, `--` comment adjacency, unusual numeric literal syntax, and Lua 5.1/5.2/5.3/5.4 differences need regression tests. Run representative source/output pairs before using it in production.
- String encoding uses global `string.char`: scripts that shadow or redefine `string` may behave differently. Disable string encoding for such scripts.
- Uploaded code is sent to the Netlify Function; do not use for secrets without reviewing your deployment and logging policies.
- Do not claim this is cryptographically secure or impossible to deobfuscate.

## Production roadmap
A real Lua AST and scope analysis, semantics-preserving symbol renaming, constant pooling, robust compatibility tests for each target runtime, optional VM-based transformation, per-build randomized transformations, and a backend job queue for larger workloads.
