import Database from 'better-sqlite3';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const isPostgres = !!process.env.DATABASE_URL;

// Unified Database Interface
interface DBAdapter {
  get(sql: string, ...params: any[]): Promise<any>;
  all(sql: string, ...params: any[]): Promise<any[]>;
  run(sql: string, ...params: any[]): Promise<{ lastInsertRowid?: number | string; changes?: number }>;
  prepare(sql: string): {
    get: (...params: any[]) => any; // Sync for SQLite (legacy support if needed, but we'll try to move to async)
    all: (...params: any[]) => any[];
    run: (...params: any[]) => { lastInsertRowid: number | bigint; changes: number };
  } | any; // For PG we might not support prepare in the same way
}

class PostgresDB {
  pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({
      connectionString,
      ssl: { rejectUnauthorized: false } // Required for Render
    });
    
    // The pool will emit an error on behalf of any idle client
    // it contains if a backend error or network partition happens
    this.pool.on('error', (err, client) => {
      console.error('Unexpected error on idle client', err);
      // process.exit(-1); // Optional: force restart on fatal DB error
    });
  }

  // Helper to convert ? to $1, $2, etc.
  private convertSql(sql: string): string {
    let i = 1;
    return sql.replace(/\?/g, () => `$${i++}`);
  }

  async get(sql: string, ...params: any[]) {
    const res = await this.pool.query(this.convertSql(sql), params);
    return res.rows[0];
  }

  async all(sql: string, ...params: any[]) {
    const res = await this.pool.query(this.convertSql(sql), params);
    return res.rows;
  }

  async run(sql: string, ...params: any[]) {
    const convertedSql = this.convertSql(sql);
    
    let finalSql = convertedSql;
    const isInsert = /^\s*INSERT\s/i.test(finalSql);
    // friends table has composite PK and no 'id' column
    const isFriendsTable = /INSERT\s+INTO\s+friends\s+/i.test(finalSql);
    
    if (isInsert && !/RETURNING/i.test(finalSql) && !isFriendsTable) {
        finalSql += ' RETURNING id';
    }

    try {
      const res = await this.pool.query(finalSql, params);
      
      return {
        lastInsertRowid: isInsert && res.rows[0] ? res.rows[0].id : 0,
        changes: res.rowCount || 0
      };
    } catch (error) {
      console.error('Database Error in run():', error);
      console.error('Failed SQL:', finalSql);
      console.error('Params:', params);
      throw error;
    }
  }

  // Mock prepare to ease migration, but it will return async functions
  prepare(sql: string) {
    return {
      get: async (...params: any[]) => this.get(sql, ...params),
      all: async (...params: any[]) => this.all(sql, ...params),
      run: async (...params: any[]) => this.run(sql, ...params)
    };
  }
}

class SqliteDB {
  db: Database.Database;

  constructor() {
    this.db = new Database('app.db', { verbose: console.log });
  }

  async get(sql: string, ...params: any[]) {
    return this.db.prepare(sql).get(...params);
  }

  async all(sql: string, ...params: any[]) {
    return this.db.prepare(sql).all(...params);
  }

  async run(sql: string, ...params: any[]) {
    return this.db.prepare(sql).run(...params);
  }

  prepare(sql: string) {
    const stmt = this.db.prepare(sql);
    return {
      get: (...params: any[]) => stmt.get(...params),
      all: (...params: any[]) => stmt.all(...params),
      run: (...params: any[]) => stmt.run(...params)
    };
  }
}

export const db = isPostgres 
  ? new PostgresDB(process.env.DATABASE_URL!) 
  : new SqliteDB();

export async function initDb() {
  if (isPostgres) {
    const pgDb = db as PostgresDB;
    await pgDb.pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        telegram_id TEXT UNIQUE NOT NULL,
        first_name TEXT NOT NULL,
        last_name TEXT,
        username TEXT,
        photo_url TEXT,
        role TEXT DEFAULT 'user',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS app_invites (
        id SERIAL PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        created_by INTEGER NOT NULL,
        used_by INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        used_at TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users (id),
        FOREIGN KEY (used_by) REFERENCES users (id)
      );

      CREATE TABLE IF NOT EXISTS friend_links (
        id SERIAL PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        created_by INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users (id)
      );

      CREATE TABLE IF NOT EXISTS friends (
        user_id_1 INTEGER NOT NULL,
        user_id_2 INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id_1, user_id_2),
        FOREIGN KEY (user_id_1) REFERENCES users (id),
        FOREIGN KEY (user_id_2) REFERENCES users (id)
      );
    `);
  } else {
    const sqliteDb = (db as SqliteDB).db;
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id TEXT UNIQUE NOT NULL,
        first_name TEXT NOT NULL,
        last_name TEXT,
        username TEXT,
        photo_url TEXT,
        role TEXT DEFAULT 'user',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS app_invites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        created_by INTEGER NOT NULL,
        used_by INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        used_at DATETIME,
        FOREIGN KEY (created_by) REFERENCES users (id),
        FOREIGN KEY (used_by) REFERENCES users (id)
      );

      CREATE TABLE IF NOT EXISTS friend_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        created_by INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users (id)
      );

      CREATE TABLE IF NOT EXISTS friends (
        user_id_1 INTEGER NOT NULL,
        user_id_2 INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id_1, user_id_2),
        FOREIGN KEY (user_id_1) REFERENCES users (id),
        FOREIGN KEY (user_id_2) REFERENCES users (id)
      );
    `);
  }
  console.log(`Database initialized (${isPostgres ? 'PostgreSQL' : 'SQLite'})`);
}
