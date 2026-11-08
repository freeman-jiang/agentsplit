# Capacity

This document states how many monthly active people one small VM can host, and how to measure it again. `scripts/capacity.ts` makes the measurement. The target is the production host of [DEPLOYMENT.md](../DEPLOYMENT.md): a GCE e2-micro with 2 shared vCPUs at about a quarter of a core sustained, 1 GB of memory, a 30 GB pd-standard disk, and 1 GB of free data out each month.

## Latest results

The runs of 2026-11-08 on the deployed code (`f03236d`), with the production host's calibration score of 1855, and the free tier alone: no backups are counted (the default).

| Limit, monthly active people | Typical (`--profile typical`) | Heavy (`--profile heavy`) |
| --- | ---: | ---: |
| Sustained CPU, a quarter of a core, busiest hour 3 × the average | 127,884 | 33,443 |
| Disk, 20 GB, after a year of data | 163,840 | 33,098 |
| Page cache, 400 MB, after a year of data | 8,533 | 1,765 |
| Free data out, 1 GB a month | 6,699 | 1,595 |

- **Typical person**: 8 app opens, 3 new expenses (1 in the web form, 2 by an agent), and 2 agent sessions with 6 reads, each month.
- **Heavy person**: 30 app opens, 15 new expenses (5 in the web form, 10 by an agent), and 10 agent sessions with 30 reads, each month.
- **The VM's first limit is the page cache.** Each balance sums all of its group's payer and share rows (`ledgerParts` in `src/server/balances.ts`), so a year of those tables must stay in memory. CPU and disk bind much later.
- **Data out past the free 1 GB is cheap:** about $0.12 per GB.
- **Backups:** to count the production host's backups, pass `--backup-pulls 30 --dumps-kept 72 --dumps-per-month 720`.

The exact output, typical profile (`bun scripts/capacity.ts --profile typical --target-score 1855`):

```text
direnv: loading ~/projects/agentsplit/.envrc
direnv: using flake
direnv: nix-direnv: Using cached dev shell
[capacity] Calibrating this machine
[capacity] Reading the production host settings from the flake
[capacity] Building (bun run build)
[capacity] Starting PostgreSQL 18.6 settings in /tmp/agentsplit-capacity-fhyOYZ
[capacity] Seeding 60 people
[capacity] Starting the server (bun --no-install dist/server/server.js)
[capacity] Warming up
[capacity] Measuring 20 s of idle time
[capacity] Phase "app open": 420 units
[capacity] Phase "app open + new expense": 60 units
[capacity] Phase "agent connect": 120 units
[capacity] Phase "agent read": 360 units
[capacity] Phase "agent new expense": 120 units
[capacity] Waiting for the background work to finish
AgentSplit capacity benchmark, 2026-11-08T19:27Z, commit f03236d
People: 60 in 16 groups (4 6 4 3 2 5 2 6 5 6 2 2 4 2 4 6 people); seeded expenses per group: 468 11 32 14 27 39 51 47 38 16 387 33 48 35 51 51
Seeded data: 5.1 MB in tables, 87.3 KB per person
Server: the production build on Bun 1.3.13, pool 5; PostgreSQL 18.6 with the host's settings (shared_buffers 64MB, fsync on)
Clients: 6 at a time; Chromium for app opens, fetch for MCP. Static files come from the edge stand-in, as from Cloudflare's cache.

This machine: 4716 units/s (best of 7 rounds)
Rounds: 4414 4653 4613 4703 4609 4629 4716
Machine: arm64, 0xd4f, Bun 1.3.13
CPU scale: 2.54 = 4716 here / 1855 on the target

The month of one person, profile "typical" (assumed; flags change it):
  8 app opens (dashboard, Groups, the group's expenses), 1 of them add an expense in the form
  2 agent sessions (initialize, initialized, GET stream, tools/list), 6 reads (list_groups, get_group, list_expenses, get_balances in turn), 2 create_expense
  3 new expenses, text notes only, no receipts

Measured cost of each unit (CPU on this machine, bytes leaving the origin with headers):
Unit                    Units  Requests/unit  Bun ms/unit  PG ms/unit  KB/unit  Per month
----------------------  -----  -------------  -----------  ----------  -------  ---------
app open                  420            9.0         50.8        15.3    11.57          7
app open + new expense     60           13.8         82.8        25.0    19.07          1
agent connect             120            4.0          8.9         1.7    16.13          2
agent read                360            1.0          2.4         1.4     1.17          6
agent new expense         120            1.0          6.0         3.6     0.69          2

Each request at the origin (Accept-Encoding: gzip; bytes include the status line and headers):
Request                                              Count  Status  Headers B  Body B  Unzipped B  Gzip  p50 ms
---------------------------------------------------  -----  ------  ---------  ------  ----------  ----  ------
auth get-session                                       480     200        254     468         468    0%       7
mcp GET                                                120     405        278      83          83    0%       8
mcp initialize                                         120     200        332   2,162       4,652  100%       9
mcp notifications/initialized                          120     202        208       0           0    0%       9
mcp tools/call create_expense                          120     200        284     422         422    0%      20
mcp tools/call get_balances                             60     200        322     511       1,362   80%      12
mcp tools/call get_group                               120     200        331     829       3,225  100%      11
mcp tools/call list_expenses                            60     200        332   1,868      21,585  100%      14
mcp tools/call list_groups                             120     200        286     624         657    5%      10
mcp tools/list                                         120     200        333  13,116      90,572  100%      11
page (SPA document)                                    480     304        690       0           0    0%       1
rpc balances.list                                      480     200        297     689         689    0%       4
rpc expenses.create                                     60     200        297     852         852    0%      11
rpc expenses.detail                                     48     200        334     599       1,096   79%       4
rpc expenses.list                                      540     200        345   2,490      20,983  100%       5
rpc feed.balances+feed.options                         480     200        344     837       3,057  100%       8
rpc feed.balances+feed.options+feed.list+session.me    261     200        345   3,663      38,291  100%      16
rpc feed.list+session.me                               219     200        345   3,000      35,522  100%      13
rpc groups.directory                                   480     200        297     290         290    0%       4
rpc groups.get                                         480     200        297     439         439    0%       3
rpc groups.get+balances.list                            60     200        335     506       1,130   80%       7
rpc reference.get                                       60     200        345   1,535       5,059  100%       3
rpc session.me                                         480     200        297     137         137    0%       4

Per person-month (measured):
  Requests at the origin: 93
  CPU on this machine: 634 ms (Bun 483, PostgreSQL 151, background after the run 0)
  CPU on the target (x2.54): 1,612 ms
  Bytes from the origin: 140.7 KB; with 64 B per packet (assumed): 156.5 KB
  Database growth, live rows: 10.7 KB (3.6 KB per new expense; expenses, payers and shares 4.0 KB); before VACUUM FULL: 21.7 KB
  Commits 258, WAL 44.9 KB, WAL fsyncs 47, data page writes 16, buffer reads 22,803 (4 from the OS)
  Growth by table: activities 5.1 KB, expense_shares 2.0 KB, expenses 1.6 KB, idempotency_keys 1.6 KB, expense_payers 0.4 KB
  Dump (pg_dump -Fc): 5% of the table bytes; 86 ms CPU for 5.6 MB of tables (63 ms for an empty database)
  Idle: Bun 3.50 ms/s, PostgreSQL 1.00 ms/s on this machine

Capacity in monthly active people:
Limit                             People                                                                                                                    Basis
-------------------------------  -------  -----------------------------------------------------------------------------------------------------------------------
Sustained CPU                    127,884  0.25 cores; 1,612 ms per person-month x peak factor 3 (assumed); idle 11.4 ms/s; hourly dumps of a year of data take 0%
Free data out                      6,699                    1 GB/month; 156.5 KB of traffic + 0.0 KB of backup pulls (0 dumps/month of a year of data) per person
Disk, after one year             163,840                                             20 GB usable (assumed); 128.0 KB of data + 0 dumps (5% each) per person-year
Page cache, after one year         8,533              400 MB (assumed); 48.0 KB per person-year of expenses, payers and shares, which every balance reads in full
Disk writes                      617,469                                                         45 IOPS; 63 WAL fsyncs and page writes per person-month x peak 3
Disk reads, cache empty (floor)      833                         22 IOPS if every buffer read missed the cache; does not bind while the page cache holds the data

Binding limit: Free data out, at about 6,699 monthly active people.
Binding limit of the VM itself (data out paid past the free allowance): Page cache, after one year, at about 8,533.
Backups: none counted (the default). Pass the host schedule to count them: --backup-pulls 30 --dumps-kept 72 --dumps-per-month 720.
Paid data out at $0.12/GB above 1 GB: $0.06/month for 10,000 people, $1.67/month for 100,000.
Memory at 6 parallel clients: Bun peak RSS 245.9 MB (MemoryHigh 256M, MemoryMax 320M); PostgreSQL peak Pss 82.9 MB (MemoryHigh 192M, MemoryMax 256M); 1024 MB in the VM. JavaScriptCore sizes its heap from this machine's memory, so the server's peak here does not predict its peak on the target.
Rate limits: every person stayed under 60 writes/min, 120 MCP requests/min and 120 requests/min per API key; a 429 stops the run.
Not counted: cloudflared's and Tailscale's CPU and keepalive traffic, the kernel, and journald.
Run time: 133 s for 5568 requests.
```

The exact output, heavy profile (`bun scripts/capacity.ts --profile heavy --target-score 1855`):

```text
direnv: loading ~/projects/agentsplit/.envrc
direnv: using flake
direnv: nix-direnv: Using cached dev shell
[capacity] Calibrating this machine
[capacity] Reading the production host settings from the flake
[capacity] Starting PostgreSQL 18.6 settings in /tmp/agentsplit-capacity-wIrmiU
[capacity] Seeding 60 people
[capacity] Starting the server (bun --no-install dist/server/server.js)
[capacity] Warming up
[capacity] Measuring 20 s of idle time
[capacity] Phase "app open": 1500 units
[capacity] Phase "app open + new expense": 300 units
[capacity] Phase "agent connect": 600 units
[capacity] Phase "agent read": 1800 units
[capacity] Phase "agent new expense": 600 units
[capacity] Waiting for the background work to finish
AgentSplit capacity benchmark, 2026-11-08T19:31Z, commit f03236d
People: 60 in 16 groups (4 6 4 3 2 5 2 6 5 6 2 2 4 2 4 6 people); seeded expenses per group: 468 11 32 14 27 39 51 47 38 16 387 33 48 35 51 51
Seeded data: 5.1 MB in tables, 87.3 KB per person
Server: the production build on Bun 1.3.13, pool 5; PostgreSQL 18.6 with the host's settings (shared_buffers 64MB, fsync on)
Clients: 6 at a time; Chromium for app opens, fetch for MCP. Static files come from the edge stand-in, as from Cloudflare's cache.

This machine: 4725 units/s (best of 7 rounds)
Rounds: 4412 4659 4666 4725 4639 4645 4643
Machine: arm64, 0xd4f, Bun 1.3.13
CPU scale: 2.55 = 4725 here / 1855 on the target

The month of one person, profile "heavy" (assumed; flags change it):
  30 app opens (dashboard, Groups, the group's expenses), 5 of them add an expense in the form
  10 agent sessions (initialize, initialized, GET stream, tools/list), 30 reads (list_groups, get_group, list_expenses, get_balances in turn), 10 create_expense
  15 new expenses, text notes only, no receipts

Measured cost of each unit (CPU on this machine, bytes leaving the origin with headers):
Unit                    Units  Requests/unit  Bun ms/unit  PG ms/unit  KB/unit  Per month
----------------------  -----  -------------  -----------  ----------  -------  ---------
app open                 1500            9.0         49.2        15.2    11.55         25
app open + new expense    300           13.7         78.3        25.0    19.73          5
agent connect             600            4.0          8.3         1.7    16.13         10
agent read               1800            1.0          2.3         1.6     1.21         30
agent new expense         600            1.0          4.4         3.0     0.69         10

Each request at the origin (Accept-Encoding: gzip; bytes include the status line and headers):
Request                                              Count  Status  Headers B  Body B  Unzipped B  Gzip  p50 ms
---------------------------------------------------  -----  ------  ---------  ------  ----------  ----  ------
auth get-session                                      1800     200        254     468         468    0%       7
mcp GET                                                600     405        278      83          83    0%       9
mcp initialize                                         600     200        332   2,163       4,653  100%       9
mcp notifications/initialized                          600     202        208       0           0    0%       9
mcp tools/call create_expense                          600     200        284     422         422    0%      18
mcp tools/call get_balances                            420     200        322     513       1,368   80%      10
mcp tools/call get_group                               480     200        331     829       3,226  100%      10
mcp tools/call list_expenses                           420     200        332   1,782      21,532  100%      13
mcp tools/call list_groups                             480     200        286     625         658    5%       9
mcp tools/list                                         600     200        333  13,116      90,573  100%      10
page (SPA document)                                   1800     304        690       0           0    0%       1
rpc balances.list                                     1800     200        297     690         690    0%       4
rpc expenses.create                                    300     200        297     852         852    0%       9
rpc expenses.detail                                    223     200        336     578       1,094   83%       4
rpc expenses.list                                     2100     200        345   2,565      21,413  100%       5
rpc feed.balances+feed.options                        1800     200        344     837       3,057  100%       8
rpc feed.balances+feed.options+feed.list+session.me    929     200        345   3,703      38,485  100%      16
rpc feed.list+session.me                               871     200        345   3,056      36,060  100%      13
rpc groups.directory                                  1800     200        297     290         290    0%       4
rpc groups.get                                        1800     200        297     439         439    0%       3
rpc groups.get+balances.list                           300     200        335     506       1,132   80%       6
rpc reference.get                                      300     200        345   1,535       5,059  100%       3
rpc session.me                                        1800     200        297     137         137    0%       4

Per person-month (measured):
  Requests at the origin: 374
  CPU on this machine: 2,419 ms (Bun 1,817, PostgreSQL 600, background after the run 2)
  CPU on the target (x2.55): 6,163 ms
  Bytes from the origin: 592.0 KB; with 64 B per packet (assumed): 657.1 KB
  Database growth, live rows: 52.8 KB (3.5 KB per new expense; expenses, payers and shares 19.3 KB); before VACUUM FULL: 72.5 KB
  Commits 1,050, WAL 167.0 KB, WAL fsyncs 223, data page writes 24, buffer reads 88,373 (4 from the OS)
  Growth by table: activities 26.0 KB, expense_shares 9.9 KB, expenses 7.5 KB, idempotency_keys 7.5 KB, expense_payers 2.0 KB
  Dump (pg_dump -Fc): 6% of the table bytes; 109 ms CPU for 8.1 MB of tables (63 ms for an empty database)
  Idle: Bun 3.50 ms/s, PostgreSQL 1.00 ms/s on this machine

Capacity in monthly active people:
Limit                             People                                                                                                                    Basis
-------------------------------  -------  -----------------------------------------------------------------------------------------------------------------------
Sustained CPU                     33,443  0.25 cores; 6,163 ms per person-month x peak factor 3 (assumed); idle 11.5 ms/s; hourly dumps of a year of data take 0%
Free data out                      1,595                    1 GB/month; 657.1 KB of traffic + 0.0 KB of backup pulls (0 dumps/month of a year of data) per person
Disk, after one year              33,098                                             20 GB usable (assumed); 633.6 KB of data + 0 dumps (6% each) per person-year
Page cache, after one year         1,765             400 MB (assumed); 232.0 KB per person-year of expenses, payers and shares, which every balance reads in full
Disk writes                      157,728                                                        45 IOPS; 247 WAL fsyncs and page writes per person-month x peak 3
Disk reads, cache empty (floor)      215                         22 IOPS if every buffer read missed the cache; does not bind while the page cache holds the data

Binding limit: Free data out, at about 1,595 monthly active people.
Binding limit of the VM itself (data out paid past the free allowance): Page cache, after one year, at about 1,765.
Backups: none counted (the default). Pass the host schedule to count them: --backup-pulls 30 --dumps-kept 72 --dumps-per-month 720.
Paid data out at $0.12/GB above 1 GB: $0.63/month for 10,000 people, $7.40/month for 100,000.
Memory at 6 parallel clients: Bun peak RSS 268.3 MB (MemoryHigh 256M, MemoryMax 320M); PostgreSQL peak Pss 83.2 MB (MemoryHigh 192M, MemoryMax 256M); 1024 MB in the VM. JavaScriptCore sizes its heap from this machine's memory, so the server's peak here does not predict its peak on the target.
Rate limits: every person stayed under 60 writes/min, 120 MCP requests/min and 120 requests/min per API key; a 429 stops the run.
Not counted: cloudflared's and Tailscale's CPU and keepalive traffic, the kernel, and journald.
Run time: 510 s for 22423 requests.
```

### Parallel writes to one group

With 12 or more parallel clients writing to the same groups, `create_expense` failed with `INTERNAL_SERVER_ERROR`. The server log shows PostgreSQL's serialization failure (`40001`, "could not serialize access due to read/write dependencies among transactions"). `serializable` in `src/server/core/db.ts` tries 5 times with no pause, and each attempt met the same conflict. At 6 parallel clients it happened in some runs. The benchmark now alternates the groups in each turn, so parallel clients rarely write to one group at once, and 12 parallel clients then pass. People of one group seldom write in the same few milliseconds, but on the slower target each transaction lasts longer, so the window is wider.

## Method

The benchmark runs the production build on the dev box, replays a month of use for many synthetic people, and measures what that month costs. Then it scales the CPU time to the target with a calibration, and divides each limit of the target by the cost of one person-month.

### What runs

- **PostgreSQL**: a private PostgreSQL 18 instance in a temporary directory, with the settings of `nixosConfigurations.agentsplit` (`nix/host/default.nix`), which the script reads with `nix eval`. It listens only on a Unix socket, as on the host, and keeps `fsync` on. The database is `agentsplit_capacity`, made with `db-reset` and migrated with `db/migrate.ts`. The dev box's shared PostgreSQL is not used: it runs with `fsync` off and serves other checkouts, so its CPU time cannot be counted.
- **Server**: `bun --no-install dist/server/server.js` from `bun run build`, with the environment of the host's systemd unit and of the launcher in `nix/package.nix` (`NODE_ENV=production`, the pool size of the host). The auth secrets are random and the Google client is a dummy. Receipts use `RECEIPT_DOWNLOADS=redirect` with an address where nothing listens: the month is text only, so no receipt request is made.
- **Edge**: a small proxy (`scripts/capacity/edge.ts`) between the clients and the server stands in for Cloudflare and `cloudflared`. It serves the files of the client build itself, as Cloudflare's cache does. It sends everything else (the API and the SPA page) to the server with `Accept-Encoding: gzip`, as Cloudflare asks the origin. It counts the bytes of each answer: the status line, the headers as HTTP/1.1 text, and the body as the server sent it.
- **Clients**: Chromium from the dev shell (through Playwright) for app opens, and `fetch` for the agent's MCP requests. Each person has a browser context with a signed session cookie (the test kit's `signIn`) and an API key from Better Auth's `createApiKey`. Each person sends its own `X-Forwarded-For` address, as `cloudflared` does, so Better Auth's per-address limits apply per person.

### The month of one person

These are assumptions. `--profile heavy` (the default) or `--profile typical` picks a set, and each flag below changes one value.

| Unit | Heavy | Typical | What it does |
| --- | ---: | ---: | --- |
| App open (`--opens` minus `--web-expenses`) | 25 | 7 | Load the SPA page at `/` (the dashboard), then Groups, then the person's group with its expense list. The later screens are client-side navigations. |
| App open with a new expense (`--web-expenses`) | 5 | 1 | The same, then Add expense, a description, an amount and a text note, and save. |
| Agent connect (`--agent-sessions`) | 10 | 2 | What Claude Code's MCP client sends at the start of a session: `initialize`, `notifications/initialized`, a `GET` for the event stream (the stateless server answers 405), and `tools/list`. |
| Agent read (`--agent-reads`) | 30 | 6 | `list_groups`, `get_group`, `list_expenses` and `get_balances` in turn. |
| Agent new expense (`--agent-expenses`) | 10 | 2 | `create_expense` with a text note and no receipt. |

Heavy is 30 app opens, 15 new expenses and 40 agent tool calls per person-month. Typical is 8 app opens, 3 new expenses and 8 agent tool calls.

### Measurements

- **CPU**: the user and system time of the server process, and of the whole PostgreSQL instance, from `/proc/<pid>/stat`. For PostgreSQL this is the postmaster, every process that runs now, and every process that has ended (the kernel adds those to the postmaster's `cutime` and `cstime`). Each unit type runs as its own phase, so each has its own cost. The background work after the last phase (autovacuum) is counted above the idle rate. A 20-second idle period gives the idle rate.
- **Bytes**: from the edge, per request, as above.
- **Disk**: `pg_total_relation_size` of every table before and after the month, after `VACUUM FULL`, so the numbers count live rows. Growth before the `VACUUM FULL` is also shown. A warm-up before the month gives each person the rows that a person has once (the rate-limit buckets, the API key's counters), so the month's growth is history.
- **Dumps**: five runs of what `agentsplit-db-dump` runs (`pg_dump --format=custom`, then `pg_restore --list`), on an empty database and after the month: the dump's size per byte of table, and its CPU time.
- **Input and output**: `pg_stat_database` and `pg_stat_io` (WAL fsyncs, page writes after a final checkpoint, and buffer reads).
- **Memory**: the peak RSS of the server (`VmHWM`), and the peak of the sum of PostgreSQL's proportional set sizes (`Pss`, which counts each shared page once), sampled every 250 ms.

A 429 from any limit stops the run, and so does any other failed request. The production limits stay as they are: the run spreads each person's requests over each phase (everyone's first unit, then everyone's second), and more people (`--users`) spread them thinner. Within a turn the groups alternate, for the reason in "Parallel writes to one group" above.

### From measurements to capacity

- **CPU scale**: the CPU time on the target is the measured time times the ratio of two calibration scores (`scripts/capacity/calibrate.ts`). One work unit builds, encodes, parses, gzips and hashes a JSON document of about 20 KB, which is close to what the server does for one answer. The same ratio is used for Bun and for PostgreSQL. That is an assumption.
- **Sustained CPU**: people = (cores − idle − the fixed part of the hourly dumps) ÷ (CPU per person-month × peak factor ÷ seconds per month + the part of the hourly dumps per person). The peak factor (default 3) is the busiest hour's traffic over the average hour. The hourly dump reads all of a person's data after a year.
- **Data out**: the edge's bytes, plus an assumed `--packet-overhead` (64 bytes) per 1,200-byte packet and one packet per request for its acknowledgement, plus the backup pulls of a person's data after a year (`--backup-pulls`, 0 by default; the production host pulls 30 dumps a month). The paid line uses `--egress-price` above the free allowance.
- **Disk**: a year of data per person, plus `--dumps-kept` dumps of it (0 by default; the production host keeps 72, hourly for 3 days), against `--disk-gb` (20 GB usable).
- **Page cache**: a balance sums every payer and share row of its group (`ledgerParts` in `src/server/balances.ts`), so a year of the tables `expenses`, `expense_payers` and `expense_shares` must stay in memory, against `--page-cache-mb` (400 MB).
- **Disk writes**: WAL fsyncs and page writes per person-month times the peak factor, against `--write-iops` (45: 1.5 per GB of a 30 GB pd-standard disk).
- **Disk reads with an empty cache**: buffer reads per person-month times the peak factor, against `--read-iops` (22). This is a floor if nothing were cached. It does not bind while the page cache holds the data.

### What is not counted

- The CPU time and the keepalive traffic of `cloudflared` and Tailscale, the kernel and journald.
- HPACK or QPACK header compression between `cloudflared` and Cloudflare. The headers count as HTTP/1.1 text, which is an upper bound.
- Receipts. They are in R2 and redirect there, so they never pass through the VM.
- Synthetic text compresses better than real text, so the dump ratio can be low.

## Run it again

1. Inside the dev shell, run the calibration on this machine: `direnv exec . bun scripts/capacity.ts --calibrate`.
2. Run the same file on the target. On the production host, Bun is in the server package, and the file needs only Bun:

   ```sh
   ssh root@agentsplit 'w=$(systemctl cat agentsplit | sed -n "s/^ExecStart=//p" | head -1); bun=$(grep -o "/nix/store/[^\" ]*/bin/bun" "$w" | head -1); "$bun" run -' < scripts/capacity/calibrate.ts
   ```

   This is CPU work only, for about 5 seconds. It reads nothing on the host but `/proc/cpuinfo`.
3. Run the benchmark with the target's score: `direnv exec . bun scripts/capacity.ts --target-score <score>`. It calibrates this machine again in the same run and prints the ratio. It takes about 10 minutes for 60 people. Add `--skip-build` to reuse `dist/` from an earlier `bun run build`. `--help` lists every flag.
4. Copy the output into "Latest results" above, with the date and the commit.
