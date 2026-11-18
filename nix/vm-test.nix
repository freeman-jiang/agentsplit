# Boots the host configuration in a VM of the host's size, without the
# tunnel, and checks that PostgreSQL, the two servers and nginx start, the
# servers migrate once, the health check answers, the dumps work, a deploy
# loses no request, the hourly job runs on one server, and the first join
# polls the GCE metadata for the Tailscale auth key without a trace of the key
# on disk or in the journal. Tailscale runs, but it cannot log in without a
# network, and cloudflared cannot connect to Cloudflare's edge.
#   nix build .#checks.aarch64-linux.host
{
  pkgs,
  hostModules,
  hostArgs,
}:
let
  migrations = (builtins.fromJSON (builtins.readFile ../db/migrations/meta/_journal.json)).entries;

  # probe <name> <curl arguments...>: one request after another until
  # /run/probe/stop exists, with one status per line in /run/probe/<name>;
  # 000 is a failed connection or no answer in 30 seconds.
  probe = pkgs.writeShellScript "probe" ''
    out=/run/probe/$1
    shift
    while [ ! -e /run/probe/stop ]; do
      ${pkgs.curl}/bin/curl -s -o /dev/null -w '%{http_code}\n' --max-time 30 "$@" >> "$out" || true
    done
  '';
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
      # A deploy: the same host with changed server units and a changed
      # nginx configuration, which the test switches to as deploy-host does.
      specialisation.deploy.configuration = {
        services.agentsplit.memoryHigh = lib.mkForce "232M";
        services.nginx.appendHttpConfig = "# deploy";
      };
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
    import collections, time

    servers = ["agentsplit-server-1", "agentsplit-server-2"]
    host.wait_for_unit("postgresql.service")
    for unit in [*servers, "nginx.service"]:
        host.wait_for_unit(unit)
    for port in [3000, 3001, 3002]:
        host.wait_until_succeeds(f"curl -fsS http://127.0.0.1:{port}/api/health", timeout=120)
    host.wait_for_unit("multi-user.target")
    failed = host.succeed("systemctl --failed --no-legend --plain")
    assert failed.strip() == "", failed
    # The two servers started together on an empty database. One applied the
    # migrations under the lock, the other waited and found none left, and
    # neither failed its start.
    for unit in servers:
        host.succeed(f"journalctl -u {unit} | grep -q 'Migrations applied'")
        restarts = host.succeed(f"systemctl show -p NRestarts --value {unit}").strip()
        assert restarts == "0", f"{unit} restarted {restarts} times"

    applied = host.succeed("sudo -u postgres psql -At -d agentsplit -c 'select count(*) from drizzle.__drizzle_migrations'")
    assert int(applied) == ${toString (builtins.length migrations)}, f"{applied.strip()} migrations applied"
    # The tables belong to the server's role, so a restore with --role keeps them usable.
    owner = host.succeed("sudo -u postgres psql -At -d agentsplit -c \"select tableowner from pg_tables where tablename = 'groups'\"")
    assert owner.strip() == "agentsplit", owner

    # The client build is served through the proxy, and only on the loopback interface.
    host.succeed("curl -fsS http://127.0.0.1:3000/ | grep -q '<div id=\"root\"'")
    listeners = host.succeed("ss -Htln").strip().splitlines()
    exposed = [line for line in listeners if not any(a in line for a in ["127.0.0.1:", "[::1]:", "127.0.0.53"])]
    assert exposed == [], exposed

    # The servers run as their dynamic user with the hardening of nix/module.nix.
    for unit in servers:
        host.succeed(f"systemctl show -p User -p DynamicUser -p ProtectSystem {unit} | grep -c -x -e User=agentsplit -e DynamicUser=yes -e ProtectSystem=strict | grep -q 3")
    print(host.succeed("systemd-analyze security agentsplit-server-1.service agentsplit-db-dump.service --no-pager | tail -n 3"))

    # A dump, read back by the backup user, who has no database access.
    host.succeed("systemctl start agentsplit-db-dump.service")
    host.succeed("sudo -u agentsplit-backup agentsplit-latest-dump > /tmp/latest.dump")
    host.succeed("head -c 5 /tmp/latest.dump | grep -q PGDMP")
    host.succeed("sudo -u postgres pg_restore --list /tmp/latest.dump | grep -q 'TABLE public groups'")
    host.fail("sudo -u agentsplit-backup psql -d agentsplit -c 'select 1'")

    # The restore of DEPLOYMENT.md ("Restore a dump on the host"): a dump into a
    # new database, as the server's role, and a start without new migrations.
    host.succeed("systemctl stop 'agentsplit-server-*'")
    host.succeed("sudo -u postgres dropdb agentsplit")
    host.succeed("sudo -u postgres createdb --owner=agentsplit agentsplit")
    host.succeed("sudo -u postgres pg_restore --no-owner --no-acl --role=agentsplit --exit-on-error --dbname=agentsplit < /tmp/latest.dump")
    host.succeed("agentsplit-restart")
    owner = host.succeed("sudo -u postgres psql -At -d agentsplit -c \"select count(*) from pg_tables where schemaname = 'public' and tableowner <> 'agentsplit'\"")
    assert int(owner) == 0, f"{owner.strip()} tables not owned by agentsplit after the restore"

    # A deploy under load, as deploy-host runs it on the host: probes send
    # requests through nginx (where cloudflared sends them) the whole time,
    # GET and POST, while the system switches to new server units and a new
    # nginx configuration, and agentsplit-restart restarts the servers one at
    # a time. No request may fail.
    def main_pid(unit):
        return host.succeed(f"systemctl show -p MainPID --value {unit}").strip()
    def server_pids():
        return [main_pid(unit) for unit in servers]

    probes = {
        "get-health": "http://127.0.0.1:3000/api/health",
        "post-health": "-X POST --data-binary probe http://127.0.0.1:3000/api/health",
        "get-page": "http://127.0.0.1:3000/",
    }
    host.succeed("mkdir -p /run/probe")
    for name, arguments in probes.items():
        host.succeed(f"systemd-run --unit=probe-{name} ${probe} {name} {arguments}")
    host.wait_until_succeeds("test -s /run/probe/get-health -a -s /run/probe/post-health -a -s /run/probe/get-page")
    time.sleep(3)

    def reloads():
        return host.succeed("systemctl show -p InvocationID -p Result nginx-config-reload").split()
    previous = host.succeed("readlink -f /run/current-system").strip()
    before, proxy, reload = server_pids(), main_pid("nginx"), reloads()
    host.succeed(f"{previous}/specialisation/deploy/bin/switch-to-configuration test")
    # The switch left the servers running, and reloaded nginx with its new configuration without a restart.
    assert server_pids() == before, (before, server_pids())
    assert main_pid("nginx") == proxy
    host.succeed("grep -q '# deploy' /etc/nginx/nginx.conf")
    assert reloads() != reload and "Result=success" in reloads(), (reload, reloads())
    # The restarts of deploy-host: each server whose unit changed, one at a time.
    restarts = host.succeed(f"agentsplit-restart --changed-from {previous}")
    print(restarts)
    # The drain matched nginx's connections: nginx tried the drained server and was refused.
    refused = [int(line.split()[-1]) for line in restarts.splitlines() if "the drain refused nginx packets" in line]
    assert len(refused) == 2 and all(n > 0 for n in refused), restarts
    after = server_pids()
    assert all(a != b for a, b in zip(before, after)), (before, after)
    # A system without changes restarts nothing.
    assert host.succeed("agentsplit-restart --changed-from /run/current-system").strip() == ""
    assert server_pids() == after
    # A changed secret file restarts every server, also one at a time.
    print(host.succeed("agentsplit-restart"))
    time.sleep(3)

    host.succeed("touch /run/probe/stop")
    for name in probes:
        host.wait_until_fails(f"systemctl is-active probe-{name}")
    results = {name: collections.Counter(host.succeed(f"cat /run/probe/{name}").split()) for name in probes}
    for name, statuses in results.items():
        print(f"probe {name}: {sum(statuses.values())} requests, statuses {dict(statuses)}")
    failures = {name: {s: n for s, n in statuses.items() if s != "200"} for name, statuses in results.items()}
    assert all(not f for f in failures.values()), failures

    # Two servers, one run of the hourly job: both schedule it at minute 7,
    # one takes the lock, and the other skips it. The clock moves to 30
    # seconds before minute 7, and the servers start again to plan from it.
    host.succeed("date -u -s \"$(date -u +%Y-%m-%d) $(date -u +%H):06:30\"")
    host.succeed("systemctl restart 'agentsplit-server-*'")
    for port in [3001, 3002]:
        host.wait_until_succeeds(f"curl -fsS http://127.0.0.1:{port}/api/health", timeout=60)
    invocations = " ".join(f"_SYSTEMD_INVOCATION_ID={host.succeed(f'systemctl show -p InvocationID --value {unit}').strip()}" for unit in servers)
    skipped = f"journalctl --no-pager -o cat {invocations} | grep -c 'Hourly job: another server runs it' || true"
    host.wait_until_succeeds(f"[ $({skipped}) -ge 1 ]", timeout=90)
    time.sleep(5)
    assert host.succeed(skipped).strip() == "1", host.succeed(f"journalctl --no-pager -o cat {invocations}")

    # The memory budget of DEPLOYMENT.md, for the record.
    print(host.succeed("systemctl show -p Id -p MemoryCurrent -p MemoryPeak agentsplit-server-1.service agentsplit-server-2.service nginx.service postgresql.service systemd-journald.service tailscaled.service; free -m"))

    # When memory runs out, the kernel stops a server before nginx, PostgreSQL and the journal.
    def oom_score_adj(unit):
        return int(host.succeed(f"cat /proc/{main_pid(unit)}/oom_score_adj"))
    server, proxy, database, journal = (oom_score_adj(u) for u in ["agentsplit-server-1", "nginx", "postgresql", "systemd-journald"])
    assert server > proxy > database > journal, (server, proxy, database, journal)

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
