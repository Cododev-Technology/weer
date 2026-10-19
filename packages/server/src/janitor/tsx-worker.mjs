// In development the janitor runs from its TypeScript with tsx, whose loader doesn't reach worker
// threads. So there a drain thread (see cluster.ts) starts here: it registers tsx first, then loads
// cluster.ts. (The compiled janitor starts its threads directly, so tsx, a dev dependency, isn't
// needed then.)
import { register } from "tsx/esm/api";
import { workerData } from "node:worker_threads";

register();
await import(workerData.entry);
