# The GCE hardware profile (an e2-micro, x86_64) and the boot image that the
# dots side imports into GCE: the parts of nixpkgs' google-compute-config.nix
# and google-compute-image.nix that the host needs to boot and keep time, and
# the first join to the tailnet. We do not import those two modules: they also
# start sshd, turn on OS Login, run the Google guest agent (it makes accounts
# from the SSH keys in the metadata and runs the metadata startup scripts as
# root), take the host name from GCE and turn the firewall off. The host wants
# none of these. On another provider, use another profile (flake.nix).
{
  config,
  lib,
  pkgs,
  modulesPath,
  ...
}:
let
  tailscale = config.services.tailscale;
  # The attribute that the dots side sets, from the dev box, to a single-use
  # auth key for the first join, and removes after the join.
  authKeyUrl = "http://metadata.google.internal/computeMetadata/v1/instance/attributes/tailscale-auth-key";

  # The key stays in shell variables and goes to `tailscale up` on stdin, so
  # it is never on disk, in a process's arguments or in the journal.
  join = pkgs.writeShellApplication {
    name = "agentsplit-tailscale-join";
    runtimeInputs = [
      tailscale.package
      pkgs.coreutils
      pkgs.curl
      pkgs.jq
    ];
    text = ''
      backendState() {
        tailscale status --json --peers=false 2>/dev/null | jq -r '.BackendState // empty' || true
      }
      delay=5
      last=""
      while :; do
        state="$(backendState)"
        case "$state" in
          NeedsLogin) ;;
          "" | NoState | Starting)
            sleep 2
            continue
            ;;
          *)
            echo "agentsplit-tailscale-join: Tailscale is $state; stopping"
            exit 0
            ;;
        esac
        answer="$(curl -sS --max-time 10 -H 'Metadata-Flavor: Google' -w '\n%{http_code}' '${authKeyUrl}' 2>/dev/null)" || answer=$'\n'"no answer"
        code="''${answer##*$'\n'}"
        key="''${answer%$'\n'*}"
        if [ "$code" = 200 ] && [ -n "$key" ]; then
          echo "agentsplit-tailscale-join: the metadata holds an auth key; running tailscale up"
          if out="$(printf '%s' "$key" | tailscale up --auth-key=file:/dev/stdin --timeout=60s ${lib.escapeShellArgs tailscale.extraUpFlags} 2>&1)"; then
            echo "agentsplit-tailscale-join: joined the tailnet"
            delay=5
            continue
          fi
          echo "agentsplit-tailscale-join: tailscale up failed: ''${out//"$key"/<auth key>}" >&2
        elif [ "$code" != "$last" ]; then
          echo "agentsplit-tailscale-join: no auth key in the metadata yet ($code); polling"
        fi
        last="$code"
        key=""
        answer=""
        sleep "$delay"
        delay=$((delay * 2 > 60 ? 60 : delay * 2))
      done
    '';
  };

  # The image builds in a QEMU VM that reads the store through virtiofsd.
  # On the aarch64 dev box, x86_64 programs run under QEMU's user-mode
  # emulation, which is too slow for a QEMU VM inside it, and virtiofsd
  # finds no mount IDs there. So when imageBuildPackages is set, the VM and
  # virtiofsd come from the build machine's own packages: an x86_64 VM in
  # native QEMU (TCG). The derivation then builds only on that system.
  buildMachine = config.agentsplit.imageBuildPackages;
  imageVmTools =
    if buildMachine == null then
      pkgs.vmTools
    else
      pkgs.vmTools.override {
        customQemu = "${buildMachine.qemu}/bin/qemu-system-x86_64 -machine accel=tcg -cpu max";
        inherit (buildMachine) virtiofsd;
      };
in
{
  imports = [
    # The virtio drivers in the initrd: the disk (virtio_scsi on E2), the
    # network, and the entropy source.
    "${modulesPath}/profiles/qemu-guest.nix"
    {
      options.agentsplit.imageBuildPackages = lib.mkOption {
        type = lib.types.nullOr lib.types.raw;
        default = null;
        description = "The nixpkgs of the machine that builds the image, when its system is not x86_64-linux (see imageVmTools).";
      };
    }
  ];

  # Other machine types (C3, N4) attach the boot disk as NVMe.
  boot.initrd.availableKernelModules = [ "nvme" ];
  # GCE's serial port 1 is ttyS0. The dots side turns on its interactive
  # console (serial-port-enable), the way in when Tailscale fails.
  boot.kernelParams = [ "console=ttyS0,115200n8" ];
  boot.loader.grub.extraConfig = ''
    serial --unit=0 --speed=115200 --word=8 --parity=no --stop=1
    terminal_output console serial
    terminal_input console serial
  '';
  # Root logs in with the password hash in /etc/agentsplit/root-password-hash.
  systemd.services."serial-getty@ttyS0".enable = true;

  # The metadata server is also the time server. GCE allows traffic to it
  # whatever the VPC firewall says.
  networking.timeServers = [ "169.254.169.254" ];
  # DNS: dhcpcd (the NixOS default) writes the resolver that GCE's DHCP gives,
  # which is the metadata server too. The DHCP answer also sets the VPC's MTU
  # (1460 by default), which the NixOS dhcpcd asks for.

  # Stable names for the GCE disks (/dev/disk/by-id/google-*).
  services.udev.packages = [ pkgs.google-guest-configs ];
  services.udev.path = [ pkgs.google-guest-configs ];

  # The disk of a nixos-anywhere install on GCE (nix/host/disk.nix). The image
  # below does not use disko.
  disko.devices.disk.main.device = "/dev/sda";

  # The first join, from the GCE metadata: while Tailscale needs a login,
  # poll the metadata for the auth key, with a growing pause up to a minute,
  # and run `tailscale up` with the key on stdin. The unit ends once the node
  # is logged in, so later boots stop at once. The image holds no secret, and
  # the host's service account has no roles: the metadata needs none. The
  # nixos-anywhere path (an auth key file, default.nix) is off here.
  services.tailscale.authKeyFile = lib.mkForce null;
  # The metadata server's name without DNS, as GCE's own images do.
  networking.extraHosts = "169.254.169.254 metadata.google.internal";
  systemd.services.agentsplit-tailscale-join = {
    description = "Join the tailnet with the auth key in the GCE metadata";
    wantedBy = [ "multi-user.target" ];
    after = [
      "tailscaled.service"
      "network-online.target"
    ];
    wants = [
      "tailscaled.service"
      "network-online.target"
    ];
    serviceConfig = {
      Type = "exec";
      ExecStart = lib.getExe join;
      Restart = "on-failure";
      RestartSec = 30;
      NoNewPrivileges = true;
      ProtectSystem = "strict";
      ProtectHome = true;
      PrivateTmp = true;
    };
  };

  # The GCE image: a raw disk with the labels ESP and nixos, which
  # default.nix mounts, in the tar.gz that `gcloud compute images create`
  # takes. GCE boots it with UEFI (guest OS feature UEFI_COMPATIBLE) and with
  # Secure Boot off, because the GRUB of NixOS is not signed.
  system.build.googleComputeImage = import "${modulesPath}/../lib/make-disk-image.nix" {
    inherit config lib;
    pkgs = pkgs // {
      vmTools = imageVmTools;
    };
    name = "agentsplit-gce-image";
    partitionTableType = "efi";
    # The size of disk.nix's ESP, for the kernels of 10 generations.
    bootSize = "512M";
    # GCE takes only whole GiB. The first boot grows the disk to the size of
    # the boot disk (growPartition and autoResize in default.nix).
    diskSize = 8192;
    format = "raw";
    # No channel and no /etc/nixos: the host changes only through deploy-host.
    copyChannel = false;
    postVM = ''
      PATH=$PATH:${
        lib.makeBinPath [
          pkgs.gnutar
          pkgs.gzip
        ]
      }
      pushd $out
      # GCE wants one file named disk.raw in the archive.
      mv $diskImage disk.raw
      tar --sparse --format=oldgnu -c disk.raw | gzip -6 > agentsplit-gce.raw.tar.gz
      rm disk.raw
      popd
    '';
  };
}
