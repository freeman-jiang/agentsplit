{
  description = "AgentSplit: the dev shell, the package, and the NixOS host";

  # The revision that ~/dots/flake.lock pinned when this was set. Dots moves its own
  # pin, so the two can differ; bump this one only on purpose. It also fixes Bun,
  # which the Dockerfile images and @types/bun follow (scripts/check-bun-version.ts).
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/7dcdd87373d72e7a2173e4db02e20d3d7f495cfd";
  # The operating system of the host (nix/host). It is locked at the same revision
  # as nixpkgs; deploy-host moves it to the head of its release branch
  # (hostNixpkgs below), while the app keeps the Bun of nixpkgs.
  inputs.nixpkgs-host.url = "github:NixOS/nixpkgs/nixos-26.05";
  # The disk layout for nixos-anywhere installs (nix/host/disk.nix).
  inputs.disko = {
    url = "github:nix-community/disko";
    inputs.nixpkgs.follows = "nixpkgs-host";
  };

  outputs =
    {
      self,
      nixpkgs,
      nixpkgs-host,
      disko,
    }:
    let
      systems = [
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # The release branch that the host's operating system follows. When it
      # nears its end of life, move this and nixpkgs-host to the next release.
      hostNixpkgs = "github:NixOS/nixpkgs/nixos-26.05";
      # The commit that `deploy-host --update` rebuilds. A build from a tree
      # with uncommitted changes has none.
      agentsplitRev = self.rev or null;

      # services.agentsplit with this flake's build of the app.
      agentsplitModule =
        { lib, pkgs, ... }:
        {
          imports = [ ./nix/module.nix ];
          services.agentsplit.package = lib.mkDefault self.packages.${pkgs.stdenv.hostPlatform.system}.agentsplit;
        };
      hostModules = [
        disko.nixosModules.disko
        agentsplitModule
        ./nix/host
      ];
      hostArgs = { inherit agentsplitRev; };
      # The host on one provider: its system and its hardware profile.
      mkHost =
        { system, profile }:
        nixpkgs-host.lib.nixosSystem {
          modules = hostModules ++ [
            profile
            { nixpkgs.hostPlatform = system; }
          ];
          specialArgs = hostArgs;
        };
    in
    {
      packages =
        nixpkgs.lib.recursiveUpdate
          (forAllSystems (pkgs: {
            agentsplit = pkgs.callPackage ./nix/package.nix { };
            default = self.packages.${pkgs.stdenv.hostPlatform.system}.agentsplit;
          }))
          {
            # The boot image of the production host, which the dots side
            # imports into GCE (DEPLOYMENT.md, "First install").
            x86_64-linux.agentsplit-gce-image =
              self.nixosConfigurations.agentsplit.config.system.build.googleComputeImage;
          };

      nixosModules.default = agentsplitModule;

      # The production host (DEPLOYMENT.md, "The host"): an e2-micro on GCE.
      nixosConfigurations.agentsplit = mkHost {
        system = "x86_64-linux";
        profile = {
          imports = [ ./nix/host/gce.nix ];
          # The dev box (aarch64) builds the image (nix/host/gce.nix).
          agentsplit.imageBuildPackages = nixpkgs-host.legacyPackages.aarch64-linux;
        };
      };
      # The same host on EC2 (a t4g.small), the documented alternative.
      nixosConfigurations.agentsplit-ec2 = mkHost {
        system = "aarch64-linux";
        profile = ./nix/host/ec2.nix;
      };

      # The production host's modules in a VM, without the tunnel. It runs on
      # aarch64, the dev box's system, because an x86_64 VM there has no KVM
      # and would emulate every instruction. Only the platform differs from
      # production.
      checks.aarch64-linux.host = import ./nix/vm-test.nix {
        pkgs = nixpkgs-host.legacyPackages.aarch64-linux;
        hostModules = hostModules ++ [ ./nix/host/gce.nix ];
        inherit hostArgs;
      };

      devShells = forAllSystems (
        pkgs:
        let
          postgresql = pkgs.postgresql_18;

          # Loopback-only Postgres with trust auth, data in .pg/ of the checkout. It runs
          # in UTC like production; the box timezone breaks the history
          # timestamps.
          db-start = pkgs.writeShellApplication {
            name = "db-start";
            runtimeInputs = [ postgresql ];
            text = ''
              if [ ! -f "$PGDATA/PG_VERSION" ]; then
                initdb --username=postgres --auth=trust --encoding=UTF8 --no-locale "$PGDATA" >/dev/null
              fi
              if pg_ctl status >/dev/null 2>&1; then
                exit 0
              fi
              mkdir -p "$PGSOCKETDIR"
              pg_ctl start -w -l "$PGDATA/server.log" \
                -o "-c listen_addresses=127.0.0.1 -c timezone=UTC -p $PGPORT -k $PGSOCKETDIR -c fsync=off -c synchronous_commit=off -c full_page_writes=off"
            '';
          };

          db-stop = pkgs.writeShellApplication {
            name = "db-stop";
            runtimeInputs = [ postgresql ];
            text = ''
              if pg_ctl status >/dev/null 2>&1; then
                pg_ctl stop -w -m fast
              fi
            '';
          };

          # Drops and recreates one database. It accepts only a disposable name and
          # refuses the databases the maintainer uses (db/local-databases.json, which the
          # test kit and scripts/seed-synthetic.ts also read).
          databases = builtins.fromJSON (builtins.readFile ./db/local-databases.json);
          db-reset = pkgs.writeShellApplication {
            name = "db-reset";
            runtimeInputs = [ postgresql ];
            text = ''
              name="''${1:?usage: db-reset <database>}"
              case "$name" in
                ${pkgs.lib.concatMapStringsSep " | " pkgs.lib.escapeShellArg databases.protected})
                  echo "db-reset: refusing to reset '$name': the maintainer uses it (docs/BUILDING.md)" >&2
                  exit 1
                  ;;
                ${pkgs.lib.concatMapStringsSep " | " (part: "*${part}*") databases.disposable}) ;;
                *)
                  echo "db-reset: refusing to reset '$name'" >&2
                  exit 1
                  ;;
              esac
              dropdb --if-exists --force "$name"
              createdb "$name"
            '';
          };

          # Builds the host on this machine and switches the host to it over
          # Tailscale SSH (DEPLOYMENT.md, "Deploy"). The new system first
          # runs without becoming the boot default; it becomes the default only
          # after the health check passes, so a reboot undoes a bad deploy.
          deploy-host = pkgs.writeShellApplication {
            name = "deploy-host";
            # The store paths in the remote commands expand here on purpose.
            excludeShellChecks = [ "SC2029" ];
            text = builtins.replaceStrings [ "@hostNixpkgs@" ] [ hostNixpkgs ] (builtins.readFile ./nix/deploy-host.sh);
          };
        in
        {
          default = pkgs.mkShell {
            packages = [
              # Vitest and Playwright run on Node (their bins start with `env node`); the server runs on Bun.
              pkgs.nodejs_26
              pkgs.bun
              postgresql
              pkgs.chromium
              # scripts/e2e.sh runs Garage and the app image through the Podman socket.
              pkgs.docker-compose
              db-start
              db-stop
              db-reset
              deploy-host
            ];

            shellHook = ''
              export PGDATA="$PWD/.pg"
              export PGHOST=127.0.0.1
              export PGPORT=5437
              export PGUSER=postgres
              export PGSOCKETDIR=/tmp/agentsplit-pg
              export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="${pkgs.chromium}/bin/chromium"
            '';
          };
        }
      );
    };
}
