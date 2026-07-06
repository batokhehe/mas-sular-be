/**
 * Seed ProductInventory (per-outlet source of truth) from the legacy Product.stock,
 * assigning it to the active outlet. Idempotent (upsert on productId+outletId).
 * Run:  npm run prisma:seed:inventory
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const outlet = await prisma.outlet.findFirst({ where: { isActive: true } });
  if (!outlet) {
    console.log('[seed-inventory] No active outlet — activate one first. Skipping.');
    return;
  }
  const products = await prisma.product.findMany({ where: { deletedAt: null }, select: { id: true, stock: true } });
  let count = 0;
  for (const p of products) {
    await prisma.productInventory.upsert({
      where: { productId_outletId: { productId: p.id, outletId: outlet.id } },
      update: {}, // don't clobber an already-managed per-outlet stock on re-run
      create: { productId: p.id, outletId: outlet.id, stock: p.stock, reserved: 0, available: p.stock },
    });
    count += 1;
  }
  console.log(`[seed-inventory] Upserted ${count} ProductInventory rows for outlet "${outlet.name}".`);
}

main()
  .catch((e) => {
    console.error('[seed-inventory] Failed:', e);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
