# Skill installation scope and case requirements

Two sets serve different purposes:

- The Skill's explicit `allowed-tools` declaration fixes its installation needs.
- Each case's `requiredTools` states which tools that case expects to exercise.

Selecting one case must not silently shrink an atomic capability Pack or change
the method's installed dependencies. Both Launcher paths now retain the explicit
method declaration while preserving the original case assertions. Builder still
checks admitted tools, Pack completeness, Runtime support, permission boundaries
and artifact identity. Declaring a tool never grants permission to execute it.

Case tools outside a declaration are rejected unless the selected Launcher
advertises them as auxiliary tools (for example its isolated case-file reader).
No tool is installed by scanning prose. Legacy non-declarative adapters keep their
existing case-derived contract; managed Harness admission still requires explicit
declarations. Duplicate, wildcard, null and ambiguous declarations are invalid.

## Tool-free migration

A method explicitly declaring `allowed-tools: []`, with complete static analysis
and no runtime dependencies, can freeze an empty native binding for the selected
targets. Missing declarations are not interpreted as no-tool methods. Diagnosed
dependencies cannot be removed by submitting an empty list.

The candidate retains the original source digest and exact target catalogs. It is
not formally published, qualified or executed by this operation. Builder must be
configured with `allowMethodOnly` and independently qualified method-only Hosts.
The empty binding is not a fallback for unsupported business capabilities.

## Verification boundary

Unit and HTTP application checks cover source preservation, empty/omitted tools,
catalog changes, operator opt-out, per-side dependency scope and old adapter
compatibility. These do not replace native execution, actual model requests,
authenticated browser workflow or professional-quality review.

The repeatable local browser check uses the actual service and page with a
controlled analyzer and two catalog endpoints:

```sh
pnpm build
METHOD_ONLY_UI_OUTPUT=/tmp/method-only-ui-unique node scripts/verify-method-only-migration-ui.mjs
```

Use a new output directory. It checks browser upload, explicit two-target empty
binding, candidate ZIP preservation, return to Skill assets, and 1366/390/320px
screenshots. All fixture requests must be read-only capability/catalog queries.
The report marks Runtime execution, real model and SSO as untested; a successful
candidate download is not a release or full evaluation acceptance.

For native execution, Builder's `engineering/verify_method_only_native_browser.py`
starts two independently qualified Java Launcher fixtures and invokes the same
browser check. `--flow migration` exercises exported native bindings;
`--flow upload` exercises an ordinary standard Skill upload. Both select dual
Runtime in the page, submit two synthetic cases and inspect four case results,
method/version identity, installation Lock/history references, per-case sessions,
actual model HTTP parameters and final process cleanup. Case preparation is via
the existing manual preparation API, not AI question generation or a full manual
authoring workflow. The model is controlled and login uses an isolated local
token, so these runs do not prove model quality or platform SSO.

The browser runner may also consume `METHOD_ONLY_NATIVE_FIXTURES`, a private JSON
map from `openjiuwen` and `agentscope` to active fixture info files, plus
`METHOD_ONLY_UI_FLOW=migration|upload`. These are test inputs, not deployment
configuration; fixture info contains a temporary token and must not be published.
