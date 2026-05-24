#!/bin/bash
# NanoClaw agent container entrypoint.
#
# The host passes initial session parameters via stdin as a single JSON blob,
# then the agent-runner opens the session DBs at /workspace/{inbound,outbound}.db
# and enters its poll loop. All further IO flows through those DBs.
#
# We capture stdin to a file first so /tmp/input.json is available for
# post-mortem inspection if the container exits unexpectedly, then exec bun
# so that bun becomes PID 1's direct child (under tini) and receives signals.

set -e

if [ -z "${HOME:-}" ] || [ "$HOME" = "/" ]; then
  export HOME=/home/node
fi

setup_nss_wrapper() {
  if getent passwd "$(id -u)" >/dev/null 2>&1; then
    return
  fi

  local nss_wrapper
  nss_wrapper="$(find /usr/lib -name libnss_wrapper.so -print -quit 2>/dev/null || true)"
  if [ -z "$nss_wrapper" ]; then
    return
  fi

  local uid gid group_name home_dir
  uid="$(id -u)"
  gid="$(id -g)"
  home_dir="${HOME:-/home/node}"

  cp /etc/passwd /tmp/passwd
  cp /etc/group /tmp/group

  group_name="$(getent group "$gid" | cut -d: -f1 || true)"
  if [ -z "$group_name" ]; then
    group_name="nanoclaw"
    echo "${group_name}:x:${gid}:" >> /tmp/group
  fi

  echo "nanoclaw:x:${uid}:${gid}:NanoClaw Runtime User:${home_dir}:/bin/bash" >> /tmp/passwd

  export NSS_WRAPPER_PASSWD=/tmp/passwd
  export NSS_WRAPPER_GROUP=/tmp/group
  export LD_PRELOAD="${nss_wrapper}${LD_PRELOAD:+:${LD_PRELOAD}}"
}

setup_github_token_git() {
  if [ -z "${SADDLE_VIEW_BUILD_GITHUB_TOKEN:-}" ]; then
    return
  fi

  git config --global credential.https://github.com.username x-access-token
  git config --global credential.helper '!f() { test "$1" = get || exit 0; echo username=x-access-token; echo password=$SADDLE_VIEW_BUILD_GITHUB_TOKEN; }; f'

  git config --global --unset-all url.https://github.com/.insteadOf >/dev/null 2>&1 || true
  git config --global --add url.https://github.com/.insteadOf git@github.com:
  git config --global --add url.https://github.com/.insteadOf ssh://git@github.com/
}

setup_nss_wrapper
setup_github_token_git

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

cat > /tmp/input.json

exec bun run /app/src/index.ts < /tmp/input.json
