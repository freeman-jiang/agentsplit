{
  description = "AgentSplit dev shell (v2 and the current app)";

  # Same revision as ~/dots/flake.lock, so the shell reuses the box's packages.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/7dcdd87373d72e7a2173e4db02e20d3d7f495cfd";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (
        pkgs:
        let
          postgresql = pkgs.postgresql_18;

          # nixpkgs has prisma-engines 7.8.0, but the lockfile pins prisma 7.10.0,
          # and the Prisma CLI has no build for NixOS. Fetch the schema engine of
          # the exact pinned commit (node_modules/@prisma/engines-version). It is
          # a glibc binary and runs through nix-ld. Update it with prisma.
          prismaEngines = {
            aarch64-linux = {
              target = "linux-arm64-openssl-3.0.x";
              hash = "sha256-N2hm95+IPneCBxkcQBNRi9ltgqvhgfXDfO1hZpi8jYg=";
            };
            x86_64-linux = {
              target = "debian-openssl-3.0.x";
              hash = "sha256-tyELUlpuWSwNXbfn1I7bwPM04U4hKvevEcDUqN51WjE=";
            };
          };
          prismaEngine = prismaEngines.${pkgs.stdenv.hostPlatform.system};
          schema-engine = pkgs.runCommand "prisma-schema-engine" { } ''
            install -Dm755 ${
              pkgs.fetchurl {
                url = "https://binaries.prisma.sh/all_commits/0edf323efd1d98336f3f0a68684b56f689b900d3/${prismaEngine.target}/schema-engine.gz";
                inherit (prismaEngine) hash;
              }
            } $out/schema-engine.gz
            ${pkgs.gzip}/bin/gunzip $out/schema-engine.gz
          '';

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

          # Drops and recreates one database. Refuses names without test, e2e,
          # perf or dev, so it never runs against anything that matters.
          db-reset = pkgs.writeShellApplication {
            name = "db-reset";
            runtimeInputs = [ postgresql ];
            text = ''
              name="''${1:?usage: db-reset <database>}"
              case "$name" in
                *test* | *e2e* | *perf* | *dev*) ;;
                *)
                  echo "db-reset: refusing to reset '$name'" >&2
                  exit 1
                  ;;
              esac
              dropdb --if-exists --force "$name"
              createdb "$name"
            '';
          };
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_26
              pkgs.bun
              postgresql
              pkgs.chromium
              # scripts/e2e.sh runs Garage and the v2 image through the Podman socket.
              pkgs.docker-compose
              db-start
              db-stop
              db-reset
            ];

            shellHook = ''
              export PGDATA="$PWD/.pg"
              export PGHOST=127.0.0.1
              export PGPORT=5437
              export PGUSER=postgres
              export PGSOCKETDIR=/tmp/agentsplit-pg
              export POSTGRES_PRISMA_URL="postgresql://postgres@127.0.0.1:5437/agentsplit_dev"
              export POSTGRES_URL_NON_POOLING="$POSTGRES_PRISMA_URL"
              export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="${pkgs.chromium}/bin/chromium"
              export NEXT_TELEMETRY_DISABLED=1
              export CHECKPOINT_DISABLE=1
              export PRISMA_SCHEMA_ENGINE_BINARY="${schema-engine}/schema-engine"
            '';
          };
        }
      );
    };
}
