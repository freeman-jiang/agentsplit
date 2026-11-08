# deploy-host [user@host]: build the AgentSplit host from the committed HEAD
# and switch the host to it. The default target is root@agentsplit on the tailnet.
target="${1:-root@agentsplit}"
cd "$(git rev-parse --show-toplevel)"

if [ -n "$(git status --porcelain)" ]; then
  echo "deploy-host: commit every change first. The host's daily upgrade rebuilds the deployed commit from GitHub." >&2
  exit 1
fi
rev="$(git rev-parse HEAD)"
git fetch --quiet origin
if [ -z "$(git branch --remotes --contains "$rev")" ]; then
  echo "deploy-host: push $rev to GitHub first. The host's daily upgrade fetches it from there." >&2
  exit 1
fi

# The same build as the host's daily upgrade: this commit, with the operating
# system at the head of its release branch.
echo "deploy-host: building $rev"
system="$(nix build --no-link --print-out-paths --no-write-lock-file \
  --override-input nixpkgs-host '@hostNixpkgs@' \
  '.#nixosConfigurations.agentsplit.config.system.build.toplevel')"

echo "deploy-host: copying $system to $target"
nix copy --substitute-on-destination --to "ssh-ng://$target" "$system"

# The activation runs in its own unit, as nixos-rebuild does it: a restart of
# tailscaled ends this SSH session, but not the activation.
activate() {
  ssh "$target" systemd-run --collect --no-ask-password --pipe --quiet --wait \
    --service-type=exec --unit=agentsplit-deploy "$system/bin/switch-to-configuration" "$1"
}

echo "deploy-host: activating without changing the boot default"
activated=1
activate test || activated=""

healthy=""
for _ in $(seq 1 30); do
  if ssh "$target" 'systemctl is-active --quiet agentsplit.service && curl -fsS -o /dev/null http://127.0.0.1:3000/api/health'; then
    healthy=1
    break
  fi
  sleep 2
done
if [ -z "$activated" ]; then
  echo "deploy-host: the activation failed, or the connection dropped during it. The boot default did not change." >&2
  echo "deploy-host: see: ssh $target journalctl -u agentsplit-deploy -n 100. After a dropped connection, run deploy-host again." >&2
  exit 1
fi
if [ -z "$healthy" ]; then
  echo "deploy-host: the new system runs, but AgentSplit is not healthy. It is not the boot default." >&2
  echo "deploy-host: see: ssh $target journalctl -u agentsplit -n 100" >&2
  echo "deploy-host: go back now with: ssh $target /nix/var/nix/profiles/system/bin/switch-to-configuration switch" >&2
  exit 1
fi

ssh "$target" "nix-env --profile /nix/var/nix/profiles/system --set $system"
activate boot
echo "deploy-host: $target runs $rev and boots into it"
