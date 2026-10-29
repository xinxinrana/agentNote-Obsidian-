# Development

```sh
npm ci
npm test
```

The build produces the Obsidian plugin bundle in `main.js` and the Node-compatible core test bundle in `test/core-bundle.cjs`.

Development commands support macOS, Windows, and Linux. `npm test` runs type checking, builds, and core end-to-end tests without deploying to a vault. Use `npm run dev` to watch for changes and rebuild.

To deploy to a local test vault, specify an existing directory (quote paths containing spaces):

```sh
npm run deploy:test -- "/absolute/path/to/test-vault"
```

`npm test` ends with `test/perf.mjs`, which guards the performance budget on fixed synthetic data (`readReport` cache hit < 25ms, `getDashboardInsights` panel scope < 35ms and full scope < 60ms). The thresholds keep several times the headroom, so they only catch order-of-magnitude regressions.

To time a real vault, run `localStorage.setItem("agentnote:perf", "1")` in the Obsidian console and reload the plugin, then use `__anPerf.report()` for the summary or `__anPerf.microbench("label", fn)` for a single comparison. `localStorage.removeItem("agentnote:perf")` turns it off.

Use Node.js 22 or newer for development. Alternatively, save `AGENTNOTE_TEST_VAULT="/absolute/path/to/test-vault"` in `.env.local` at the project root, then run `npm run deploy:test`. Git ignores this local file. A command-line path takes precedence over environment variables, and existing environment variables take precedence over `.env.local`. Append `--dry-run` to check the destination without writing files.

The default configuration directory is `.obsidian`; append `--config-dir .obsidian-test` for a custom directory. Deployment overwrites the three agentNote plugin files there. Reload the plugin in Obsidian afterward.

