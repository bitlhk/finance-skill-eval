# Finance Skill Eval

`finance-skill-eval` is a portable evaluation component for financial Agent
Skills. It separates the reusable evaluation method from any single Agent
product.

The package owns:

- versioned Eval Packs and finance-specific rubrics;
- AI-assisted test preparation;
- Promptfoo-based left/right execution orchestration;
- blind pairwise judging and deterministic replay checks;
- JSON/HTML reports and actionable Skill improvement suggestions.

The host product owns runtime concerns such as Skill installation, MCP tools,
credentials, role authorization, sessions, and native traces. A host connects
those capabilities through `RuntimeAdapter` and `ModelAdapter`.

## Model Roles

Each Eval Pack can configure three roles independently:

1. `analyzer`: reads a Skill and proposes relevant test cases;
2. `execution.left/right`: runs the same case with different Skill/model arms;
3. `judge`: performs an anonymous financial-quality comparison.

Model secrets never belong in an Eval Pack. The host resolves each
`credentialRef`.

## First Vertical Slice

The first pack replays the frozen `investment-research-assistant@1.1.0` EA
evidence. It verifies that the package reproduces the existing conclusion:

- company research improves from data listing to a falsifiable research loop;
- financial analysis adds balance-sheet cross-checks and executable follow-up.

Run it with:

```bash
pnpm install
pnpm eval:investment:replay
```

The command writes `report.json` and `report.html` under
`reports/investment-research/`.

The second standard pack covers the two wealth-management tasks that already
have AI expert blind-review calibration: pre-visit diagnosis and ready-state
portfolio recommendation. Its evidence comes from the frozen controlled
harness, so it proves professional output differences but does not claim native
EA Runtime identity:

```bash
pnpm eval:wealth:replay
```

The command writes `report.json` and `report.html` under
`reports/wealth-management/`.

## Integration Shape

```text
EA Skill Market UI
        |
        v
EA evaluation endpoint
        |
        v
finance-skill-eval (embedded package)
        |
        +-- Promptfoo orchestration
        +-- finance judge / report
        |
        v
EA RuntimeAdapter -> isolated Jiuwen session + MCP + native trace
```

The same package can be embedded by another Agent platform with its own
adapter. A future service wrapper is possible, but is intentionally outside V1.
