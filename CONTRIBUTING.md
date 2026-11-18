# Contributing to Laneboard

Thanks for your interest in Laneboard. It is small on purpose: one server, no runtime dependencies, one contract (`schema/v1/`).

## Ways to help now

- **Report bugs.** Open an issue with the [bug report](../../issues/new?template=bug-report.yml) template: your version, Node version, how you run it and the steps that lead to the problem. Remove tokens and the contents of `data/owner.token` before you paste logs.
- **Review a translation.** The Chinese and Vietnamese UI files in `public/locales/` were drafted by an AI model and are marked `"status": "needs-review"`. Native-speaker fixes are welcome.
- **Suggest features and discuss ideas** in an issue.

## Sending code

- Open an issue first for anything bigger than a small fix, so we can agree on it.
- Contributions are accepted under the project license, Apache-2.0 (section 5 of [LICENSE](LICENSE)); no separate agreement is needed.
- Keep the change surgical: match the existing style, add no runtime dependency, and keep the write contract (`POST /api/v1/write`, the op schemas) backward compatible unless the issue says otherwise.
- Add or update a test in `test/` for any behaviour you change.

## Checks

```sh
npm test    # node --test "test/*.test.mjs"; must pass before you open a pull request
```

`npm run smoke` and the `check:*` scripts need a browser and are optional.

## Contact

- Open-source questions: oss@zumia.space
