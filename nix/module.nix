# services.agentsplit: the AgentSplit servers as hardened systemd services
# behind a local nginx, their PostgreSQL 18 database on the same host (Unix
# socket only), the dumps of that database, and the Cloudflare Tunnel
# connectors that bring the public traffic in. DEPLOYMENT.md ("The host") is
# the runbook.
#
# A deploy replaces nothing at once. The servers and the connectors each run
# as two or more units, which a switch of the system does not restart;
# `agentsplit-restart` restarts them one at a time, and nginx and the tunnel
# send each request to a unit that runs.
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

  # The servers listen on the ports after the proxy's port, and the
  # connectors report their state 100 ports above that.
  servers = map (i: {
    name = "agentsplit-server-${toString i}";
    port = cfg.port + i;
  }) (lib.range 1 cfg.instances);
  tunnels = map (i: {
    name = "agentsplit-tunnel-${toString i}";
    metricsPort = cfg.port + 100 + i;
  }) (lib.range 1 cfg.tunnel.replicas);

  # The rolling restart: the servers first, then the connectors, each one
  # only after the one before it answers its own health check, so the
  # others serve meanwhile. deploy-host runs it after each switch.
  #
  # A server that stops resets the connections still in its accept queue,
  # and nginx does not send a POST again after it wrote it: 1 POST in 40
  # restarts failed with 502 in a test. So before it stops a server, the
  # script makes the kernel refuse nginx's new connections to it: nginx
  # sends those requests to another server, and the queue empties. The
  # script's own health checks run as root and still connect.
  restartScript = pkgs.writeShellApplication {
    name = "agentsplit-restart";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.curl
      pkgs.gnugrep
      pkgs.nftables
      config.systemd.package
    ];
    text = ''
      # agentsplit-restart [--changed-from <system>]: restart every server and
      # connector, or with --changed-from only those whose unit differs from
      # the unit in <system> (the system before a switch). It stops at the
      # first unit that does not get healthy in 2 minutes.
      old=""
      if [ "$#" -gt 0 ]; then
        if [ "$1" != --changed-from ] || [ "$#" -ne 2 ]; then
          echo "usage: agentsplit-restart [--changed-from <system>]" >&2
          exit 2
        fi
        old="$2"
      fi
      undrain() {
        nft delete table inet agentsplit-drain 2>/dev/null || true
      }
      # Also when the script stops early, so that no server stays drained.
      trap undrain EXIT
      undrain
      drain() {
        printf '%s\n' \
          'table inet agentsplit-drain {' \
          '  chain output {' \
          '    type filter hook output priority 0; policy accept;' \
          "    meta skuid ${config.services.nginx.user} tcp dport $1 tcp flags & (syn | ack) == syn counter reject with tcp reset" \
          '  }' \
          '}' | nft -f -
        # The server takes the connections already in its queue within milliseconds.
        sleep 1
      }
      # restart <unit> <health check URL> [<port to drain>]
      restart() {
        local unit="$1.service" health="$2" port="''${3:-}"
        if [ -n "$old" ] && [ "$(readlink -f "$old/etc/systemd/system/$unit")" = "$(readlink -f "/etc/systemd/system/$unit")" ]; then
          return 0
        fi
        echo "agentsplit-restart: restarting $unit"
        if [ -n "$port" ]; then drain "$port"; fi
        systemctl restart "$unit"
        for _ in $(seq 1 60); do
          if curl -fsS -o /dev/null --max-time 5 "$health" 2>/dev/null; then
            if [ -n "$port" ]; then
              echo "agentsplit-restart: the drain refused nginx $(nft list table inet agentsplit-drain | grep -o 'packets [0-9]*')"
              undrain
            fi
            echo "agentsplit-restart: $unit answers $health"
            return 0
          fi
          sleep 2
        done
        journalctl -u "$unit" -n 50 --no-pager >&2
        echo "agentsplit-restart: $unit does not answer $health after 2 minutes. Stopped here: the units after it were not restarted." >&2
        exit 1
      }
    ''
    + lib.concatMapStrings (
      server: "restart ${server.name} http://127.0.0.1:${toString server.port}/api/health ${toString server.port}\n"
    ) servers
    + lib.optionalString cfg.tunnel.enable (
      lib.concatMapStrings (
        tunnel: "restart ${tunnel.name} http://127.0.0.1:${toString tunnel.metricsPort}/ready\n"
      ) tunnels
    );
  };

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
      description = ''
        The loopback port of the proxy in front of the servers, which the
        tunnel's routes target. Server n listens on port + n.
      '';
    };

    instances = lib.mkOption {
      type = lib.types.ints.positive;
      default = 2;
      description = ''
        The number of servers (agentsplit-server-<n>). With two or more,
        `agentsplit-restart` restarts one while the others serve.
      '';
    };

    database = lib.mkOption {
      type = lib.types.str;
      default = "agentsplit";
      description = "The database and its owner role. The server connects as this role with peer authentication.";
    };

    memoryHigh = lib.mkOption {
      type = lib.types.str;
      default = "640M";
      description = "The memory use of each server above which the kernel reclaims from it.";
    };

    memoryMax = lib.mkOption {
      type = lib.types.str;
      default = "768M";
      description = "The memory limit of each server. Above it, the kernel stops the server and systemd starts it again.";
    };

    databasePoolSize = lib.mkOption {
      type = lib.types.ints.positive;
      default = 10;
      description = "The size of each server's database pool (DATABASE_POOL_SIZE). The pools of all servers must fit in PostgreSQL's max_connections.";
    };

    cpuQuota = lib.mkOption {
      type = lib.types.str;
      default = "150%";
      description = "The CPU limit of each server, where 100% is one CPU.";
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
      enable = lib.mkEnableOption "the Cloudflare Tunnel connectors";
      replicas = lib.mkOption {
        type = lib.types.ints.positive;
        default = 2;
        description = ''
          The number of connectors of the one tunnel (agentsplit-tunnel-<n>),
          which share its token. Cloudflare sends each request to a connector
          that is connected, so one can restart while the others serve.
        '';
      };
      edgeIpVersion = lib.mkOption {
        type = lib.types.enum [
          "auto"
          "4"
          "6"
        ];
        default = "auto";
        description = "The IP version with which the connectors reach Cloudflare's edge (TUNNEL_EDGE_IP_VERSION).";
      };
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
            # The pools of the servers, the dump, one admin session and the 3 superuser slots.
            assertion = cfg.instances * cfg.databasePoolSize + 5 <= config.services.postgresql.settings.max_connections or 100;
            message = "services.agentsplit.instances × databasePoolSize does not fit in services.postgresql.settings.max_connections.";
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

        systemd.services = lib.listToAttrs (
          map (
            server:
            lib.nameValuePair server.name {
              description = "AgentSplit server on port ${toString server.port}";
              wantedBy = [ "multi-user.target" ];
              requires = [ "postgresql.service" ];
              after = [
                "postgresql.service"
                "network-online.target"
              ];
              wants = [ "network-online.target" ];
              # A switch of the system leaves a running server as it is, so the
              # servers never restart together; agentsplit-restart restarts
              # them one at a time (deploy-host). A new server starts.
              restartIfChanged = false;
              environment = {
                DATABASE_URL = "postgresql://${cfg.database}@/${cfg.database}?host=/run/postgresql";
                HOST = "127.0.0.1";
                PORT = toString server.port;
                DATABASE_POOL_SIZE = toString cfg.databasePoolSize;
                # Bun caches large transpiled files under the home folder; the bundle needs no cache.
                BUN_RUNTIME_TRANSPILER_CACHE_PATH = "0";
              };
              # Ten starts in 10 minutes (a failed migration, a crash loop) stop the
              # restarts. Five was too few: a single crash after a few deliberate
              # restarts hit the limit and kept the site down.
              startLimitIntervalSec = 600;
              startLimitBurst = 10;
              serviceConfig = hardening // {
                Type = "exec";
                # Every server runs as the same dynamic user, whose name is the database role.
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
                # When memory runs out, the kernel stops a server before
                # PostgreSQL, Tailscale or the journal, and systemd starts it again.
                OOMScoreAdjust = 500;
              };
            }
          ) servers
        );
      }

      {
        # The proxy on the port that the tunnel targets. It sends each request
        # to the next server, and to another one when the connection fails, so
        # a server that restarts loses no request: agentsplit-restart refuses
        # nginx's connections to it before it stops, and a refused connection
        # carried no request. A request that reached a server is never sent
        # again, which keeps a POST from running twice.
        services.nginx = {
          enable = true;
          # A change of the configuration reloads nginx, which keeps its
          # connections; only a new nginx package restarts it.
          enableReload = true;
          # The receipt limit (LIMITS.receiptBytes) is the server's to enforce.
          clientMaxBodySize = "16m";
          upstreams.agentsplit = {
            servers = lib.listToAttrs (
              map (server: lib.nameValuePair "127.0.0.1:${toString server.port}" { max_fails = 0; }) servers
            );
            # A new connection for each request. nginx keeps connections to
            # the servers open since 1.29, and a stopping server closes the
            # idle ones: a POST that nginx had just written to one failed
            # with 502, and nginx does not send it again.
            extraConfig = "keepalive 0;";
          };
          # No access log: the proxy keeps no record of addresses (PRIVACY.md).
          commonHttpConfig = ''
            access_log off;
            underscores_in_headers on;
            large_client_header_buffers 4 32k;
          '';
          virtualHosts.agentsplit = {
            default = true;
            listen = [
              {
                addr = "127.0.0.1";
                inherit (cfg) port;
              }
            ];
            locations."/" = {
              proxyPass = "http://agentsplit";
              # The request goes on as cloudflared sent it: its Host, and
              # X-Forwarded-For with the one client address, which Better
              # Auth's limits need (DEPLOYMENT.md, "Deploy").
              extraConfig = ''
                proxy_set_header Host $host;
                proxy_http_version 1.1;
                proxy_redirect off;
                # The responses stream: MCP's event streams and the ZIP export.
                proxy_buffering off;
                # Room for the response headers (the cookies and the content security policy).
                proxy_buffer_size 32k;
                proxy_buffers 4 32k;
                proxy_next_upstream error timeout;
                proxy_next_upstream_tries 0;
                proxy_connect_timeout 5s;
                # The servers close idle connections after 60 seconds themselves (server.ts).
                proxy_read_timeout 1h;
                proxy_send_timeout 1h;
              '';
            };
          };
        };
        systemd.services.nginx.serviceConfig = {
          MemoryMax = "64M";
          # The proxy is the one way in, so the kernel stops a server first.
          OOMScoreAdjust = -100;
        };

        # Root runs it, as deploy-host does after a switch (DEPLOYMENT.md, "Deploy").
        environment.systemPackages = [ restartScript ];
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
        systemd.services = lib.listToAttrs (
          map (
            tunnel:
            lib.nameValuePair tunnel.name {
              description = "Cloudflare Tunnel connector for AgentSplit";
              wantedBy = [ "multi-user.target" ];
              after = [ "network-online.target" ];
              wants = [ "network-online.target" ];
              # As the servers: agentsplit-restart restarts the connectors one at a time.
              restartIfChanged = false;
              environment.TUNNEL_EDGE_IP_VERSION = cfg.tunnel.edgeIpVersion;
              serviceConfig = hardening // {
                Type = "notify";
                EnvironmentFile = cfg.tunnel.environmentFile;
                # TUNNEL_TOKEN comes from the file. Cloudflare updates cloudflared
                # through the flake, never in place. /ready on the metrics port
                # answers 200 while the connector has a connection to the edge.
                # On SIGTERM it stops taking requests and lets the running ones
                # finish for up to 30 seconds.
                ExecStart = "${lib.getExe pkgs.cloudflared} tunnel --no-autoupdate --metrics 127.0.0.1:${toString tunnel.metricsPort} run";
                Restart = "always";
                RestartSec = 5;
                RestrictAddressFamilies = [
                  "AF_UNIX"
                  "AF_INET"
                  "AF_INET6"
                  "AF_NETLINK"
                ];
                MemoryMax = "96M";
                TasksMax = 64;
                # Second after the servers: it restarts in seconds.
                OOMScoreAdjust = 300;
              };
            }
          ) tunnels
        );
      })
    ]
  );
}
