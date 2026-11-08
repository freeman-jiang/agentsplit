# services.agentsplit: the AgentSplit server as a hardened systemd service, its
# PostgreSQL 18 database on the same host (Unix socket only), the dumps of that
# database, and the Cloudflare Tunnel connector that brings the public traffic
# in. DEPLOYMENT.md ("NixOS host") is the runbook.
#
# Secrets never enter the Nix store. The server and the connector each read one
# root-only environment file, which is copied onto the host over Tailscale SSH
# (DEPLOYMENT.md). systemd reads the file as root before it drops privileges.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.agentsplit;
  postgresql = config.services.postgresql.package;

  # What every long-running unit here gets. The server and the connector need
  # no file system writes, no privileges, and no devices.
  hardening = {
    DynamicUser = true;
    UMask = "0077";
    NoNewPrivileges = true;
    CapabilityBoundingSet = "";
    AmbientCapabilities = "";
    ProtectSystem = "strict";
    ProtectHome = true;
    PrivateTmp = true;
    PrivateDevices = true;
    ProtectKernelTunables = true;
    ProtectKernelModules = true;
    ProtectKernelLogs = true;
    ProtectControlGroups = true;
    ProtectClock = true;
    ProtectHostname = true;
    ProtectProc = "invisible";
    RestrictNamespaces = true;
    RestrictRealtime = true;
    RestrictSUIDSGID = true;
    LockPersonality = true;
    RemoveIPC = true;
    SystemCallArchitectures = "native";
    SystemCallFilter = [
      "@system-service"
      "~@privileged"
    ];
  };

  dumpScript = pkgs.writeShellApplication {
    name = "agentsplit-db-dump";
    runtimeInputs = [
      postgresql
      pkgs.coreutils
      pkgs.findutils
    ];
    text = ''
      dir=${lib.escapeShellArg cfg.backup.directory}
      name="agentsplit-$(date -u +%Y%m%dT%H%M%SZ).dump"
      partial="$dir/.$name.partial"
      trap 'rm -f "$partial"' EXIT
      pg_dump --format=custom --dbname=${cfg.database} --file="$partial"
      # A dump that pg_restore cannot list is not a backup.
      pg_restore --list "$partial" > /dev/null
      mv "$partial" "$dir/$name"
      ln -sfn "$name" "$dir/.latest.dump"
      mv -T "$dir/.latest.dump" "$dir/latest.dump"
      find "$dir" -maxdepth 1 -name 'agentsplit-*.dump' -mmin +${toString (cfg.backup.keepDays * 1440)} -delete
      echo "agentsplit-db-dump: $dir/$name, $(stat -c %s "$dir/$name") bytes"
    '';
  };

  # What the dev box runs over Tailscale SSH as the backup user: the newest
  # dump on stdout. A dump older than two runs fails the pull, so a stopped
  # timer is seen at the next pull.
  latestDump = pkgs.writeShellApplication {
    name = "agentsplit-latest-dump";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.findutils
    ];
    text = ''
      file=${lib.escapeShellArg cfg.backup.directory}/latest.dump
      if [ ! -e "$file" ]; then
        echo "agentsplit-latest-dump: no dump in ${cfg.backup.directory}" >&2
        exit 1
      fi
      if [ -n "$(find -L "$file" -mmin +${toString cfg.backup.maxAgeMinutes})" ]; then
        echo "agentsplit-latest-dump: the newest dump is older than ${toString cfg.backup.maxAgeMinutes} minutes" >&2
        exit 1
      fi
      cat "$file"
    '';
  };
in
{
  options.services.agentsplit = {
    enable = lib.mkEnableOption "the AgentSplit server";

    package = lib.mkOption {
      type = lib.types.package;
      description = "The AgentSplit build (nix/package.nix).";
    };

    environmentFile = lib.mkOption {
      type = lib.types.str;
      default = "/etc/agentsplit/agentsplit.env";
      description = ''
        Root-only file of the server's settings and secrets: BASE_URL,
        BETTER_AUTH_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, the S3_UPLOAD_*
        settings and the optional ones (DEPLOYMENT.md). A string, so the file
        never enters the Nix store. The server does not start without it.
      '';
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 3000;
      description = "The loopback port of the server. Only the tunnel connector reaches it.";
    };

    database = lib.mkOption {
      type = lib.types.str;
      default = "agentsplit";
      description = "The database and its owner role. The server connects as this role with peer authentication.";
    };

    memoryHigh = lib.mkOption {
      type = lib.types.str;
      default = "640M";
      description = "The memory use of the server above which the kernel reclaims from it.";
    };

    memoryMax = lib.mkOption {
      type = lib.types.str;
      default = "768M";
      description = "The memory limit of the server. Above it, the kernel stops the server and systemd starts it again.";
    };

    databasePoolSize = lib.mkOption {
      type = lib.types.ints.positive;
      default = 10;
      description = "The size of the server's database pool (DATABASE_POOL_SIZE). It must fit in PostgreSQL's max_connections.";
    };

    cpuQuota = lib.mkOption {
      type = lib.types.str;
      default = "150%";
      description = "The CPU limit of the server, where 100% is one CPU.";
    };

    backup = {
      enable = lib.mkEnableOption "dumps of the database into a local directory" // {
        default = true;
      };
      directory = lib.mkOption {
        type = lib.types.str;
        default = "/var/backup/agentsplit";
        description = "Where the dumps go. The group `agentsplit-backup` can read them.";
      };
      onCalendar = lib.mkOption {
        type = lib.types.str;
        # Away from minute 7, when the hourly job runs.
        default = "*-*-* *:37:00";
        description = "When a dump runs (systemd calendar format).";
      };
      maxAgeMinutes = lib.mkOption {
        type = lib.types.ints.positive;
        default = 150;
        description = "The age of the newest dump at which `agentsplit-latest-dump` fails.";
      };
      keepDays = lib.mkOption {
        type = lib.types.ints.positive;
        default = 3;
        description = "How long dumps stay in the directory.";
      };
    };

    tunnel = {
      enable = lib.mkEnableOption "the Cloudflare Tunnel connector";
      environmentFile = lib.mkOption {
        type = lib.types.str;
        default = "/etc/agentsplit/cloudflared.env";
        description = ''
          Root-only file with TUNNEL_TOKEN, the token of a remotely managed
          tunnel. Cloudflare holds the tunnel's routes (DEPLOYMENT.md).
        '';
      };
    };
  };

  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      {
        assertions = [
          {
            # The pool, the dump, one admin session and the 3 superuser slots.
            assertion = cfg.databasePoolSize + 5 <= config.services.postgresql.settings.max_connections or 100;
            message = "services.agentsplit.databasePoolSize does not fit in services.postgresql.settings.max_connections.";
          }
        ];

        services.postgresql = {
          enable = true;
          # The major version fixes the data format; change it only with a dump and restore.
          package = pkgs.postgresql_18;
          # The Unix socket only.
          enableTCPIP = false;
          ensureDatabases = [ cfg.database ];
          ensureUsers = [
            {
              name = cfg.database;
              ensureDBOwnership = true;
            }
          ];
          # Peer authentication: the server's system user name is its role.
          authentication = lib.mkForce ''
            local all postgres peer
            local ${cfg.database} ${cfg.database} peer
          '';
          # The history timestamps need UTC, as in the dev shell and the image.
          settings.timezone = "UTC";
        };

        systemd.services.agentsplit = {
          description = "AgentSplit server";
          wantedBy = [ "multi-user.target" ];
          requires = [ "postgresql.service" ];
          after = [
            "postgresql.service"
            "network-online.target"
          ];
          wants = [ "network-online.target" ];
          environment = {
            DATABASE_URL = "postgresql://${cfg.database}@/${cfg.database}?host=/run/postgresql";
            HOST = "127.0.0.1";
            PORT = toString cfg.port;
            DATABASE_POOL_SIZE = toString cfg.databasePoolSize;
            # Bun caches large transpiled files under the home folder; the bundle needs no cache.
            BUN_RUNTIME_TRANSPILER_CACHE_PATH = "0";
          };
          # Five failed starts in 10 minutes (a failed migration) stop the restarts.
          startLimitIntervalSec = 600;
          startLimitBurst = 5;
          serviceConfig = hardening // {
            Type = "exec";
            User = cfg.database;
            # The settings of the file override `environment` above.
            EnvironmentFile = cfg.environmentFile;
            ExecStart = lib.getExe cfg.package;
            Restart = "on-failure";
            RestartSec = 5;
            # The server stops in 25 seconds (src/server/main/server.ts).
            TimeoutStopSec = 30;
            RestrictAddressFamilies = [
              "AF_UNIX"
              "AF_INET"
              "AF_INET6"
            ];
            MemoryHigh = cfg.memoryHigh;
            MemoryMax = cfg.memoryMax;
            MemorySwapMax = "128M";
            CPUQuota = cfg.cpuQuota;
            TasksMax = 128;
            # When memory runs out, the kernel stops the server before
            # PostgreSQL, Tailscale or the journal, and systemd starts it again.
            OOMScoreAdjust = 500;
          };
        };
      }

      (lib.mkIf cfg.backup.enable {
        users.groups.agentsplit-backup = { };
        # The dev box pulls the dumps as this user over Tailscale SSH. It reads
        # the dumps and nothing else: peer authentication gives it no database role.
        users.users.agentsplit-backup = {
          isSystemUser = true;
          group = "agentsplit-backup";
          shell = pkgs.bashInteractive;
          home = "/var/empty";
        };
        # On every PATH, also of non-login SSH commands. Only the group reads the dumps.
        environment.systemPackages = [ latestDump ];
        systemd.tmpfiles.settings.agentsplit-backup.${cfg.backup.directory}.d = {
          user = "postgres";
          group = "agentsplit-backup";
          # setgid, so each dump belongs to the group.
          mode = "2750";
        };
        systemd.services.agentsplit-db-dump = {
          description = "Dump the AgentSplit database";
          requires = [ "postgresql.service" ];
          after = [ "postgresql.service" ];
          serviceConfig = removeAttrs hardening [ "DynamicUser" ] // {
            Type = "oneshot";
            User = "postgres";
            UMask = "0027";
            ExecStart = lib.getExe dumpScript;
            ReadWritePaths = [ cfg.backup.directory ];
            # The database socket is a file, which a private network still reaches.
            PrivateNetwork = true;
            RestrictAddressFamilies = [ "AF_UNIX" ];
            Nice = 10;
            IOSchedulingClass = "idle";
            OOMScoreAdjust = 600;
          };
        };
        systemd.timers.agentsplit-db-dump = {
          wantedBy = [ "timers.target" ];
          timerConfig = {
            OnCalendar = cfg.backup.onCalendar;
            Persistent = true;
          };
        };
      })

      (lib.mkIf cfg.tunnel.enable {
        systemd.services.agentsplit-tunnel = {
          description = "Cloudflare Tunnel connector for AgentSplit";
          wantedBy = [ "multi-user.target" ];
          after = [ "network-online.target" ];
          wants = [ "network-online.target" ];
          serviceConfig = hardening // {
            Type = "notify";
            EnvironmentFile = cfg.tunnel.environmentFile;
            # TUNNEL_TOKEN comes from the file. Cloudflare updates cloudflared
            # through the flake, never in place.
            ExecStart = "${lib.getExe pkgs.cloudflared} tunnel --no-autoupdate run";
            Restart = "always";
            RestartSec = 5;
            RestrictAddressFamilies = [
              "AF_UNIX"
              "AF_INET"
              "AF_INET6"
              "AF_NETLINK"
            ];
            MemoryMax = "128M";
            TasksMax = 64;
            # Second after the server: it restarts in seconds.
            OOMScoreAdjust = 300;
          };
        };
      })
    ]
  );
}
