import bcrypt from 'bcryptjs';
import fs from 'fs';
import crypto from 'crypto';

async function generateMasterAdminSQL() {
  const masteradminHash = await bcrypt.hash('masteradmin123', 12);
  
  const sql = `
  INSERT OR REPLACE INTO users (id, email, password_hash, first_name, last_name, user_type, verified_status, is_active)
  VALUES 
    ('${crypto.randomUUID()}', 'masteradmin@jobned.com', '${masteradminHash}', 'Master', 'Admin', 'masteradmin', 'verified', 1);
  `;
  
  fs.writeFileSync('insert-masteradmin.sql', sql, 'utf8');
  console.log("MasterAdmin SQL seed file generated as UTF-8.");
}

generateMasterAdminSQL();
