import { createPrisma } from "../db.js";
import { LocalFsStorage } from "../adapters/storage.js";
import { seed, SEED_IDS } from "../../../../prisma/seed.js";
import { seedDocuments } from "../seed-documents.js";

const db = createPrisma();
await seed(db);
await seedDocuments(
  db,
  new LocalFsStorage(process.env.STORAGE_DIR ?? "./storage"),
  { userId: SEED_IDS.user, householdId: SEED_IDS.household, role: "OWNER", correlationId: "seed" },
  SEED_IDS.appliance,
);
console.log("seeded users, households, appliances and documents");
await db.$disconnect();
