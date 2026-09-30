import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
migrate(drizzle(pool), { migrationsFolder: "./drizzle" })
  .then(() => console.log("migrations applied"))
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => pool.end());
