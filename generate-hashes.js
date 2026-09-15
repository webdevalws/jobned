import bcrypt from 'bcryptjs';
import fs from 'fs';

async function generateHashes() {
  const adminHash = await bcrypt.hash('admin123', 12);
  const superadminHash = await bcrypt.hash('superadmin123', 12);
  
  const sql = `
  INSERT INTO users (id, email, password_hash, first_name, last_name, user_type, verified_status, is_active)
  VALUES 
    ('${crypto.randomUUID()}', 'admin@jobned.com', '${adminHash}', 'Admin', 'User', 'admin', 'verified', 1),
    ('${crypto.randomUUID()}', 'superadmin@jobned.com', '${superadminHash}', 'Super', 'Admin', 'superadmin', 'verified', 1);
  `;
  
  fs.writeFileSync('insert-admins.sql', sql, 'utf8');
  console.log("SQL file generated as UTF-8.");
}

generateHashes();
