import { pool } from "../src/database/index.js";
import { applySchema, seedCodes } from "../src/database/schema.js";

await applySchema(pool);
await seedCodes(pool);