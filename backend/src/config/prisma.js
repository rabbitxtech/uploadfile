import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

// JSON-serialize BigInt as string (Prisma uses BigInt for `size`, `quotaBytes`, ...)
BigInt.prototype.toJSON = function () {
  return this.toString();
};
