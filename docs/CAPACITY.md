# Capacity

This document states how many monthly active people one small VM can host, and how to measure it again. `scripts/capacity.ts` makes the measurement. The target is the production host of [DEPLOYMENT.md](../DEPLOYMENT.md): a GCE e2-micro with 2 shared vCPUs at about a quarter of a core sustained, 1 GB of memory, a 30 GB pd-standard disk, and 1 GB of free data out each month.

## Latest results

The runs of 2026-11-08 on the deployed code (`534b7a7`), with the production host's calibration score of 1855, and the free tier alone: no backups are counted (the default).

| Limit, monthly active people | Typical (`--profile typical`) | Heavy (`--profile heavy`) |
| --- | ---: | ---: |
| Sustained CPU, a quarter of a core, busiest hour 3 × the average | **141,438** | 37,496 |
| Disk, 20 GB, after a year of data | 201,649 | **33,956** |
| Page cache, 400 MB | 768,000 | 768,000 |
| Free data out, 1 GB a month | 6,904 | 1,623 |

- **Typical person**: 8 app opens, 3 new expenses (1 in the web form, 2 by an agent), and 2 agent sessions with 6 reads, each month.
- **Heavy person**: 30 app opens, 15 new expenses (5 in the web form, 10 by an agent), and 10 agent sessions with 30 reads, each month.
- **The VM's own limit** is CPU for typical people and disk for heavy people. The page cache no longer binds: balances read `balance_totals`, which grows with people and currencies, not with expenses (migration 0020).
- **Data out past the free 1 GB is cheap:** about $0.12 per GB.
- **Backups:** to count the production host's backups, pass `--backup-pulls 30 --dumps-kept 72 --dumps-per-month 720`.
- **Before the capacity PRs #23–#26** (`f03236d`), the page cache bound first: at about 8,500 typical or 1,800 heavy people after a year of data.

The exact output, typical profile (`bun scripts/capacity.ts --profile typical --target-score 1855`):

```text
direnv: loading ~/projects/agentsplit/.envrc
direnv: using flake
direnv: nix-direnv: Using cached dev shell
[capacity] Calibrating this machine
[capacity] Reading the production host settings from the flake
[capacity] Building (bun run build)
[capacity] Starting PostgreSQL 18.6 settings in /tmp/agentsplit-capacity-txBFYv
[capacity] Seeding 60 people
[capacity] Starting the server (bun --no-install dist/server/server.js)
[capacity] Warming up
[capacity] Letting the server settle for 30 s
[capacity] Measuring 60 s of idle time
[capacity] Phase "app open": 420 units
[capacity] Phase "app open + new expense": 60 units
[capacity] Phase "agent connect": 120 units
[capacity] Phase "agent read": 360 units
[capacity] Phase "agent new expense": 120 units
[capacity] Waiting for the background work to finish
AgentSplit capacity benchmark, 2026-11-08T21:37Z, commit 534b7a7
People: 60 in 16 groups (4 6 4 3 2 5 2 6 5 6 2 2 4 2 4 6 people); seeded expenses per group: 468 11 32 14 27 39 51 47 38 16 387 33 48 35 51 51
Seeded data: 5.3 MB in tables, 89.6 KB per person
Server: the production build on Bun 1.3.13, pool 5; PostgreSQL 18.6 with the host's settings (shared_buffers 64MB, fsync on)
Clients: 6 at a time; Chromium for app opens, fetch for MCP. Static files come from the edge stand-in, as from Cloudflare's cache.

This machine: 4774 units/s (best of 7 rounds)
Rounds: 4487 4649 4645 4774 4657 4656 4769
Machine: arm64, 0xd4f, Bun 1.3.13
CPU scale: 2.57 = 4774 here / 1855 on the target

The month of one person, profile "typical" (assumed; flags change it):
  8 app opens (dashboard, Groups, the group's expenses), 1 of them add an expense in the form
  2 agent sessions (initialize, initialized, GET stream, tools/list), 6 reads (list_groups, get_group, list_expenses, get_balances in turn), 2 create_expense
  3 new expenses, text notes only, no receipts

Measured cost of each unit (CPU on this machine, bytes leaving the origin with headers):
Unit                    Units  Requests/unit  Bun ms/unit  PG ms/unit  KB/unit  Per month
----------------------  -----  -------------  -----------  ----------  -------  ---------
app open                  420            7.3         45.5        13.6    11.18          7
app open + new expense     60           12.0         75.0        21.2    18.26          1
agent connect             120            4.0          5.4         1.7    16.14          2
agent read                360            1.0          2.3         1.2     1.17          6
agent new expense         120            1.0          5.2         3.7     0.69          2

Each request at the origin (Accept-Encoding: gzip; bytes include the status line and headers):
Request                                   Count  Status  Headers B  Body B  Unzipped B  Gzip  p50 ms
----------------------------------------  -----  ------  ---------  ------  ----------  ----  ------
auth get-session                            480     200        254     468         468    0%       7
mcp GET                                     120     405        278      83          83    0%       5
mcp initialize                              120     200        332   2,168       4,652  100%       5
mcp notifications/initialized               120     202        208       0           0    0%       5
mcp tools/call create_expense               120     200        284     422         422    0%      17
mcp tools/call get_balances                  60     200        322     511       1,364   80%      10
mcp tools/call get_group                    120     200        331     829       3,225  100%      10
mcp tools/call list_expenses                 60     200        332   1,871      21,582  100%      12
mcp tools/call list_groups                  120     200        286     624         657    5%       8
mcp tools/list                              120     200        333  13,121      90,572  100%       5
page (SPA document)                         480     304        690       0           0    0%       1
rpc balances.list+expenses.list             480     200        345   2,657      21,593  100%       5
rpc expenses.create                          60     200        297     852         852    0%      10
rpc expenses.detail                          44     200        334     601       1,087   80%       4
rpc expenses.list                            60     200        345   2,594      21,618  100%       5
rpc feed.balances+feed.options+feed.list    631     200        345   3,648      38,141  100%      14
rpc groups.directory                        480     200        297     290         290    0%       3
rpc groups.get                              480     200        297     439         439    0%       3
rpc groups.get+balances.list                 60     200        335     505       1,131   80%       4
rpc reference.get                            60     200        345   1,534       5,058  100%       3
rpc session.me                              480     200        297     137         137    0%       3

Per person-month (measured):
  Requests at the origin: 79
  CPU on this machine: 564 ms (Bun 429, PostgreSQL 135, background after the run 0)
  CPU on the target (x2.57): 1,451 ms
  Bytes from the origin: 137.2 KB; with 64 B per packet (assumed): 151.9 KB
  Database growth, live rows: 8.7 KB (2.9 KB per new expense; expenses, payers and shares 2.5 KB); before VACUUM FULL: 19.5 KB
  Commits 217, WAL 34.5 KB, WAL fsyncs 47, data page writes 17, buffer reads 16,822 (3 from the OS)
  Growth by table: activities 4.5 KB, idempotency_keys 1.6 KB, expense_shares 1.5 KB, expenses 1.2 KB
  Dump (pg_dump -Fc): 5% of the table bytes; 88 ms CPU for 5.8 MB of tables (62 ms for an empty database)
  Idle: Bun 3.00 ms/s, PostgreSQL 1.83 ms/s on this machine

Capacity in monthly active people:
Limit                             People                                                                                                                                Basis
-------------------------------  -------  -----------------------------------------------------------------------------------------------------------------------------------
Sustained CPU                    141,438              0.25 cores; 1,451 ms per person-month x peak factor 3 (assumed); idle 12.4 ms/s; hourly dumps of a year of data take 0%
Free data out                      6,904                                1 GB/month; 151.9 KB of traffic + 0.0 KB of backup pulls (0 dumps/month of a year of data) per person
Disk, after one year             201,649                                                         20 GB usable (assumed); 104.0 KB of data + 0 dumps (5% each) per person-year
Page cache, after one year       768,000  400 MB (assumed); 0.5 KB per person of balance_totals, which every balance reads; it grows with people and currencies, not expenses
Disk writes                      614,379                                                                     45 IOPS; 63 WAL fsyncs and page writes per person-month x peak 3
Disk reads, cache empty (floor)    1,129                                     22 IOPS if every buffer read missed the cache; does not bind while the page cache holds the data

Binding limit: Free data out, at about 6,904 monthly active people.
Binding limit of the VM itself (data out paid past the free allowance): Sustained CPU, at about 141,438.
Backups: none counted (the default). Pass the host schedule to count them: --backup-pulls 30 --dumps-kept 72 --dumps-per-month 720.
Paid data out at $0.12/GB above 1 GB: $0.05/month for 10,000 people, $1.62/month for 100,000.
Memory at 6 parallel clients: Bun peak RSS 254.1 MB (MemoryHigh 256M, MemoryMax 320M); PostgreSQL peak Pss 80.4 MB (MemoryHigh 192M, MemoryMax 256M); 1024 MB in the VM. JavaScriptCore sizes its heap from this machine's memory, so the server's peak here does not predict its peak on the target.
Rate limits: every person stayed under 60 writes/min, 120 MCP requests/min and 120 requests/min per API key; a 429 stops the run.
Not counted: cloudflared's and Tailscale's CPU and keepalive traffic, the kernel, and journald.
Run time: 127 s for 4755 requests.
```

The exact output, heavy profile (`bun scripts/capacity.ts --profile heavy --target-score 1855`):

```text
direnv: loading ~/projects/agentsplit/.envrc
direnv: using flake
direnv: nix-direnv: Using cached dev shell
[capacity] Calibrating this machine
[capacity] Reading the production host settings from the flake
[capacity] Starting PostgreSQL 18.6 settings in /tmp/agentsplit-capacity-GS2Nj1
[capacity] Seeding 60 people
[capacity] Starting the server (bun --no-install dist/server/server.js)
[capacity] Warming up
[capacity] Letting the server settle for 30 s
[capacity] Measuring 60 s of idle time
[capacity] Phase "app open": 1500 units
[capacity] Phase "app open + new expense": 300 units
[capacity] Phase "agent connect": 600 units
[capacity] Phase "agent read": 1800 units
[capacity] Phase "agent new expense": 600 units
[capacity] Waiting for the background work to finish
AgentSplit capacity benchmark, 2026-11-08T21:41Z, commit 534b7a7
People: 60 in 16 groups (4 6 4 3 2 5 2 6 5 6 2 2 4 2 4 6 people); seeded expenses per group: 468 11 32 14 27 39 51 47 38 16 387 33 48 35 51 51
Seeded data: 5.3 MB in tables, 89.6 KB per person
Server: the production build on Bun 1.3.13, pool 5; PostgreSQL 18.6 with the host's settings (shared_buffers 64MB, fsync on)
Clients: 6 at a time; Chromium for app opens, fetch for MCP. Static files come from the edge stand-in, as from Cloudflare's cache.

This machine: 4789 units/s (best of 7 rounds)
Rounds: 4409 4556 4646 4739 4683 4705 4789
Machine: arm64, 0xd4f, Bun 1.3.13
CPU scale: 2.58 = 4789 here / 1855 on the target

The month of one person, profile "heavy" (assumed; flags change it):
  30 app opens (dashboard, Groups, the group's expenses), 5 of them add an expense in the form
  10 agent sessions (initialize, initialized, GET stream, tools/list), 30 reads (list_groups, get_group, list_expenses, get_balances in turn), 10 create_expense
  15 new expenses, text notes only, no receipts

Measured cost of each unit (CPU on this machine, bytes leaving the origin with headers):
Unit                    Units  Requests/unit  Bun ms/unit  PG ms/unit  KB/unit  Per month
----------------------  -----  -------------  -----------  ----------  -------  ---------
app open                 1500            7.3         44.0        13.7    11.25         25
app open + new expense    300           12.2         74.6        22.9    19.77          5
agent connect             600            4.0          4.5         1.6    16.14         10
agent read               1800            1.0          2.0         1.3     1.21         30
agent new expense         600            1.0          3.6         3.1     0.69         10

Each request at the origin (Accept-Encoding: gzip; bytes include the status line and headers):
Request                                   Count  Status  Headers B  Body B  Unzipped B  Gzip  p50 ms
----------------------------------------  -----  ------  ---------  ------  ----------  ----  ------
auth get-session                           1800     200        254     468         468    0%       6
mcp GET                                     600     405        278      83          83    0%       5
mcp initialize                              600     200        332   2,169       4,653  100%       5
mcp notifications/initialized               600     202        208       0           0    0%       5
mcp tools/call create_expense               600     200        284     422         422    0%      16
mcp tools/call get_balances                 420     200        322     513       1,369   80%       8
mcp tools/call get_group                    480     200        331     829       3,226  100%       8
mcp tools/call list_expenses                420     200        332   1,780      21,533  100%      11
mcp tools/call list_groups                  480     200        286     625         658    5%       7
mcp tools/list                              600     200        333  13,122      90,573  100%       5
page (SPA document)                        1800     304        690       0           0    0%       1
rpc balances.list+expenses.list            1800     200        345   2,701      21,853  100%       5
rpc expenses.create                         300     200        297     852         852    0%       9
rpc expenses.detail                         250     200        334     596       1,085   79%       4
rpc expenses.list                           300     200        345   2,822      22,908  100%       5
rpc feed.balances+feed.options+feed.list   2426     200        345   3,701      38,601  100%      13
rpc groups.directory                       1800     200        297     290         290    0%       3
rpc groups.get                             1800     200        297     439         439    0%       3
rpc groups.get+balances.list                300     200        335     507       1,133   80%       4
rpc reference.get                           300     200        345   1,534       5,058  100%       3
rpc session.me                             1800     200        297     137         137    0%       3

Per person-month (measured):
  Requests at the origin: 325
  CPU on this machine: 2,162 ms (Bun 1,616, PostgreSQL 545, background after the run 2)
  CPU on the target (x2.58): 5,582 ms
  Bytes from the origin: 584.6 KB; with 64 B per packet (assumed): 645.9 KB
  Database growth, live rows: 51.5 KB (3.4 KB per new expense; expenses, payers and shares 18.5 KB); before VACUUM FULL: 68.5 KB
  Commits 905, WAL 166.2 KB, WAL fsyncs 222, data page writes 24, buffer reads 67,417 (3 from the OS)
  Growth by table: activities 25.5 KB, expense_shares 9.3 KB, expenses 7.7 KB, idempotency_keys 7.5 KB, expense_payers 1.5 KB
  Dump (pg_dump -Fc): 6% of the table bytes; 111 ms CPU for 8.3 MB of tables (66 ms for an empty database)
  Idle: Bun 1.17 ms/s, PostgreSQL 1.83 ms/s on this machine

Capacity in monthly active people:
Limit                             People                                                                                                                                Basis
-------------------------------  -------  -----------------------------------------------------------------------------------------------------------------------------------
Sustained CPU                     37,496               0.25 cores; 5,582 ms per person-month x peak factor 3 (assumed); idle 7.7 ms/s; hourly dumps of a year of data take 0%
Free data out                      1,623                                1 GB/month; 645.9 KB of traffic + 0.0 KB of backup pulls (0 dumps/month of a year of data) per person
Disk, after one year              33,956                                                         20 GB usable (assumed); 617.6 KB of data + 0 dumps (6% each) per person-year
Page cache, after one year       768,000  400 MB (assumed); 0.5 KB per person of balance_totals, which every balance reads; it grows with people and currencies, not expenses
Disk writes                      158,005                                                                    45 IOPS; 246 WAL fsyncs and page writes per person-month x peak 3
Disk reads, cache empty (floor)      281                                     22 IOPS if every buffer read missed the cache; does not bind while the page cache holds the data

Binding limit: Free data out, at about 1,623 monthly active people.
Binding limit of the VM itself (data out paid past the free allowance): Disk, after one year, at about 33,956.
Backups: none counted (the default). Pass the host schedule to count them: --backup-pulls 30 --dumps-kept 72 --dumps-per-month 720.
Paid data out at $0.12/GB above 1 GB: $0.62/month for 10,000 people, $7.27/month for 100,000.
Memory at 6 parallel clients: Bun peak RSS 257.0 MB (MemoryHigh 256M, MemoryMax 320M); PostgreSQL peak Pss 83.5 MB (MemoryHigh 192M, MemoryMax 256M); 1024 MB in the VM. JavaScriptCore sizes its heap from this machine's memory, so the server's peak here does not predict its peak on the target.
Rate limits: every person stayed under 60 writes/min, 120 MCP requests/min and 120 requests/min per API key; a 429 stops the run.
Not counted: cloudflared's and Tailscale's CPU and keepalive traffic, the kernel, and journald.
Run time: 485 s for 19476 requests.
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

- **CPU**: the user and system time of the server process, and of the whole PostgreSQL instance, from `/proc/<pid>/stat`. For PostgreSQL this is the postmaster, every process that runs now, and every process that has ended (the kernel adds those to the postmaster's `cutime` and `cstime`). Each unit type runs as its own phase, so each has its own cost. The background work after the last phase (autovacuum) is counted above the idle rate. A 60-second idle period gives the idle rate. It starts 30 seconds after the warm-up (`--idle-settle`), because the server's garbage collector and JIT stay busy after a burst of requests: the earlier 20-second window, 5 seconds after the warm-up, measured from 3.5 to 6.5 ms/s of Bun time in runs of the same code. In 60 seconds, one clock tick of 10 ms is 0.17 ms/s.
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
- **Page cache**: a balance reads its group's rows of `balance_totals`, one per participant and currency, which triggers keep in step with every payer and share row (`db/migrations/0020_running_balances.sql`). That table must stay in memory, against `--page-cache-mb` (400 MB). It grows with people and currencies, not with expenses, so the line uses its size per person after the month. Before 0020, each balance summed every payer and share row of its group, so a year of the tables `expenses`, `expense_payers` and `expense_shares` had to stay in memory. The expense lists, the activity log and the idempotency keys are read a page or a key at a time through indexes.
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
