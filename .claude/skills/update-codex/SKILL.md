---
name: update-codex
description: Update the Codex CLI bundled in NanoClaw's agent container when a configured model or reasoning level is unsupported by the image.
---

# Goal

Keep NanoClaw's container-side Codex CLI compatible with the current Codex model catalog, especially when an agent is configured with a newer model such as `gpt-5.6-luna` or reasoning effort `xhigh`.

# Workflow

1. Inspect the configured version in `container/Dockerfile` (`CODEX_VERSION`) and compare it with the host CLI:

   ```bash
   rg -n '^ARG CODEX_VERSION=' container/Dockerfile
   codex --version
   ```

2. Inspect the agent's effective model and effort. The `container_configs` database row is authoritative; `groups/<folder>/container.json` is materialized from it at spawn time:

   ```bash
   pnpm ncl groups config get --id <agent-group-id> --json
   ```

   For Codex agents, the model and effort are passed by the mounted agent-runner. The model is sent on `thread/start`/`turn/start`; effort is sent on `turn/start`.

3. If the container log contains this compatibility failure, update the bundled CLI before changing the agent configuration:

   ```text
   failed to refresh available models: ... unknown variant `max`
   ```

   This means the server's model catalog has a reasoning level newer than the pinned Codex client understands. An affected turn may appear to complete normally but produce `Result: (empty)` / `last_agent_message: null`, so Telegram has no outbound message to deliver.

4. Set `CODEX_VERSION` to a known compatible version, preferably the installed host version or newer. Rebuild the Apple Container image using the install's image tag:

   ```bash
   IMAGE=$(pnpm exec tsx -e "import { getDefaultContainerImage } from './src/install-slug.ts'; process.stdout.write(getDefaultContainerImage())")
   container build --progress plain -t "$IMAGE" container
   ```

5. Restart the NanoClaw launch agent so old containers are stopped and future wakes use the rebuilt image. Find the service label from `launchctl list | rg nanoclaw`, then run:

   ```bash
   launchctl kickstart -k gui/$(id -u)/<nanoclaw-launch-agent-label>
   ```

6. Verify the host is listening and the agent configuration is unchanged:

   ```bash
   pnpm ncl groups config get --id <agent-group-id> --json
   ```

   Send a short test message through the configured channel. Confirm the newly spawned container uses the intended Codex version and inspect its logs:

   ```bash
   container list
   container exec <container-id> sh -lc 'ps -ef | rg "codex.*app-server"'
   container logs <container-id> | rg -i 'unknown variant|failed to refresh available models|Result: \(empty\)|error'
   ```

   A successful test has an agent message in the Codex transcript and a corresponding outbound row in the session's `outbound.db`. Do not treat typing indicators or a completed inbound row as success by themselves.

# Safety and scope

- Keep model changes scoped to the intended agent group; do not set a global `CODEX_MODEL` environment variable unless the user explicitly requests a global change.
- Rebuilding the image is required after changing `CODEX_VERSION`; restarting only the host does not replace an already-running container image.
- If the model catalog still fails after the upgrade, capture the exact Codex version, catalog error, model ID, and effort level before changing prompts or Telegram delivery code.
