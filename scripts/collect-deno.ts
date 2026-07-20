import config from "../config/packages.json" with { type: "json" };
import { collectAll } from "../deno/collector.ts";
import { ensurePackages, type PackageConfig } from "../deno/store.ts";

const kv = await Deno.openKv(Deno.env.get("DENO_KV_PATH"));
await ensurePackages(kv, config.packages as PackageConfig[]);
console.log(JSON.stringify(await collectAll(kv), null, 2));
kv.close();
