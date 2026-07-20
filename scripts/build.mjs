import { writeDashboard } from "./lib.mjs";

const dashboard = await writeDashboard();
console.log(`Built dashboard for ${dashboard.packages.length} packages.`);
