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
    # The server measured 94 MB idle and 134 MB at its peak in the VM test.
    memoryHigh = "256M";
    memoryMax = "320M";
    databasePoolSize = 5;
  };

  # PostgreSQL for a 1 GB host that shares its memory with the server. The
  # ledger is a few MB, so a small cache holds all of it. A quarter of a CPU
  # gains nothing from parallel queries.
  services.postgresql.settings = {
    # The server's pool (databasePoolSize), the dump, an admin psql and the
    # 3 superuser slots, with room to spare. module.nix checks the pool fits.
    max_connections = 16;
    shared_buffers = "64MB";
    effective_cache_size = "256MB";
    work_mem = "2MB";
    maintenance_work_mem = "32MB";
    autovacuum_max_workers = 1;
    max_wal_size = "256MB";
    min_wal_size = "32MB";
    random_page_cost = 1.1;
    max_worker_processes = 2;
    max_parallel_workers = 0;
    max_parallel_workers_per_gather = 0;
    max_parallel_maintenance_workers = 0;
    huge_pages = "off";
  };
  systemd.services.postgresql.serviceConfig = {
    MemoryHigh = "192M";
    MemoryMax = "256M";
    # The server goes first when memory runs out (OOMScoreAdjust in
    # module.nix). A killed backend restarts every connection.
    OOMScoreAdjust = -500;
  };

  # Admin access is Tailscale SSH, which the tailnet policy controls. The
  # state in /var/lib/tailscale keeps the node's identity across deploys. A
  # nixos-anywhere install copies a one-time auth key into this file with the
  # other files (DEPLOYMENT.md); a node that is already logged in never reads
  # it. On GCE the first join reads the key from the metadata instead (gce.nix).
  services.tailscale = {
    enable = true;
    authKeyFile = "/etc/agentsplit/tailscale-auth-key";
    # The flags of the first join, so a later `tailscale up` does not ask to
    # log in again. tag:app accepts connections from the dev box and Freeman's
    # devices and starts none. The host keeps the provider's DNS resolver (the
    # GCE metadata server or the VPC resolver on EC2): the cloud firewall
    # allows no DNS to the internet, so a resolver pushed by the tailnet would
    # break name lookups.
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

  # The host never evaluates or builds Nix: an evaluation of this flake needs
  # about 600 MB, more than 1 GB leaves free. Operating system updates come
  # from the dev box instead (`deploy-host --update`, weekly; DEPLOYMENT.md),
  # which builds the deployed commit with nixpkgs-host at the head of its
  # release branch. The host only receives the built system and fetches its
  # paths from the binary cache.
  nix = {
    settings = {
      experimental-features = [
        "nix-command"
        "flakes"
      ];
      auto-optimise-store = true;
      # Fail at once if a path must be built on the host.
      max-jobs = 0;
    };
    # A deploy's copy does not take the CPU or the disk from the server.
    daemonCPUSchedPolicy = "idle";
    daemonIOSchedClass = "idle";
    gc = {
      automatic = true;
      dates = "weekly";
      options = "--delete-older-than 14d";
    };
  };
  # When memory runs out, a deploy stops before the server does; deploy-host
  # can run again.
  systemd.services.nix-daemon.serviceConfig.OOMScoreAdjust = 800;

  services.journald.extraConfig = ''
    SystemMaxUse=256M
    SystemKeepFree=1G
    RuntimeMaxUse=16M
    MaxRetentionSec=30day
  '';

  # Compressed swap in RAM for idle pages, at about a third of their size.
  # Each service's MemorySwapMax keeps it from growing past its limits.
  zramSwap = {
    enable = true;
    memoryPercent = 50;
  };
  # Keep the admin path and the logs alive when memory runs short: the kernel
  # does not reclaim below MemoryMin, and the OOM killer takes them last.
  systemd.services.tailscaled.serviceConfig = {
    MemoryMin = "48M";
    OOMScoreAdjust = -900;
  };
  systemd.services.systemd-journald.serviceConfig = {
    MemoryMin = "16M";
    OOMScoreAdjust = -900;
  };

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
