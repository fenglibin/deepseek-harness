# Agent Note: Delivery-discipline artifact persistence

Status: implemented

English | [中文](2026-09-03-delivery-discipline-artifact-persistence.zh.md)

## Problem

B1–B3 recorded change/design/spec records as durable `delivery/change` session events only; the design's "every task leaves a change record in the project working directory" goal (§2, §6.2) was unmet because nothing wrote the `.dsh/changes/` and `.dsh/design/` files. The `record_change`/`record_design`/`record_spec` tools therefore never produced a user-readable artifact on disk.

## Decision

Make the three record tools append their record to a per-task `.dsh` artifact file after committing the durable event, using the filesystem capability seam.

- `@deepseek-ai/dsh-tool-delivery` adds `fs` to its `inject`, and each record tool resolves `.dsh/changes/<task-id>.md` (for `record_change`) or `.dsh/design/<task-id>.md` (for `record_design`/`record_spec`) against the calling agent's session `header.cwd`, then appends `- [revision N] <text>` (creating the file on first record).
- The tool package declares `@deepseek-ai/dsh-fs` as a peer dependency and `@deepseek-ai/dsh-fs-local`/`@deepseek-ai/dsh-sandbox` for tests, adds `fs`/`sandbox` project references, and the catalog generator mounts `LocalFileSystem` for the boot smoke.

This is batch B3a of the [delivery-discipline design](../../../../docs/design/delivery-discipline-rationale.md): `.dsh/changes/` / `.dsh/design/` artifact persistence. The real `openspec` CLI integration (writing `openspec/` files and running `openspec validate`) and the `artifact-written` projection remain later batches.

## Alternatives considered

**Keep records as durable events only.** Rejected: the design's §2 goal explicitly lands artifacts "in the project working directory"; a session log is not a user-readable `.dsh/` file.

**Let the model write the files with the `write` tool.** Rejected: relying on the model to separately invoke `write` reopens the "do not depend on LLM self-discipline" risk the delivery discipline exists to close; the record tool owns the write.

## Consequences

- **Bought** on-disk `.dsh/changes/<task-id>.md` and `.dsh/design/<task-id>.md` artifacts per task, satisfying the B1 "records a change" acceptance signal end to end (96 unit tests, 100% coverage).
- **Cost** an `fs` service dependency on the tool package (peer + bundle-resolved provider) and a per-record append that reads the prior file before writing.
- **Deferred (unchanged)** the full openspec change layout (proposal/design/tasks/specs) and the `openspec validate` CLI, plus the `delivery/artifact-written` session-event projection. `record_spec` already lands its spec under `openspec/changes/<task-id>/spec.md` as a stepping stone.
