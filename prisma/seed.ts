import * as bcrypt from 'bcryptjs';
import { PrismaClient, ProductStatus } from '@prisma/client';

const prisma = new PrismaClient();

const categories = [
  { name: 'Baso Urat', slug: 'baso-urat', icon: '🍖' },
  { name: 'Baso Mercon', slug: 'baso-mercon', icon: '🌶️' },
  { name: 'Baso Keju', slug: 'baso-keju', icon: '🧀' },
  { name: 'Baso Frozen', slug: 'baso-frozen', icon: '❄️' },
  { name: 'Minuman', slug: 'minuman', icon: '🥤' },
];

const products = [
  ['baso-urat-jumbo', 'Baso Urat Jumbo', 45000, 55000, '/products/baso-urat-jumbo.jpg', 'baso-urat', 4.8, 234, 0, true, false, 50],
  ['baso-mercon-super-pedas', 'Baso Mercon Super Pedas', 42000, null, '/products/baso-mercon.jpg', 'baso-mercon', 4.7, 189, 3, true, false, 35],
  ['baso-keju-mozarella', 'Baso Keju Mozarella', 48000, null, '/products/baso-keju.jpg', 'baso-keju', 4.9, 312, 0, false, true, 40],
  ['frozen-baso-urat-20pcs', 'Frozen Baso Urat (20pcs)', 85000, 100000, '/products/frozen-baso-urat.jpg', 'baso-frozen', 4.7, 267, null, false, false, 100],
  ['es-teh-manis', 'Es Teh Manis', 8000, null, '/products/es-teh.jpg', 'minuman', 4.5, 445, null, false, false, 200],
] as const;

async function main(): Promise<void> {
  const roles = [
    'SUPER_ADMIN',
    'ADMIN',
    'MANAGER',
    'STAFF',
    'CUSTOMER',
  ];

  for (const role of roles) {
    await prisma.role.upsert({
      where: { name: role },
      update: {},
      create: { name: role },
    });
  }

  for (const [index, category] of categories.entries()) {
    await prisma.category.upsert({
      where: { slug: category.slug },
      update: { ...category, sortOrder: index },
      create: { ...category, sortOrder: index },
    });
  }

  const categoryBySlug = new Map((await prisma.category.findMany()).map((c) => [c.slug, c.id]));

  for (const p of products) {
    const [slug, name, price, originalPrice, imageUrl, categorySlug, rating, reviewCount, spicyLevel, isBestSeller, isNew, stock] = p;
    await prisma.product.upsert({
      where: { slug },
      update: {},
      create: {
        slug,
        sku: slug.toUpperCase().replaceAll('-', '_'),
        name,
        description: `${name} premium Bakso Mas Sular dengan bahan berkualitas dan rasa autentik.`,
        price,
        originalPrice,
        imageUrl,
        categoryId: categoryBySlug.get(categorySlug)!,
        rating,
        reviewCount,
        spicyLevel,
        isBestSeller,
        isNew,
        stock,
        status: ProductStatus.ACTIVE,
      },
    });
  }

  for (const topping of [
    ['Mie Kuning', 5000],
    ['Bihun', 5000],
    ['Tahu Goreng', 3000],
    ['Siomay', 4000],
    ['Pangsit Goreng', 4000],
    ['Telur Puyuh', 5000],
    ['Extra Sambal', 2000],
    ['Kerupuk', 3000],
  ] as const) {
    await prisma.topping.upsert({
      where: { id: topping[0].toLowerCase().replaceAll(' ', '-') },
      update: {},
      create: { id: topping[0].toLowerCase().replaceAll(' ', '-'), name: topping[0], price: topping[1] },
    });
  }

  await prisma.promo.upsert({
    where: { code: 'NEWUSER20' },
    update: {},
    create: {
      code: 'NEWUSER20',
      title: 'Diskon 20% Pembelian Pertama',
      description: 'Khusus pengguna baru.',
      voucherType: 'PERCENTAGE_DISCOUNT',
      discountPercentage: 20,
      minimumOrderAmount: 0,
      isNewUserOnly: true,
      isActive: true,
    },
  });

  const adminPasswordHash = await bcrypt.hash('admin', 12);
  const adminUser = await prisma.admin.upsert({
    where: { email: 'admin@test.com' },
    update: {
      name: 'Super Admin',
      passwordHash: adminPasswordHash,
      isActive: true,
    },
    create: {
      email: 'admin@test.com',
      passwordHash: adminPasswordHash,
      name: 'Super Admin',
      isActive: true,
    },
  });

  const permissionsList = [
    { subject: 'Dashboard', action: 'read' },
    { subject: 'Product', action: 'read' },
    { subject: 'Product', action: 'create' },
    { subject: 'Product', action: 'update' },
    { subject: 'Product', action: 'delete' },
    { subject: 'Category', action: 'read' },
    { subject: 'Category', action: 'create' },
    { subject: 'Category', action: 'update' },
    { subject: 'Category', action: 'delete' },
    { subject: 'Promo', action: 'read' },
    { subject: 'Promo', action: 'create' },
    { subject: 'Promo', action: 'update' },
    { subject: 'Promo', action: 'delete' },
    { subject: 'Banner', action: 'read' },
    { subject: 'Banner', action: 'create' },
    { subject: 'Banner', action: 'update' },
    { subject: 'Banner', action: 'delete' },
    { subject: 'Order', action: 'read' },
    { subject: 'Order', action: 'update' },
    { subject: 'Payment', action: 'read' },
    { subject: 'Payment', action: 'verify' },
    { subject: 'Payment', action: 'reject' },
    { subject: 'Shipment', action: 'read' },
    { subject: 'Shipment', action: 'create' },
    { subject: 'Shipment', action: 'update' },
    { subject: 'Shipment', action: 'delete' },
    { subject: 'User', action: 'read' },
    { subject: 'User', action: 'update' },
    { subject: 'Role', action: 'read' },
    { subject: 'Role', action: 'create' },
    { subject: 'Role', action: 'update' },
    { subject: 'Role', action: 'delete' },
    { subject: 'DeliveryCoverage', action: 'read' },
    { subject: 'DeliveryCoverage', action: 'create' },
    { subject: 'DeliveryCoverage', action: 'update' },
    { subject: 'DeliveryCoverage', action: 'delete' },
    { subject: 'SystemLog', action: 'read' },
    { subject: 'Queue', action: 'read' },
    { subject: 'Queue', action: 'retry' },
    { subject: 'Incident', action: 'read' },
    { subject: 'Incident', action: 'manage' },
    { subject: 'Notification', action: 'read' },
    { subject: 'Notification', action: 'resend' },
    { subject: 'Audit', action: 'read' },
    { subject: 'Audit', action: 'export' },
    { subject: 'Notification', action: 'manage' },
    { subject: 'dashboard', action: 'view' },
    { subject: 'products', action: 'view' },
    { subject: 'products', action: 'create' },
    { subject: 'products', action: 'update' },
    { subject: 'products', action: 'delete' },
    { subject: 'categories', action: 'view' },
    { subject: 'categories', action: 'create' },
    { subject: 'categories', action: 'update' },
    { subject: 'categories', action: 'delete' },
    { subject: 'orders', action: 'view' },
    { subject: 'orders', action: 'update' },
    { subject: 'customers', action: 'view' },
    { subject: 'roles', action: 'view' },
    { subject: 'roles', action: 'create' },
    { subject: 'roles', action: 'update' },
    { subject: 'roles', action: 'delete' },
    { subject: 'paymentAccounts', action: 'view' },
    { subject: 'paymentAccounts', action: 'create' },
    { subject: 'paymentAccounts', action: 'update' },
    { subject: 'paymentAccounts', action: 'delete' },
    { subject: 'paymentAccounts', action: 'activate' },
    { subject: 'Outlet', action: 'read' },
    { subject: 'Outlet', action: 'create' },
    { subject: 'Outlet', action: 'update' },
    { subject: 'Outlet', action: 'delete' },
    { subject: 'Outlet', action: 'activate' },
    { subject: 'InventoryReservation', action: 'read' },
    { subject: 'ProductInventory', action: 'read' },
    { subject: 'ProductInventory', action: 'update' },
    { subject: 'StockTransfer', action: 'read' },
    { subject: 'StockTransfer', action: 'create' },
    { subject: 'StockTransfer', action: 'update' },
  ];

  // One active, visible payment account so checkout WhatsApp notifications resolve.
  await prisma.paymentAccount.upsert({
    where: { accountNumber: '1234567890' },
    update: {},
    create: {
      bankName: 'BCA',
      bankCode: '014',
      accountName: 'Bakso Mas Sular',
      accountNumber: '1234567890',
      isActive: true,
      isVisible: true,
      displayOrder: 0,
    },
  });

  const dbPermissions = [];
  for (const perm of permissionsList) {
    const dbPerm = await prisma.permission.upsert({
      where: {
        action_subject: {
          action: perm.action,
          subject: perm.subject,
        },
      },
      update: {},
      create: {
        action: perm.action,
        subject: perm.subject,
        description: `Permission for ${perm.subject} ${perm.action}`,
      },
    });
    dbPermissions.push(dbPerm);
  }

  const superAdminRole = await prisma.role.findUnique({
    where: { name: 'SUPER_ADMIN' },
  });

  if (superAdminRole) {
    // Link permissions to SUPER_ADMIN role
    for (const perm of dbPermissions) {
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: superAdminRole.id,
            permissionId: perm.id,
          },
        },
        update: {},
        create: {
          roleId: superAdminRole.id,
          permissionId: perm.id,
        },
      });
    }

    // Link admin user to SUPER_ADMIN role
    await prisma.adminRole.upsert({
      where: {
        adminId_roleId: {
          adminId: adminUser.id,
          roleId: superAdminRole.id,
        },
      },
      update: {},
      create: {
        adminId: adminUser.id,
        roleId: superAdminRole.id,
      },
    });
  }
}

main().finally(async () => prisma.$disconnect());
