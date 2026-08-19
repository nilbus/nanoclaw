---
name: project
description: Switch Phoebe to a host project directory and replace her project-specific instructions; use when changing Phoebe's active project.
---

# Switch Phoebe's project

Use this skill when the user asks to point Phoebe at a different project.

The first argument is the host directory. The remaining text is optional
instructions for Phoebe. The mounted project always appears inside Phoebe's
container at `/workspace/extra/project`.

Run from the NanoClaw repository root:

```bash
pnpm exec tsx "${CLAUDE_SKILL_DIR}/scripts/project.ts" \
  --dir '<host-project-directory>' \
  [--instructions '<Phoebe instructions>']
```

For long or multiline instructions, use `--instructions-file '<file>'`
instead. Do not pass either instructions flag when the user gives no
instructions: the skill must clear Phoebe's existing `CLAUDE.local.md`, not
preserve the previous project's instructions.

The helper creates the directory when it does not exist, adds the exact
directory to NanoClaw's external mount allowlist when necessary, replaces
Phoebe's active project mount, updates the per-group instructions, and
restarts Phoebe. It refuses paths blocked by the mount-security policy or
paths whose allowlist entry is read-only.

After it completes, report the resolved host directory, whether the directory
was created, whether instructions were cleared or replaced, and whether the
restart succeeded. Do not add project-specific instructions yourself; use
only the instructions supplied by the user.
