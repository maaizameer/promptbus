import { env } from "node:process";
import { initDb } from "./core/logger/logger.js";
import { startProxy } from "./core/proxy/server.js";
import { startDashboard } from "./dashboard/server.js";

const PROXY_PORT = parseInt(env.PROMPTBUS_PORT ?? "4701", 10);
const DASHBOARD_PORT = parseInt(env.PROMPTBUS_DASHBOARD_PORT ?? "4702", 10);

initDb();
startProxy(PROXY_PORT);
startDashboard(DASHBOARD_PORT);
