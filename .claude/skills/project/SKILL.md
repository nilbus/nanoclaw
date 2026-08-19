---
name: project
description: Switch Phoebe to a sibling project by name and replace her project-specific instructions; use when changing Phoebe's active project.
---

# Switch Phoebe's project

Use this skill when the user asks to point Phoebe at a different project.

The first argument is the project name. It resolves to a sibling directory
under `projects/` in this NanoClaw checkout. The remaining text is optional
instructions for Phoebe. The mounted project always appears inside Phoebe's
container at `/workspace/extra/project`.

Run from the NanoClaw repository root:

```bash
pnpm exec tsx "${CLAUDE_SKILL_DIR}/scripts/project.ts" \
  --project '<project-name>' \
  [--instructions '<Phoebe instructions>']
```

For long or multiline instructions, use `--instructions-file '<file>'`
instead. Do not pass either instructions flag when the user gives no
instructions: the skill must clear Phoebe's existing `CLAUDE.local.md`, not
preserve the previous project's instructions.

The helper creates the sibling directory when it does not exist, adds the
exact directory to NanoClaw's external mount allowlist when necessary,
replaces Phoebe's active project mount, updates the per-group instructions,
and restarts Phoebe. It refuses invalid project names, projects blocked by
the mount-security policy, or projects whose allowlist entry is read-only.

After it completes, report the resolved host directory, whether the directory
was created, whether instructions were cleared or replaced, and whether the
restart succeeded. Do not add project-specific instructions yourself; use
only the instructions supplied by the user.
