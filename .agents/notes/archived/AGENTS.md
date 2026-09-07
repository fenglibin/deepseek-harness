# AGENTS.md — Archived Agent Notes

Archived Agent Notes under the kind directories are frozen historical snapshots, not current authority. Never edit, reformat, translate, update, move, or delete a sealed note; use an active Agent Note or current documentation for new decisions and facts.

The archive is Chinese-only. A note is archived as the single `.zh.md` file; historical English `.md` files and bilingual `.i18n.yaml` sidecars were retired in the single-language migration and are no longer part of the archive format.

The archival change may only relocate the `.zh.md` file, insert the identical `Archived: YYYY-MM-DD` line below the `Status: implemented` line, and repair or delete inbound links. Do not inspect, verify, or repair links out of archived notes.

Run the [`dsh-archive-agent-notes`](../../skills/dsh-archive-agent-notes/SKILL.md) workflow and seal new artifacts with `pnpm run verify-archived-agent-notes --write`. The normal verifier rejects missing sealed notes, unknown kind folders, and invalid archive metadata.
