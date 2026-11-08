{
  description = "AgentSplit dev shell";

  # The revision that ~/dots/flake.lock pinned when this was set. Dots moves its own
  # pin, so the two can differ; bump this one only on purpose. It also fixes Bun,
  # which the Dockerfile images and @types/bun follow (scripts/check-bun-version.ts).
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
