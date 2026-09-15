import { getDb } from './src/lib/db.js';
import { users } from './src/db/schema.js';
import { hashPassword } from './src/lib/auth.js';

async function seedAdmins() {
  const db = getDb();
  
  const adminPasswordHash = await hashPassword('admin123');
  const superadminPasswordHash = await hashPassword('superadmin123');
  
  await db.insert(users).values([
    {
      id: crypto.randomUUID(),
      email: 'admin@jobned.com',
      passwordHash: adminPasswordHash,
      firstName: 'Admin',
      lastName: 'User',
      userType: 'admin',
      verifiedStatus: 'verified',
      isActive: true
    },
    {
      id: crypto.randomUUID(),
      email: 'superadmin@jobned.com',
      passwordHash: superadminPasswordHash,
      firstName: 'Super',
      lastName: 'Admin',
      userType: 'superadmin',
      verifiedStatus: 'verified',
      isActive: true
    }
  ]);
  
  console.log("Successfully created admin and superadmin accounts.");
}

seedAdmins().catch(console.error);
