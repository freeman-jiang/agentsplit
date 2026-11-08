# Boots the host configuration in a VM of the host's size, without the tunnel
# and Tailscale, and checks that PostgreSQL and the server start, the
# migrations apply, the health check answers, and the dumps work.
#   nix build .#checks.aarch64-linux.host
{
  pkgs,
  hostModules,
  hostArgs,
}:
let
  migrations = (builtins.fromJSON (builtins.readFile ../db/migrations/meta/_journal.json)).entries;
in
pkgs.testers.runNixOSTest {
  name = "agentsplit-host";
  node.specialArgs = hostArgs;
  nodes.host =
    { lib, ... }:
    {
      imports = hostModules;
      services.agentsplit.tunnel.enable = lib.mkForce false;
      services.tailscale.enable = lib.mkForce false;
      # The test VM's root is a whole disk without a partition to grow.
      boot.growPartition = lib.mkForce false;
      # The VM has no network, and a commit's build would turn the upgrade timer on.
      system.autoUpgrade.enable = lib.mkForce false;
      virtualisation.memorySize = 2048;
      virtualisation.cores = 2;
      # Test-only values. Production keeps this file out of the store (DEPLOYMENT.md).
      environment.etc."agentsplit/agentsplit.env" = {
        mode = "0400";
        text = ''
          BASE_URL=https://agentsplit.test
          BETTER_AUTH_SECRET=vm-test-secret-that-is-at-least-32-characters
          GOOGLE_CLIENT_ID=vm-test-client
          GOOGLE_CLIENT_SECRET=vm-test-client-secret
          S3_UPLOAD_ENDPOINT=http://127.0.0.1:3900
          S3_UPLOAD_REGION=auto
          S3_UPLOAD_BUCKET=agentsplit-receipts
          S3_UPLOAD_KEY=vm-test-key
          S3_UPLOAD_SECRET=vm-test-secret
        '';
      };
    };

  testScript = ''
    host.wait_for_unit("postgresql.service")
    host.wait_for_unit("agentsplit.service")
    host.wait_until_succeeds("curl -fsS http://127.0.0.1:3000/api/health", timeout=120)
    host.succeed("journalctl -u agentsplit.service | grep -q 'Migrations applied'")
    host.wait_for_unit("multi-user.target")
    failed = host.succeed("systemctl --failed --no-legend --plain")
    assert failed.strip() == "", failed

    applied = host.succeed("sudo -u postgres psql -At -d agentsplit -c 'select count(*) from drizzle.__drizzle_migrations'")
    assert int(applied) == ${toString (builtins.length migrations)}, f"{applied.strip()} migrations applied"
    # The tables belong to the server's role, so a restore with --role keeps them usable.
    owner = host.succeed("sudo -u postgres psql -At -d agentsplit -c \"select tableowner from pg_tables where tablename = 'groups'\"")
    assert owner.strip() == "agentsplit", owner

    # The client build is served, and only on the loopback interface.
    host.succeed("curl -fsS http://127.0.0.1:3000/ | grep -q '<div id=\"root\"'")
    listeners = host.succeed("ss -Htln").strip().splitlines()
    exposed = [line for line in listeners if not any(a in line for a in ["127.0.0.1:", "[::1]:", "127.0.0.53"])]
    assert exposed == [], exposed

    # The server runs as its dynamic user with the hardening of nix/module.nix.
    host.succeed("systemctl show -p User -p DynamicUser -p ProtectSystem agentsplit.service | grep -c -x -e User=agentsplit -e DynamicUser=yes -e ProtectSystem=strict | grep -q 3")
    print(host.succeed("systemd-analyze security agentsplit.service agentsplit-db-dump.service --no-pager | tail -n 3"))

    # A dump, read back by the backup user, who has no database access.
    host.succeed("systemctl start agentsplit-db-dump.service")
    host.succeed("sudo -u agentsplit-backup agentsplit-latest-dump > /tmp/latest.dump")
    host.succeed("head -c 5 /tmp/latest.dump | grep -q PGDMP")
    host.succeed("sudo -u postgres pg_restore --list /tmp/latest.dump | grep -q 'TABLE public groups'")
    host.fail("sudo -u agentsplit-backup psql -d agentsplit -c 'select 1'")

    # The restore of DEPLOYMENT.md ("Move the data from Oracle"): a dump into a
    # new database, as the server's role, and a start without new migrations.
    host.succeed("systemctl stop agentsplit.service")
    host.succeed("sudo -u postgres dropdb agentsplit")
    host.succeed("sudo -u postgres createdb --owner=agentsplit agentsplit")
    host.succeed("sudo -u postgres pg_restore --no-owner --no-acl --role=agentsplit --exit-on-error --dbname=agentsplit < /tmp/latest.dump")
    host.succeed("systemctl start agentsplit.service")
    host.wait_until_succeeds("curl -fsS http://127.0.0.1:3000/api/health", timeout=120)
    owner = host.succeed("sudo -u postgres psql -At -d agentsplit -c \"select count(*) from pg_tables where schemaname = 'public' and tableowner <> 'agentsplit'\"")
    assert int(owner) == 0, f"{owner.strip()} tables not owned by agentsplit after the restore"

    # The memory budget of DEPLOYMENT.md, for the record.
    print(host.succeed("systemctl show -p Id -p MemoryCurrent -p MemoryPeak agentsplit.service postgresql.service; free -m"))

  '';
}
