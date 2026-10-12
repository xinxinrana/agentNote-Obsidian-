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

Use Node.js 22 or newer for development. Alternatively, save `AGENTNOTE_TEST_VAULT="/absolute/path/to/test-vault"` in `.env.local` at the project root, then run `npm run deploy:test`. Git ignores this local file. A command-line path takes precedence over environment variables, and existing environment variables take precedence over `.env.local`. Append `--dry-run` to check the destination without writing files.

The default configuration directory is `.obsidian`; append `--config-dir .obsidian-test` for a custom directory. Deployment overwrites the three agentNote plugin files there. Reload the plugin in Obsidian afterward.

