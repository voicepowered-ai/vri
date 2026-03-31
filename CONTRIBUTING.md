# Contributing to VRI

This repository contains protocol and documentation only.

Contributions focus on:

- protocol clarification
- documentation improvements
- reference architecture discussions

## Scope

The normative source of truth is [`VRI-PROTOCOL-v1.0.md`](./VRI-PROTOCOL-v1.0.md). Companion documents such as the whitepaper and reference architecture notes are explanatory and must remain aligned with the protocol.

This repository does not currently accept changes that assume the presence of a deployed production stack, SDK runtime, ledger service, usage accounting service, or deployment integration.

## Appropriate Contributions

Good contributions include:

- removing ambiguity from protocol-adjacent text,
- correcting terminology so it matches the protocol,
- improving the documentation signing and verification bundle,
- clarifying threat assumptions and limitations,
- improving examples while keeping them clearly non-normative,
- discussing reference architecture tradeoffs without presenting them as deployed behavior.

## Contribution Workflow

1. Fork the repository.
2. Create a branch for your change.
3. Make focused edits.
4. Run the release verification flow:

```bash
./verify_docs.sh
```

5. Submit a pull request with:
   - the motivation for the change,
   - the files affected,
   - a note describing whether the change is normative or non-normative.

## Editorial Rules

- Do not change protocol semantics casually.
- Do not add capabilities that are not implemented or defined.
- Do not describe companion material as normative.
- Use the protocol terms consistently:
  - Proof Package
  - Canonical Audio
  - Usage Event
  - Inference Adapter

## Security Reporting

If you believe you have found a flaw in the release signing bundle or a protocol-level security issue, do not publish exploit details in a public issue first. Contact the maintainer directly and include:

- a description of the issue,
- affected files,
- reproduction steps,
- security impact.

## Community

- **Discord**: https://discord.gg/vri
- **GitHub Discussions**: https://github.com/vrihq/vri/discussions
- **Twitter**: @VRIHq
- **Email**: dev@vri.app

---

## License

By contributing, you agree that your contributions will be licensed under the Apache 2.0 License.

---

Thank you for contributing to VRI! 🚀
