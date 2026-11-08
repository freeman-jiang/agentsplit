# The AgentSplit host: one small VM that runs only AgentSplit, its database and
# its tunnel connector. It has no open inbound port. Cloudflare Tunnel brings
# the public traffic in, and Tailscale SSH is the only admin path.
#
# The provider-specific part is one import (./ec2.nix). To move to another
# cloud, replace it with that provider's hardware profile and install with
# nixos-anywhere (./disk.nix, DEPLOYMENT.md).
{
  lib,
  pkgs,
  agentsplitRev,
  hostNixpkgs,
  ...
}:
{
  # services.agentsplit comes from the flake (agentsplitModule in flake.nix).
  imports = [
    ./disk.nix
    ./ec2.nix
  ];

  networking.hostName = "agentsplit";
  time.timeZone = "UTC";
  system.stateVersion = "26.05";
  system.configurationRevision = agentsplitRev;

  # The file system labels of the official NixOS EC2 image, which disk.nix
  # also writes, so one definition fits both installs.
  fileSystems."/" = {
    device = "/dev/disk/by-label/nixos";
    fsType = "ext4";
    autoResize = true;
  };
  fileSystems."/boot" = {
    device = "/dev/disk/by-label/ESP";
    fsType = "vfat";
    options = [ "umask=0077" ];
  };
  boot.growPartition = true;
  # Every aarch64 cloud VM boots with UEFI. The removable path needs no EFI
  # variables, so the same disk boots on any of them.
  boot.loader.grub = {
    enable = true;
    device = "nodev";
    efiSupport = true;
    efiInstallAsRemovable = true;
    configurationLimit = 10;
  };
  boot.loader.timeout = 1;

  services.agentsplit = {
    enable = true;
    tunnel.enable = true;
  };

  # PostgreSQL for a 2 GB host that shares its memory with the server. The
  # ledger is a few MB, so a small cache holds all of it.
  services.postgresql.settings = {
    max_connections = 30;
    shared_buffers = "128MB";
    effective_cache_size = "512MB";
    work_mem = "4MB";
    maintenance_work_mem = "64MB";
    wal_buffers = "4MB";
    max_wal_size = "512MB";
    min_wal_size = "64MB";
    random_page_cost = 1.1;
    max_worker_processes = 4;
    max_parallel_workers = 2;
    max_parallel_workers_per_gather = 1;
    huge_pages = "off";
  };
  systemd.services.postgresql.serviceConfig = {
    MemoryHigh = "448M";
    MemoryMax = "512M";
  };

  # Admin access is Tailscale SSH, which the tailnet policy controls. The
  # state in /var/lib/tailscale keeps the node's identity across deploys. An
  # install with nixos-anywhere puts a one-time auth key here (DEPLOYMENT.md);
  # a node that is already logged in never reads it.
  services.tailscale = {
    enable = true;
    authKeyFile = "/etc/agentsplit/tailscale-auth-key";
    # The same flags as the first join in dots (infra/aws), so a later
    # `tailscale up` does not ask to log in again. tag:app accepts connections
    # from the dev box and Freeman's devices and starts none. The host keeps the
    # VPC's DNS resolver: the security group allows no DNS to the internet, so a
    # resolver pushed by the tailnet would break name lookups.
    extraUpFlags = [
      "--ssh"
      "--hostname=agentsplit"
      "--advertise-tags=tag:app"
      "--accept-dns=false"
    ];
    extraSetFlags = [
      "--ssh"
      "--accept-dns=false"
    ];
  };
  services.openssh.enable = false;
  networking.firewall = {
    enable = true;
    allowedTCPPorts = [ ];
    allowedUDPPorts = [ ];
    # Only the tailnet reaches the host, and nothing but Tailscale SSH listens
    # outside the loopback interface.
    trustedInterfaces = [ "tailscale0" ];
  };

  # Daily operating system upgrades: the deployed commit of this flake, with
  # nixpkgs-host at the head of its release branch, which gets only backports
  # and security fixes. The app, its Bun and its dependencies stay as deployed,
  # because they come from the locked nixpkgs input; app changes reach the
  # host only through deploy-host. A new kernel reboots the host in the window.
  system.autoUpgrade = {
    enable = agentsplitRev != null;
    flake = "github:freeman-jiang/agentsplit/${toString agentsplitRev}#agentsplit";
    flags = [
      "--override-input"
      "nixpkgs-host"
      hostNixpkgs
      "--no-write-lock-file"
    ];
    dates = "*-*-* 09:20:00";
    randomizedDelaySec = "20min";
    allowReboot = true;
    rebootWindow = {
      lower = "09:00";
      upper = "10:30";
    };
  };
  # Evaluation needs about 1 GB. The kernel stops the upgrade before the server or the database.
  systemd.services.nixos-upgrade.serviceConfig = {
    MemoryMax = "1G";
    OOMScoreAdjust = 500;
  };

  nix = {
    settings = {
      experimental-features = [
        "nix-command"
        "flakes"
      ];
      auto-optimise-store = true;
    };
    gc = {
      automatic = true;
      dates = "weekly";
      options = "--delete-older-than 14d";
    };
  };

  services.journald.extraConfig = ''
    SystemMaxUse=256M
    SystemKeepFree=1G
    RuntimeMaxUse=32M
    MaxRetentionSec=30day
  '';

  # Compressed swap in RAM for idle pages. Each service's MemorySwapMax keeps it from growing past its limits.
  zramSwap = {
    enable = true;
    memoryPercent = 25;
  };
  # Keep the admin path alive when memory runs short.
  systemd.services.tailscaled.serviceConfig.MemoryMin = "64M";
  systemd.services.systemd-journald.serviceConfig.MemoryMin = "32M";

  users.mutableUsers = false;
  # Tailscale SSH needs no password or key. This optional root-only file holds
  # a password hash (mkpasswd) for the provider's serial console, the way in
  # when Tailscale fails. Without the file, root has no password.
  users.users.root.hashedPasswordFile = "/etc/agentsplit/root-password-hash";
  documentation.enable = false;
  environment.systemPackages = [
    pkgs.curl
    pkgs.jq
  ];
  # A host without a desktop.
  services.udisks2.enable = lib.mkDefault false;
  xdg.icons.enable = false;
  xdg.mime.enable = false;
  xdg.sounds.enable = false;
  fonts.fontconfig.enable = false;
}
