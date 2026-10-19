// Starts a real PostgreSQL 17 (embedded-postgres) on :54329 matching docker-compose creds.
import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";
const dir = ".pgdata";
const pg = new EmbeddedPostgres({ databaseDir: dir, user: "fixloop", password: "fixloop", port: 54329, persistent: true });
if (!existsSync(`${dir}/PG_VERSION`)) await pg.initialise();
await pg.start();
try { await pg.createDatabase("fixloop"); } catch { /* exists */ }
console.log("postgres ready on 54329");
process.on("SIGINT", async () => { await pg.stop(); process.exit(0); });
setInterval(() => {}, 1 << 30);
