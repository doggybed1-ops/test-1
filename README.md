# VEIL Lua compiler workbench

A working AST-based obfuscator with two compiler backends, a Monaco workbench, a bounded Node processing service, and a Netlify frontend/proxy configuration.

**Release status: engineering preview, not a certified commercial protection product.** The compiler performs real transformations and executes regression-tested protected programs. No comparison with MoonVeil, LuaArmor, or LuaProt has been performed. Full Luau syntax, every version-specific Lua feature, a security audit, adversarial reverse-engineering evaluation, and broad real-world Roblox validation remain release work. This project does not claim the user's entire commercial-competitor acceptance criterion has been established.

## Run

Requires Node.js 22 or later. From this directory:

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:5173. The Vite frontend proxies `/api` to the processing service on port 8787. Source remains in the current editor session; the application does not use browser storage for scripts.

```sh
npm test
npm run test:compat
npm run test:scale
npm run build
npm run obfuscate -- examples/counter.lua counter.protected.lua --profile maximum --dialect lua51
```

The CLI refuses to overwrite an existing output file or the input file. `--seed` is available for reproducible debugging; normal builds use a fresh 256-bit seed. The HTTP API rejects user-supplied seeds.

## Implemented protection

| Layer | Standard | Advanced | Maximum |
|---|---|---|---|
| Parse source into a located AST; validate generated syntax | Yes | Yes | Yes |
| Resolve lexical bindings, including parameters and captured locals | Renamed source | Renamed source | Compiled lexical cells |
| Per-literal byte protection with randomized keys and pool positions | Two encodings | Two encodings | Three encodings |
| Preserve exact numeric tokens and protect their retrieval | Shuffled pools, exact safe integer expressions | Same | Encrypted numeric tokens decoded by the host runtime |
| Property indirection | — | Eligible AST property accesses | Compiled table instructions |
| Randomized state machines and CFG lowering | — | Eligible lexical regions | Entire supported program |
| Opaque predicates and unreachable states | — | Eligible state machines | State predicates |
| Custom register VM | — | — | Yes |
| Fresh opcode identifiers and shuffled instruction states | — | — | Yes |
| Masked instruction operands and capture metadata | — | — | Yes |
| Nested prototypes, shared upvalues, counted multireturns, varargs | Native Lua | Native Lua | VM implementation |
| Tail-return calls | Native Lua | Native Lua | Native tail dispatch |

Maximum compiles AST expressions/statements into custom instructions. Its output contains an interpreter and protected program data, not a `loadstring` wrapper around encoded source. The interpreter uses virtual registers, packed argument/return lists, lexical cells, independent invocation frames, and indirect calls. Numeric-for counter advancement uses a private native coroutine to preserve each runtime's coercion and overflow behavior; its loop body runs in the VM.

The source backend uses AST ranges and lexical scope resolution. It retains syntax whose movement could change scope, lowers eligible regions into a CFG, and reports actual applied passes plus skipped-region warnings. Maximum is a separate lowering backend combining those protection goals in its instruction representation; it does not first run the source emitter. Helpers capture required builtins before user statements run.

All VM instructions share the build's randomized opcode mapping; instruction states, pool positions, keys, helper names, and operand masks also change. Encodings are reversible obfuscation, not secret-key cryptographic confidentiality: the decoder must be distributed with the program.

Function inlining/outlining, general-purpose instruction scheduling, anti-debug hooks, anti-tamper guarantees, and full Luau parsing are **not implemented or advertised as available settings**.

## Compatibility contract

The baseline is documented Lua 5.1 syntax. Lua 5.2, 5.3, 5.4, and Luau profiles accept their supported common subset. These profiles are explicit compatibility restrictions, not full language implementations.

Implemented programs can use nested/recursive functions, transitive shared upvalues, if/elseif, while/repeat, numeric and generic for, break, do blocks, tables, ordinary metatable operations, method calls, varargs, multiple returns with nil holes, module-style returns, and native coroutine suspension. Luau assignment ordering is handled separately. Unicode input is converted to UTF-8 bytes before string parsing so binary escapes and Unicode text retain their Lua bytestring values.

Rejected features include:

- Luau type annotations, type aliases, `continue`, compound assignments, interpolated strings, and other Luau extensions.
- Lua `goto`/labels, bitwise operators and integer division, Lua 5.4 variable attributes, lexical `_ENV`, and `module()` environment rewriting.
- Debug/stack/environment introspection and `getfenv`/`setfenv` references. Dynamic aliases and external host reflection cannot be reliably detected; programs depending on those mechanisms are outside the contract.
- Direct `string.dump` reflection; legacy Lua 5.1 `arg` references inside variadic functions. Use explicit `...` and `select` instead. The conservative legacy check also rejects locally shadowed `arg` names inside those functions.
- Maximum: explicit `collectgarbage`, recognized weak metatable modes (`__mode`), and closing-value metatables (`__close`). VM cells/registers retain references beyond native lexical lifetimes. Lua 5.4 generic-for fourth closing values and dynamically supplied weak/finalizer behavior are outside the supported contract.
- Maximum Luau: generalized table/`__iter` iteration. Use `pairs`, `ipairs`, or function iterators. Direct table iterators are rejected at compilation; dynamically supplied non-function iterators produce an explicit unsupported-iteration runtime error. Source profiles retain native Luau generalized iteration.
- Hexadecimal floating-point literals in Maximum. Source profiles preserve their exact spelling where parsed.
- A source-profile chunk too close to the native active-local limit to safely introduce helpers and preserve top-level varargs.

String-protecting source profiles require string.char and table.concat. Maximum requires standard base, string, table, and coroutine libraries. Protected functions change debug-visible structure, stack traces, source locations, and execution cost. Exact allocation/GC timing, iteration ordering of hash tables, dumped function bytecode, stack reflection, and runtime error location strings are outside the equivalence contract. Source directives/comments are retained by source profiles; Maximum emits new source and does not retain original Luau compiler directives.

Lua 5.2 has parser/profile validation but has not been executed against a dedicated 5.2 runtime here. Roblox engine APIs must be supplied by the Roblox host; Luau WASM regression tests do not establish compatibility with every Roblox API or executor.

## Tests and evidence

`tests/fixtures.js` provides independent semantic cases, executed in fresh bounded test workers. The harness compares typed returned values and captured print output, detects uncaught errors, and removes filesystem/package/process libraries. Production compilation never imports this execution harness or executes submitted source.

`npm test` covers differential semantics, independent source/VM passes, randomization, binary strings, exact numeric tokens, tail recursion, local limits, unsupported syntax, API authentication/rate limits, worker cancellation, and queue deadlines. `npm run test:compat` saves every attempted profile/runtime comparison in [reports/compatibility.json](reports/compatibility.json). Default portable test runtimes are actual Lua 5.1 via WASM, Fengari's Lua 5.3 implementation, and Luau WASM. If `lua -v` identifies Lua 5.4, that native runtime is included too; set `LUA54_BIN` for a custom path.

The test runner explicitly selects Luau Web 1.4.0's bundled Asyncify runtime and probes protected calls. Its JSPI build on Node 24 allowed exceptions to escape `pcall`; the test configuration avoids that runtime fault without patching production code or suppressing failed cases. Test libraries are development dependencies only.

[reports/protection-analysis.json](reports/protection-analysis.json) records actual VM counts, randomized-build differences, plaintext-literal checks, and timings for the supplied example. These are implementation evidence, not a quantified resistance-to-reversal score. The test corpus is finite and does not prove all accepted programs equivalent.

The frontend production build passes. Browser interaction/visual QA could not complete in this session because the browser could not reach local servers in the execution sandbox; no screenshot or successful browser test is claimed. `scripts/ui-smoke.js` is supplied for a machine with an accessible local preview and Microsoft Edge (or a configured Playwright channel).

## Architecture and source privacy

The saved [scalability test](reports/scalability.json) compiled and executed a 149,026-byte program with 10,000 assignment statements in actual Lua 5.1. Its 90,014 VM instructions produced about 5 MiB of output and compiled in approximately 715 ms in the bounded worker on this machine. Large data tables are split into factories to respect Lua 5.1's per-function constant limits. This is one measured stress case, not a guarantee for every program at the upload limit.

```text
Browser (Netlify static assets, bundled Monaco)
  → Netlify /api/* function (server-side processor token)
    → Node processing service
      → fresh bounded worker → parse → lower/transform → emit → parse validation
```

The service accepts UTF-8 JSON and uses memory only. Workers are terminated after each job, including failures, cancellation, and timeout. Queue entries are discarded on cancellation/deadline. The app creates no request-source files or source/output database. JavaScript garbage collection is not secure memory erasure. Hosting/platform logging and retention are controlled separately by the operator.

Default bounds: 512 KiB source, 4 MiB transport, 120,000 AST nodes, 16 MiB generated output, 15 seconds from queue admission through completion, at most two workers, eight queued jobs, and 192 MiB old-generation heap per worker. Worker limits bound JS heap, not total process RSS; set container memory/CPU limits as well. Parsing and transformations are within the worker. Logs include request IDs, error codes, profile, sizes, and timings; they exclude source, output, diagnostic excerpts, tokens, and client identifiers.

The service rate-limits compilation to 20 requests per minute per client key by default. An authenticated Netlify proxy supplies an HMAC of its client IP; direct callers use their socket IP. The limiter is process-local. Use one service instance, or put a shared rate limiter/API gateway ahead of replicas. Do not represent the in-memory limiter as a distributed global quota.

## Deploy to Netlify plus a processing host

See [DEPLOYMENT.md](DEPLOYMENT.md) for exact deployment and environment instructions. Deployment credentials and a target processing URL were not provided, so this deliverable has not been published. The included Netlify function returns a clear `PROCESSOR_NOT_CONFIGURED` error until its backend is configured; it never fabricates protected output.

## API

`GET /api/capabilities` returns the implemented profiles, dialect limits, and features.

`POST /api/obfuscate`:

```json
{
  "source": "local value = 42; return value",
  "profile": "maximum",
  "dialect": "lua51",
  "options": {
    "rename": true,
    "stringProtection": true,
    "constantProtection": true,
    "controlFlow": true,
    "opaquePredicates": true,
    "lazyStrings": true
  }
}
```

Responses contain `code`, `buildId`, actual `passes`, measured `stats`, `warnings`, and `compatibility.syntaxValidated: true`. `executionValidated` is always false for public requests. Errors contain `error.code`, `error.message`, and one-based source line/column when available. Required VM protections cannot be disabled in Maximum. Standard rejects control-flow switches. Disabling every applicable pass produces `NO_TRANSFORMATIONS`, never a success containing the original script.
