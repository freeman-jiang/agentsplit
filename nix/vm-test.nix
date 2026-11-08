# Boots the host configuration in a VM of the host's size, without the
# tunnel, and checks that PostgreSQL and the server start, the migrations
# apply, the health check answers, the dumps work, and the first join polls
# the GCE metadata for the Tailscale auth key without a trace of the key on
# disk or in the journal. Tailscale runs, but it cannot log in without a
# network.
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
      # The test VM's root is a whole disk without a partition to grow.
      boot.growPartition = lib.mkForce false;
      # The e2-micro: 1 GB and 2 shared CPUs.
      virtualisation.memorySize = 1024;
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
    print(host.succeed("systemctl show -p Id -p MemoryCurrent -p MemoryPeak agentsplit.service postgresql.service systemd-journald.service tailscaled.service; free -m"))

    # When memory runs out, the kernel stops the server before PostgreSQL and the journal.
    def oom_score_adj(unit):
        pid = host.succeed(f"systemctl show -p MainPID --value {unit}").strip()
        return int(host.succeed(f"cat /proc/{pid}/oom_score_adj"))
    server, database, journal = (oom_score_adj(u) for u in ["agentsplit", "postgresql", "systemd-journald"])
    assert server > database and server > journal, (server, database, journal)

    # The first join (nix/host/gce.nix), with a stand-in metadata server:
    # the unit polls while Tailscale needs a login, and passes a key to
    # `tailscale up` without writing it anywhere.
    host.wait_until_succeeds("tailscale status --json --peers=false | jq -e '.BackendState == \"NeedsLogin\"'", timeout=60)
    host.succeed("systemctl is-active agentsplit-tailscale-join.service")
    attributes = "/tmp/metadata/computeMetadata/v1/instance/attributes"
    host.succeed(f"ip addr add 169.254.169.254/32 dev lo && mkdir -p {attributes}")
    host.succeed("${pkgs.busybox}/bin/busybox httpd -p 169.254.169.254:80 -h /tmp/metadata")
    # A restart starts the pauses again from 5 seconds.
    host.succeed("systemctl restart agentsplit-tailscale-join.service")
    host.wait_until_succeeds("journalctl -b -u agentsplit-tailscale-join | grep -q 'no auth key in the metadata yet (404)'", timeout=60)
    host.succeed(f"printf tskey-vm-test-c4f1e2 > {attributes}/tailscale-auth-key")
    host.wait_until_succeeds("journalctl -b -u agentsplit-tailscale-join | grep -q 'tailscale up failed'", timeout=180)
    print(host.succeed("journalctl -b -u agentsplit-tailscale-join --no-pager -o cat"))
    host.succeed("systemctl is-active agentsplit-tailscale-join.service")
    host.fail("journalctl -b --no-pager | grep -F tskey-vm-test-c4f1e2")
    host.fail("grep -rlF tskey-vm-test-c4f1e2 /etc /var /root /run 2>/dev/null")
  '';
}
