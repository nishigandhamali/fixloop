import { PrismaClient } from "@prisma/client";
export const createPrisma = (url?: string) => new PrismaClient(url ? { datasources: { db: { url } } } : undefined);
export type Db = PrismaClient;
