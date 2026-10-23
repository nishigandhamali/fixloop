import { PrismaClient } from "@prisma/client";

/** Clearly synthetic data: one household, one dishwasher. Idempotent. */
export const SEED_IDS = {
  user: "00000000-0000-4000-8000-000000000001",
  household: "00000000-0000-4000-8000-000000000002",
  appliance: "00000000-0000-4000-8000-000000000003",
  otherUser: "00000000-0000-4000-8000-000000000011",
  otherHousehold: "00000000-0000-4000-8000-000000000012",
  otherAppliance: "00000000-0000-4000-8000-000000000013",
} as const;

export async function seed(db: PrismaClient) {
  await db.user.upsert({
    where: { id: SEED_IDS.user },
    update: {},
    create: { id: SEED_IDS.user, email: "demo@fixloop.example", displayName: "Demo Owner" },
  });
  await db.household.upsert({
    where: { id: SEED_IDS.household },
    update: {},
    create: { id: SEED_IDS.household, ownerUserId: SEED_IDS.user, name: "Demo Household (synthetic)" },
  });
  await db.householdMember.upsert({
    where: { householdId_userId: { householdId: SEED_IDS.household, userId: SEED_IDS.user } },
    update: {},
    create: { householdId: SEED_IDS.household, userId: SEED_IDS.user, role: "OWNER" },
  });
  await db.appliance.upsert({
    where: { id: SEED_IDS.appliance },
    update: {},
    create: {
      id: SEED_IDS.appliance,
      householdId: SEED_IDS.household,
      category: "DISHWASHER",
      brand: "Aquavelle",
      modelNumber: "AQ-DW450",
      serialNumber: "SYNTH-0001",
      location: "Kitchen",
      notes: "Synthetic demo appliance",
    },
  });
  // A second household used to prove cross-household isolation.
  await db.user.upsert({
    where: { id: SEED_IDS.otherUser },
    update: {},
    create: { id: SEED_IDS.otherUser, email: "other@fixloop.example", displayName: "Other Owner" },
  });
  await db.household.upsert({
    where: { id: SEED_IDS.otherHousehold },
    update: {},
    create: { id: SEED_IDS.otherHousehold, ownerUserId: SEED_IDS.otherUser, name: "Other Household (synthetic)" },
  });
  await db.householdMember.upsert({
    where: { householdId_userId: { householdId: SEED_IDS.otherHousehold, userId: SEED_IDS.otherUser } },
    update: {},
    create: { householdId: SEED_IDS.otherHousehold, userId: SEED_IDS.otherUser, role: "OWNER" },
  });
  await db.appliance.upsert({
    where: { id: SEED_IDS.otherAppliance },
    update: {},
    create: {
      id: SEED_IDS.otherAppliance,
      householdId: SEED_IDS.otherHousehold,
      category: "OVEN",
      brand: "Zenith",
      modelNumber: "ZN-OV9",
      location: "Kitchen",
    },
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = new PrismaClient();
  seed(db)
    .then(() => console.log("seeded"))
    .finally(() => db.$disconnect());
}
