# Rust vs Node.js

We pushed both versions of the Weer server to their limit on the same AWS machines and compared them: server-turbo (Cpeak for Rust) and the Node.js server (Cpeak for Node.js, 48 PM2 workers). Both use the same Redis cluster, link cache and PostgreSQL database, and both had the janitor running, so every view of every redirect was saved to the database.

The setup: the server and the tester on a c8gn.12xlarge each (48 vCPU), the database on a c8gn.4xlarge, 12 Redis masters, 193,719 short links. The tester ran `yarn classic-r --connections 2400 --workers 48 --duration 60` (60 seconds of redirects). Before each run there was a 15-second warm-up, then the views table, the Redis streams and the request log were emptied. CPU and memory are averages over the middle 50 seconds.

|                                     | Rust                                    | Node.js (48 workers)                  | Rust vs Node                  |
| ----------------------------------- | --------------------------------------- | ------------------------------------- | ----------------------------- |
| **Throughput**                      | **1,139,700 req/s** (68.56M in 60.16 s) | **477,700 req/s** (28.76M in 60.19 s) | **2.4x**                      |
| **Response time** p50 / avg / p99   | 1 ms / 1.6 ms / 14 ms                   | 3 ms / 4.5 ms / 20 ms                 | ~2.8x lower average, 1.4x p99 |
| Response time max                   | 303 ms                                  | 1,320 ms                              |                               |
| **Server CPU idle**                 | 10.7%                                   | 0.9%                                  | Node is maxed out             |
| Server process CPU                  | 28.1 cores                              | 37.4 cores                            |                               |
| Janitor CPU                         | 3.8 cores                               | 3.0 cores                             |                               |
| Requests per server core            | ~40,600                                 | ~12,800                               | **~3.2x**                     |
| Redis masters (busiest)             | 86%                                     | 55%                                   |                               |
| Tester / db idle                    | 23% / 66%                               | 58% / 72%                             |                               |
| **Memory under load** (PSS), server | **419 MB**                              | **9,841 MB** (12.2 GB RSS)            | **~23x less**                 |
| Memory under load, janitor          | 442 MB                                  | 1,898 MB                              | ~4x less                      |
| **Memory idle**, server + janitor   | 208 + 38 MB                             | 2,485 + 322 MB                        | ~11x less                     |

In short: Rust handles about 2.4 times the traffic, with lower response times, about a third of the CPU per request and a small fraction of the memory. Node runs out of its own CPU first: Redis and the tester still had plenty of room. Rust still had some CPU left and was closer to the limits of Redis. Every view was saved in both runs.

## Autocannon output

### Rust

```
yarn run v1.22.22
$ node src/classic-rw.mjs --url http://localhost:2080 --connections 5 --sessions 500 --duration 10 write-ratio 0 --output codes.txt --url http://172.31.6.71:2080 --connections 2400 --workers 48 --duration 60
Loaded 137199 codes from codes.txt.

Running: 2400 connections · 60s · 0% writes / 100% reads · 500 sessions · 48 workers

Running 60s test @ http://172.31.6.71:2080
2400 connections
48 workers


┌─────────┬──────┬──────┬───────┬───────┬────────┬─────────┬────────┐
│ Stat    │ 2.5% │ 50%  │ 97.5% │ 99%   │ Avg    │ Stdev   │ Max    │
├─────────┼──────┼──────┼───────┼───────┼────────┼─────────┼────────┤
│ Latency │ 0 ms │ 1 ms │ 10 ms │ 14 ms │ 1.6 ms │ 2.95 ms │ 303 ms │
└─────────┴──────┴──────┴───────┴───────┴────────┴─────────┴────────┘
┌───────────┬───────────┬───────────┬───────────┬───────────┬──────────────┬───────────┬───────────┐
│ Stat      │ 1%        │ 2.5%      │ 50%       │ 97.5%     │ Avg          │ Stdev     │ Min       │
├───────────┼───────────┼───────────┼───────────┼───────────┼──────────────┼───────────┼───────────┤
│ Req/Sec   │ 1,087,487 │ 1,094,655 │ 1,142,783 │ 1,212,415 │ 1,142,664.54 │ 28,337.92 │ 1,087,074 │
├───────────┼───────────┼───────────┼───────────┼───────────┼──────────────┼───────────┼───────────┤
│ Bytes/Sec │ 168 MB    │ 169 MB    │ 177 MB    │ 187 MB    │ 177 MB       │ 4.39 MB   │ 168 MB    │
└───────────┴───────────┴───────────┴───────────┴───────────┴──────────────┴───────────┴───────────┘

Req/Bytes counts sampled once per second.
# of samples: 2880

0 2xx responses, 68561930 non 2xx responses
68564k requests in 60.16s, 10.6 GB read

Status codes: { '302': { count: 68561930 } }
Done in 61.33s.
```

### Node.js

```
yarn run v1.22.22
$ node src/classic-rw.mjs --url http://localhost:2080 --connections 5 --sessions 500 --duration 10 write-ratio 0 --output codes.txt --url http://172.31.6.71:2080 --connections 2400 --workers 48 --duration 60
Loaded 137199 codes from codes.txt.

Running: 2400 connections · 60s · 0% writes / 100% reads · 500 sessions · 48 workers

Running 60s test @ http://172.31.6.71:2080
2400 connections
48 workers


┌─────────┬──────┬──────┬───────┬───────┬─────────┬─────────┬─────────┐
│ Stat    │ 2.5% │ 50%  │ 97.5% │ 99%   │ Avg     │ Stdev   │ Max     │
├─────────┼──────┼──────┼───────┼───────┼─────────┼─────────┼─────────┤
│ Latency │ 0 ms │ 3 ms │ 14 ms │ 20 ms │ 4.51 ms │ 5.71 ms │ 1320 ms │
└─────────┴──────┴──────┴───────┴───────┴─────────┴─────────┴─────────┘
┌───────────┬─────────┬─────────┬─────────┬─────────┬────────────┬───────────┬─────────┐
│ Stat      │ 1%      │ 2.5%    │ 50%     │ 97.5%   │ Avg        │ Stdev     │ Min     │
├───────────┼─────────┼─────────┼─────────┼─────────┼────────────┼───────────┼─────────┤
│ Req/Sec   │ 421,631 │ 451,327 │ 481,279 │ 492,287 │ 479,227.74 │ 10,803.84 │ 421,628 │
├───────────┼─────────┼─────────┼─────────┼─────────┼────────────┼───────────┼─────────┤
│ Bytes/Sec │ 90.9 MB │ 97.3 MB │ 104 MB  │ 106 MB  │ 103 MB     │ 2.32 MB   │ 90.8 MB │
└───────────┴─────────┴─────────┴─────────┴─────────┴────────────┴───────────┴─────────┘

Req/Bytes counts sampled once per second.
# of samples: 2880

0 2xx responses, 28752966 non 2xx responses
28755k requests in 60.19s, 6.2 GB read

Status codes: { '302': { count: 28752966 } }
Done in 61.33s.
```

## 30-minute Rust run

The same setup, with the tester running `yarn classic-r --url http://172.31.7.185:2080 --connections 2400 --workers 48 --duration 1800`: 1,993,725,895 redirects in 1,800.18 s, 1,107,600 req/s on average.

```
yarn run v1.22.22
$ node src/classic-rw.mjs --url http://localhost:2080 --connections 5 --sessions 500 --duration 10 write-ratio 0 --output codes.txt --url http://172.31.7.185:2080 --connections 2400 --workers 48 --duration 1800
Loaded 142857 codes from codes.txt.

Running: 2400 connections · 1800s · 0% writes / 100% reads · 500 sessions · 48 workers

Running 1800s test @ http://172.31.7.185:2080
2400 connections
48 workers

\
┌─────────┬──────┬──────┬───────┬───────┬─────────┬─────────┬────────┐
│ Stat    │ 2.5% │ 50%  │ 97.5% │ 99%   │ Avg     │ Stdev   │ Max    │
├─────────┼──────┼──────┼───────┼───────┼─────────┼─────────┼────────┤
│ Latency │ 0 ms │ 0 ms │ 11 ms │ 15 ms │ 1.66 ms │ 3.01 ms │ 271 ms │
└─────────┴──────┴──────┴───────┴───────┴─────────┴─────────┴────────┘
┌───────────┬───────────┬───────────┬───────────┬───────────┬──────────────┬───────────┬────────┐
│ Stat      │ 1%        │ 2.5%      │ 50%       │ 97.5%     │ Avg          │ Stdev     │ Min    │
├───────────┼───────────┼───────────┼───────────┼───────────┼──────────────┼───────────┼────────┤
│ Req/Sec   │ 1,043,455 │ 1,054,719 │ 1,108,991 │ 1,174,527 │ 1,107,616.61 │ 51,173.07 │ 69,960 │
├───────────┼───────────┼───────────┼───────────┼───────────┼──────────────┼───────────┼────────┤
│ Bytes/Sec │ 164 MB    │ 166 MB    │ 174 MB    │ 185 MB    │ 174 MB       │ 8.04 MB   │ 11 MB  │
└───────────┴───────────┴───────────┴───────────┴───────────┴──────────────┴───────────┴────────┘

Req/Bytes counts sampled once per second.
# of samples: 86400

0 2xx responses, 1993725895 non 2xx responses
1993728k requests in 1800.18s, 313 GB read

Status codes: { '302': { count: 1993725895 } }
Done in 1801.34s.
```
