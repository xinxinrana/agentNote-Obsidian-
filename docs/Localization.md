# Localization

Choose **Auto (follow Obsidian)**, **简体中文**, or **English** in **Settings → agentNote → Interface language**. An explicit choice takes priority. Auto uses Obsidian's official `getLanguage()` API: Chinese locales use Chinese; other locales use English. The plugin requires Obsidian 1.8.7 or later, where this API is available. The connection panel and settings update immediately after a manual choice; restart Obsidian to update command, ribbon, and menu names registered at startup. Changing Obsidian's language while Auto is selected also requires a restart.

## Interface text

Use `t("中文文案")` for user-visible plugin text. The Chinese source is the key; its English translation lives in `src/i18n/en.ts`. For dynamic values, use numbered placeholders:

```ts
t("创建「{0}」", document.title)
```

Use `locale()` for date formatting. Translate interface templates, not user titles, note contents, agent names, paths, saved settings, or log records. Existing archive folder names and Markdown frontmatter keys are part of the storage format and stay stable across languages.

## Agent instructions

The Chinese default Skill is in `src/core/skill.ts`; the English default is in `src/core/skillEnglish.ts`. Keep their endpoints, request fields, identity headers, and capabilities aligned. The downloaded Skill and installation task use the current language. Existing installed or hand-edited Skills are preserved. Both Chinese and English additional-instruction sections remain editable after a language change.

## Validation

`npm test` checks types, builds, existing workflows, bilingual API and Skill behavior, user-content preservation, and translation coverage. `test/i18n.mjs` reports missing translations, mismatched placeholders, or untranslated interface literals. Check both languages in the connection panel, settings, dialogs, insights, tutorial, and share image when changing layouts or copy.
