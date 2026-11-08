# Capacity

This document states how many monthly active people one small VM can host, and how to measure it again. `scripts/capacity.ts` makes the measurement. The target is the production host of [DEPLOYMENT.md](../DEPLOYMENT.md): a GCE e2-micro with 2 shared vCPUs at about a quarter of a core sustained, 1 GB of memory, a 30 GB pd-standard disk, and 1 GB of free data out each month.

## Latest results

The run of 2026-11-08 at commit `d7bb2c9`, with 60 people and the production host's calibration score of 1855 (`--target-score 1855`).

- **Binding limit**: the free data allowance, at about 550 monthly active people. More than half of each person's data out is the dev box's nightly pull of the dump. Without it, the allowance lasts to about 1,300 people. Past the allowance, data out is cheap: about $2 a month for 10,000 people.
- **Binding limit of the VM itself**: the page cache, at about 1,800 people after a year. Each balance reads all of its group's expenses, payers and shares, so these tables must stay in memory. Past that point, reads go to a disk with 22 IOPS, and with no cache at all only about 200 people fit.
- **CPU** is far from binding: about 26,000 people at a peak factor of 3. The hourly dumps take 22% of the CPU at that size, because each dump reads all of the data.
- **Bytes**: an app open sends 15 KB from the origin, and about 6 KB of it is headers (about 700 bytes on each of 9 answers, about half of each the Content-Security-Policy). An agent session sends 17.6 KB before its first tool call, 13 KB of it `tools/list`.
- **Repeatability**: an earlier run of the same code gave the same costs within 1% (2,452 against 2,440 ms of CPU per person-month here, 735 against 737 KB). The calibration of this machine moved 4% between runs (4764 and 4560), and the production host gave 1855 and 1799 on two runs. Read the CPU numbers as ±5%.

The exact output:

```text
AgentSplit capacity benchmark, 2026-11-08T18:28Z, commit d7bb2c9
People: 60 in 16 groups (4 6 4 3 2 5 2 6 5 6 2 2 4 2 4 6 people); seeded expenses per group: 468 11 32 14 27 39 51 47 38 16 387 33 48 35 51 51
Seeded data: 5.1 MB in tables, 87.3 KB per person
Server: the production build on Bun 1.3.13, pool 5; PostgreSQL 18.6 with the host's settings (shared_buffers 64MB, fsync on)
Clients: 6 at a time; Chromium for app opens, fetch for MCP. Static files come from the edge stand-in, as from Cloudflare's cache.

This machine: 4560 units/s (best of 7 rounds)
Rounds: 4205 4506 4502 4560 4538 4458 4340
Machine: arm64, 0xd4f, Bun 1.3.13
CPU scale: 2.46 = 4560 here / 1855 on the target

The month of one person (assumed; flags change it):
  30 app opens (dashboard, Groups, the group's expenses), 5 of them add an expense in the form
  10 agent sessions (initialize, initialized, GET stream, tools/list), 30 reads (list_groups, get_group, list_expenses, get_balances in turn), 10 create_expense
  15 new expenses, text notes only, no receipts

Measured cost of each unit (CPU on this machine, bytes leaving the origin with headers):
Unit                    Units  Requests/unit  Bun ms/unit  PG ms/unit  KB/unit  Per month
----------------------  -----  -------------  -----------  ----------  -------  ---------
app open                 1500            9.0         50.3        15.2    15.09         25
app open + new expense    300           13.8         78.0        24.7    25.05          5
agent connect             600            4.0          8.2         1.8    17.60         10
agent read               1800            1.0          2.4         1.6     1.58         30
agent new expense         600            1.0          4.0         3.0     1.06         10

Each request at the origin (Accept-Encoding: gzip; bytes include the status line and headers):
Request                                              Count  Status  Headers B  Body B  Unzipped B  Gzip  p50 ms
---------------------------------------------------  -----  ------  ---------  ------  ----------  ----  ------
auth get-session                                      1800     200      1,253     468         468    0%       9
mcp GET                                                600     405        656      83          83    0%       9
mcp initialize                                         600     200        710   2,163       4,653  100%       9
mcp notifications/initialized                          600     202        586       0           0    0%       9
mcp tools/call create_expense                          600     200        662     422         422    0%      18
mcp tools/call get_balances                            420     200        700     513       1,367   80%      10
mcp tools/call get_group                               480     200        709     830       3,226  100%      10
mcp tools/call list_expenses                           420     200        710   1,780      21,535  100%      13
mcp tools/call list_groups                             480     200        664     625         658    5%       9
mcp tools/list                                         600     200        711  13,116      90,575  100%      10
page (SPA document)                                   1800     304        690       0           0    0%       1
rpc balances.list                                     1800     200        675     689         689    0%       4
rpc expenses.create                                    300     200        675     852         852    0%      10
rpc expenses.detail                                    227     200        712     594       1,088   80%       4
rpc expenses.list                                     2100     200        723   2,572      21,413  100%       5
rpc feed.balances+feed.options                        1800     200        722     837       3,057  100%       8
rpc feed.balances+feed.options+feed.list+session.me    842     200        723   3,687      38,203  100%      16
rpc feed.list+session.me                               958     200        723   3,081      36,238  100%      13
rpc groups.directory                                  1800     200        675     290         290    0%       4
rpc groups.get                                        1800     200        675     439         439    0%       3
rpc groups.get+balances.list                           300     200        713     506       1,133   80%       6
rpc reference.get                                      300     200        723   1,535       5,059  100%       3
rpc session.me                                        1800     200        675     137         137    0%       4

Per person-month (measured):
  Requests at the origin: 374
  CPU on this machine: 2,440 ms (Bun 1,840, PostgreSQL 599, background after the run 1)
  CPU on the target (x2.46): 5,998 ms
  Bytes from the origin: 736.7 KB; with 64 B per packet (assumed): 810.2 KB
  Database growth, live rows: 52.8 KB (3.5 KB per new expense; expenses, payers and shares 19.3 KB); before VACUUM FULL: 72.4 KB
  Commits 1,074, WAL 169.2 KB, WAL fsyncs 222, data page writes 24, buffer reads 87,643 (4 from the OS)
  Growth by table: activities 26.0 KB, expense_shares 9.9 KB, expenses 7.5 KB, idempotency_keys 7.5 KB, expense_payers 2.0 KB
  Dump (pg_dump -Fc): 6% of the table bytes; 111 ms CPU for 8.1 MB of tables (72 ms for an empty database)
  Idle: Bun 3.50 ms/s, PostgreSQL 1.00 ms/s on this machine

Capacity in monthly active people:
Limit                             People                                                                                                                     Basis
-------------------------------  -------  ------------------------------------------------------------------------------------------------------------------------
Sustained CPU                     26,492  0.25 cores; 5,998 ms per person-month x peak factor 3 (assumed); idle 11.1 ms/s; hourly dumps of a year of data take 22%
Free data out                        550                1 GB/month; 810.2 KB of traffic + 1,096.1 KB of backup pulls (30 dumps/month of a year of data) per person
Disk, after one year               6,424                                             20 GB usable (assumed); 633.6 KB of data + 72 dumps (6% each) per person-year
Page cache, after one year         1,765              400 MB (assumed); 232.0 KB per person-year of expenses, payers and shares, which every balance reads in full
Disk writes                      157,760                                                         45 IOPS; 246 WAL fsyncs and page writes per person-month x peak 3
Disk reads, cache empty (floor)      216                          22 IOPS if every buffer read missed the cache; does not bind while the page cache holds the data

Binding limit: Free data out, at about 550 monthly active people.
Binding limit of the VM itself (data out paid past the free allowance): Page cache, after one year, at about 1,765.
Free data out without the backup pulls (if the dev box's pull is not billed): about 1,294 people.
Paid data out at $0.12/GB above 1 GB: $2.06/month for 10,000 people, $21.70/month for 100,000.
Memory at 6 parallel clients: Bun peak RSS 278.2 MB (MemoryHigh 256M, MemoryMax 320M); PostgreSQL peak Pss 81.7 MB (MemoryHigh 192M, MemoryMax 256M); 1024 MB in the VM. JavaScriptCore sizes its heap from this machine's memory, so the server's peak here does not predict its peak on the target.
Rate limits: every person stayed under 60 writes/min, 120 MCP requests/min and 120 requests/min per API key; a 429 stops the run.
Not counted: cloudflared's and Tailscale's CPU and keepalive traffic, the kernel, and journald.
Run time: 514 s for 22427 requests.
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

These are assumptions. The flags change them.

| Unit | Per month | What it does |
| --- | --- | --- |
| App open | 25 (`--opens` minus `--web-expenses`) | Load the SPA page at `/` (the dashboard), then Groups, then the person's group with its expense list. The later screens are client-side navigations. |
| App open with a new expense | 5 (`--web-expenses`) | The same, then Add expense, a description, an amount and a text note, and save. |
| Agent connect | 10 (`--agent-sessions`) | What Claude Code's MCP client sends at the start of a session: `initialize`, `notifications/initialized`, a `GET` for the event stream (the stateless server answers 405), and `tools/list`. |
| Agent read | 30 (`--agent-reads`) | `list_groups`, `get_group`, `list_expenses` and `get_balances` in turn. |
| Agent new expense | 10 (`--agent-expenses`) | `create_expense` with a text note and no receipt. |

That is 30 app opens, 15 new expenses and 40 agent tool calls per person-month.

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
- **Data out**: the edge's bytes, plus an assumed `--packet-overhead` (64 bytes) per 1,200-byte packet and one packet per request for its acknowledgement, plus the dev box's backup pulls (`--backup-pulls`, 30 dumps a month) of a person's data after a year. The paid line uses `--egress-price` above the free allowance.
- **Disk**: a year of data per person, plus `--dumps-kept` (72: hourly for 3 days) dumps of it, against `--disk-gb` (20 GB usable).
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
