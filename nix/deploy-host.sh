# deploy-host [--update] [user@host]: build the AgentSplit host and switch the
# host to it. The default target is root@agentsplit on the tailnet.
#
# Without --update, it deploys the committed HEAD of this checkout. With
# --update (the weekly operating system update, DEPLOYMENT.md), it rebuilds
# the commit that the host runs, and reboots the host when the kernel changed.
# Both builds take nixpkgs-host at the head of its release branch, so a deploy
# never takes the operating system back. HOST_CONFIG selects the
# configuration (default agentsplit, the GCE host; agentsplit-ec2 for EC2).
update=""
if [ "${1:-}" = "--update" ]; then
  update=1
  shift
fi
target="${1:-root@agentsplit}"
config="${HOST_CONFIG:-agentsplit}"
cd "$(git rev-parse --show-toplevel)"

ssh_target() {
  ssh -o ConnectTimeout=15 "$target" "$@"
}

# Wait up to $1 checks, 2 seconds apart, for the server to answer.
wait_healthy() {
  for _ in $(seq 1 "$1"); do
    if ssh_target 'systemctl is-active --quiet agentsplit.service && curl -fsS -o /dev/null http://127.0.0.1:3000/api/health' 2>/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

git fetch --quiet origin
if [ -n "$update" ]; then
  rev="$(ssh_target nixos-version --configuration-revision)"
  if [ -z "$rev" ] || ! git cat-file -e "$rev^{commit}" 2>/dev/null; then
    echo "deploy-host: $target runs no known commit ('$rev'). Deploy a commit first: deploy-host $target" >&2
    exit 1
  fi
else
  if [ -n "$(git status --porcelain)" ]; then
    echo "deploy-host: commit every change first. The host records the deployed commit, and --update rebuilds it." >&2
    exit 1
  fi
  rev="$(git rev-parse HEAD)"
  if [ -z "$(git branch --remotes --contains "$rev")" ]; then
    echo "deploy-host: push $rev to GitHub first, so that every checkout can rebuild it." >&2
    exit 1
  fi
fi

# The host's system can differ from this machine's (an x86_64 host from the
# aarch64 dev box). Nix builds it only with emulation (boot.binfmt in dots) or
# a remote builder; stop here when neither is set up.
flake="git+file://$PWD?rev=$rev"
host_system="$(nix eval --raw "$flake#nixosConfigurations.$config.pkgs.stdenv.hostPlatform.system")"
platforms=" $(nix config show system) $(nix config show extra-platforms) "
if [[ "$platforms" != *" $host_system "* ]] && [ -z "$(nix config show builders)" ]; then
  echo "deploy-host: this machine cannot build $host_system (system and extra-platforms:$platforms; no builders)." >&2
  echo "deploy-host: turn on emulation (boot.binfmt.emulatedSystems = [ \"$host_system\" ] in dots) and run devbox-apply." >&2
  exit 1
fi
if [ "$host_system" != "$(nix config show system)" ] && [ -z "$(nix config show builders)" ] &&
  [ ! -e "/proc/sys/fs/binfmt_misc/$host_system" ]; then
  echo "deploy-host: Nix lists $host_system, but the kernel has no binfmt entry for it (/proc/sys/fs/binfmt_misc/$host_system)." >&2
  exit 1
fi

echo "deploy-host: building $rev ($config, $host_system)"
# Overriding an input makes Nix clear self.rev. Carry the selected Git commit
# into the evaluated host, so the next --update can rebuild the same app.
drv="$(nix eval --raw --no-write-lock-file \
  --override-input nixpkgs-host '@hostNixpkgs@' \
  "$flake#nixosConfigurations.$config" \
  --apply "host: (host.extendModules { modules = [ ({ lib, ... }: { system.configurationRevision = lib.mkForce \"$rev\"; }) ]; }).config.system.build.toplevel.drvPath")"
system="$(nix build --no-link --print-out-paths "$drv^*")"

if [ "$(ssh_target 'readlink -f /run/current-system /nix/var/nix/profiles/system')" = "$system"$'\n'"$system" ]; then
  echo "deploy-host: $target already runs and boots $system"
  exit 0
fi

echo "deploy-host: copying $system to $target"
# The host's Nix accepts only paths signed by cache.nixos.org. The paths built
# here are unsigned, so the copy skips the signature check, which Nix allows
# for root on the target: the dev box is the host's deploy authority anyway.
nix copy --no-check-sigs --substitute-on-destination --to "ssh-ng://$target" "$system"

# The activation runs in its own unit and writes to the journal, not to this
# SSH session. A restart of tailscaled ends the session; with the output piped
# into it, switch-to-configuration died on the broken pipe halfway (exit 101),
# after it had stopped AgentSplit. So the unit starts without waiting, and this
# script polls its state, reconnecting when the session drops.
activate() {
  local unit="agentsplit-deploy-$1" state="" result="" invocation="" _
  ssh_target "systemctl stop $unit 2>/dev/null; systemctl reset-failed $unit 2>/dev/null; true"
  ssh_target systemd-run --no-ask-password --no-block --quiet --unit="$unit" \
    --property=Type=oneshot --property=RemainAfterExit=yes \
    "$system/bin/switch-to-configuration" "$1"
  for _ in $(seq 1 120); do
    sleep 5
    state="$(ssh_target "systemctl show --property=ActiveState --value $unit" 2>/dev/null)" || continue
    case "$state" in active | failed) break ;; esac
  done
  invocation="$(ssh_target "systemctl show --property=InvocationID --value $unit")"
  ssh_target "journalctl --no-pager --output=cat _SYSTEMD_INVOCATION_ID=$invocation" || true
  result="$(ssh_target "systemctl show --property=Result --value $unit")"
  ssh_target "systemctl stop $unit; systemctl reset-failed $unit 2>/dev/null; true"
  [ "$state" = active ] && [ "$result" = success ]
}

echo "deploy-host: activating without changing the boot default"
activated=1
activate test || activated=""

healthy=""
wait_healthy 30 && healthy=1
if [ -z "$activated" ]; then
  echo "deploy-host: the activation failed (its log is above). The boot default did not change." >&2
  echo "deploy-host: go back with: ssh $target /nix/var/nix/profiles/system/bin/switch-to-configuration switch" >&2
  exit 1
fi
if [ -z "$healthy" ]; then
  echo "deploy-host: the new system runs, but AgentSplit is not healthy. It is not the boot default." >&2
  echo "deploy-host: see: ssh $target journalctl -u agentsplit -n 100" >&2
  echo "deploy-host: go back now with: ssh $target /nix/var/nix/profiles/system/bin/switch-to-configuration switch" >&2
  exit 1
fi

ssh_target "nix-env --profile /nix/var/nix/profiles/system --set $system"
activate boot
echo "deploy-host: $target runs $rev and boots into it"

# A new kernel, initrd or kernel modules take effect only at the next boot.
booted="$(ssh_target 'readlink /run/booted-system/kernel /run/booted-system/initrd /run/booted-system/kernel-modules')"
current="$(ssh_target "readlink $system/kernel $system/initrd $system/kernel-modules")"
if [ "$booted" = "$current" ]; then
  exit 0
fi
if [ -z "$update" ]; then
  echo "deploy-host: the new kernel takes effect at the next boot. The weekly --update reboots for it, or run: ssh $target systemctl reboot"
  exit 0
fi

echo "deploy-host: rebooting $target into the new kernel"
ssh_target systemctl reboot || true
sleep 20
if ! wait_healthy 150; then
  echo "deploy-host: $target is not healthy 5 minutes after the reboot. Use the serial console if Tailscale does not answer (DEPLOYMENT.md)." >&2
  exit 1
fi
echo "deploy-host: $target booted the new kernel and is healthy"
