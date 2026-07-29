const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: 'postgresql://postgres:' + encodeURIComponent(process.env.SUPABASE_DB_PASSWORD) + '@db.nspnbthqozzjewkgoeyn.supabase.co:5432/postgres'
});

async function run() {
  await client.connect();
  
  // 1. Check trigger on auth.users
  const triggerQuery = `
    SELECT p.proname, pg_get_functiondef(p.oid) as function_body
    FROM pg_trigger t
    JOIN pg_proc p ON t.tgfoid = p.oid
    WHERE t.tgrelid = 'auth.users'::regclass;
  `;
  const res = await client.query(triggerQuery);
  console.log("Triggers on auth.users:", res.rows);
  
  await client.end();
}

run().catch(console.error);
