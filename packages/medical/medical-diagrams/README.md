# @deepseek-ai/dsh-medical-diagrams

The `clinical_diagram` tool writes self-contained editorial HTML+SVG figures in the style of cathrynlavery/diagram-design. **No Mermaid, no external renderer, no network.**

- Kinds: `timeline`, `pathway`, `decision_tree`. Nodes can carry `tone` (`default`, `accent`, `warning`, `muted`) and `detail`.
- Every coordinate sits on a **4px grid**; text wraps by measured width.
- Colors come only from CSS variables `--bg-paper`, `--text-ink`, `--accent-clinical`, `--muted-subtle`. Every text/background pair meets **WCAG 2.1 AA**, which the tests assert with `contrastRatio`.
- Output goes to `<cwd>/clinical-diagrams/<slug>.html` (`outputDir`). The clinical preset's `present` tool opens it.

See `../../../examples/` for rendered samples (sepsis pathway, chest-pain decision tree, admission timeline).
