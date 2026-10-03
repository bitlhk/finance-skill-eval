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
