#!/usr/bin/env node
/**
 * Simple migration runner for TimescaleDB.
 * Runs .sql files in backend/db/migrations/ in lexical order.
 *
 * Usage:
 *   DB_PASSWORD=secret node backend/db/migrate.js
 *
 * Environment:
 *   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD (see config.js)
 */

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const dbConfig = require('./config');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function migrate() {
  if (!dbConfig.password) {
    console.error('ERROR: DB_PASSWORD is required. Set it via environment variable.');
    process.exit(1);
  }

  const client = new Client({
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.database,
    user: dbConfig.user,
    password: dbConfig.password,
    ssl: dbConfig.ssl,
  });

  try {
    await client.connect();
    console.log(`Connected to ${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`);

    // Create migrations tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Get already-applied migrations
    const { rows: applied } = await client.query('SELECT name FROM _migrations ORDER BY name');
    const appliedSet = new Set(applied.map((r) => r.name));

    // Read and sort migration files
    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    let ran = 0;
    for (const file of files) {
      if (appliedSet.has(file)) {
        console.log(`  SKIP  ${file} (already applied)`);
        continue;
      }

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`  RUN   ${file}`);
      await client.query(sql);
      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
      ran++;
      console.log(`  DONE  ${file}`);
    }

    if (ran === 0) {
      console.log('All migrations already applied.');
    } else {
      console.log(`Applied ${ran} migration(s).`);
    }
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  migrate();
}

module.exports = { migrate };
