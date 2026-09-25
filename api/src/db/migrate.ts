import { migrate, db } from "./index.js";
await migrate();
await db.end();
