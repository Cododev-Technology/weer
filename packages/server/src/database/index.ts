import pkg from "pg";
import type { TTables, IUser, IUrl, ISession } from "./types.js";
import keys from "../config/keys.js";

/**
 * @important Run the seed.js file first to get our tables and triggers
 */

// Make properties of a type optional
type Partial<T> = {
  [P in keyof T]?: T[P];
};

// Connect to the postgres database
export const pool = new pkg.Pool({
  user: keys.dbUser,
  host: keys.dbHost,
  database: keys.dbDatabase,
  password: keys.dbPassword,
  port: keys.dbPort,
  ssl:
    process.env.NODE_ENV === "production"
      ? {
          rejectUnauthorized: false,
        }
      : false,
  max: keys.dbPoolSize, // this means how many concurrent connections to the database this node process can have (DB_POOL_SIZE, 10 by default)
  idleTimeoutMillis: 10000, // close idle clients after 10 seconds
});

pool.query("SELECT NOW()", (err, res) => {
  if (err) {
    console.error("[postgres] connection failed.");
    console.error("Error details:\n", err);
    process.exit(1);
  } else {
    console.log("[postgres] connected successfully to " + keys.dbDatabase);
  }
});

/** Uncomment for debugging connection pool stats:
// Log database pool stats every 5 seconds for monitoring
setInterval(() => {
  console.log(`[Process ${process.pid}] DB Stats:`, {
    total: pool.totalCount, // total connections existing in this pool
    idle: pool.idleCount, // connections waiting for work
    waiting: pool.waitingCount, // requests waiting for a connection to open up
  });
}, 5000);
*/

// Clean null values from the result
const cleanResult = (data: any) => {
  if (Array.isArray(data)) {
    return data.map((row) =>
      Object.fromEntries(Object.entries(row).filter(([_, v]) => v !== null)),
    );
  }

  if (data && typeof data === "object") {
    return Object.fromEntries(
      Object.entries(data).filter(([_, v]) => v !== null),
    );
  }

  return data;
};

// Fetch from the database, returns only one object or null
const find = <T>(query: string, values: any[] = [], client?: pkg.PoolClient): Promise<T | null> => {
  return new Promise((resolve, reject) => {
    (client || pool).query(query, values, (err, res) => {
      if (err) return reject(err);

      let rows: any[];
      if (res && res.rows != null) {
        rows = res.rows;
      } else {
        rows = [];
      }

      if (rows.length === 0) return resolve(null);
      return resolve(rows[0] as T);
    });
  });
};

// Fetch from database all in one array
const findMany = <T>(query: string, values: any[] = [], client?: pkg.PoolClient): Promise<T[]> => {
  return new Promise((resolve, reject) => {
    (client || pool).query(query, values, (err, res) => {
      if (err) return reject(err);

      let rows: any[];
      if (res && res.rows != null) {
        rows = res.rows;
      } else {
        rows = [];
      }

      return resolve(rows as T[]);
    });
  });
};

// Insert an item to the the specified table
const insert = <T>(table: TTables, data: Partial<T>, client?: pkg.PoolClient) => {
  return new Promise(function (resolve: (insertedData: T) => void, reject) {
    const _values: any[] = [];
    let _valuesSpecifiers = "";
    let _columns = "";

    // prepare our data for sql based on the data object provided
    Object.keys(data).map((key, index) => {
      _valuesSpecifiers += `$${index + 1}, `;
      _columns += key + ", ";
      _values.push(data[key as keyof typeof data]);
    });

    // remove the last 2 characters of value specifiers and columns
    _valuesSpecifiers = _valuesSpecifiers.slice(0, -2);
    _columns = _columns.slice(0, -2);

    const query = `INSERT INTO ${table}(${_columns}) VALUES (${_valuesSpecifiers}) RETURNING *`;

    (client || pool).query(query, _values, function (error, result) {
      if (error) {
        reject(error);
      } else {
        resolve(result.rows[0]);
      }
    });
  });
};

// Update an item in a specific table
const update = <T>(
  table: TTables,
  data: Partial<T>,
  where: string,
  valuesForWhere: any[] = [],
  client?: pkg.PoolClient,
) => {
  return new Promise(function (resolve: (result: any) => void, reject) {
    let _columnsWithValueSpecifiers = "";
    let _values: any[] = [];

    // prepare our data for sql based on the data object provided
    Object.keys(data).map((key, index) => {
      _columnsWithValueSpecifiers += `${key} = $${index + 1}, `;
      _values.push(data[key as keyof T]);
    });

    // remove the last 2 characters
    _columnsWithValueSpecifiers = _columnsWithValueSpecifiers.slice(0, -2);

    // values in the where condition
    if (valuesForWhere.length) {
      _values = [..._values, ...valuesForWhere];
    }

    // Final query
    const query = `UPDATE ${table} SET ${_columnsWithValueSpecifiers} WHERE ${where}`;

    // Validate the where condition, since developer might not know where the index was ended, they might go with $1. Check of the $ values don't count exactly from index, throw an error
    const whereDollarSigns = where.match(/\$\d+/g);
    if (whereDollarSigns) {
      whereDollarSigns.forEach((sign) => {
        const number = parseInt(sign.replace("$", ""));
        if (number + 1 !== _values.length + 1) {
          throw new Error(
            `The where condition has a value specifier ${sign} which is out of range. \nThe final query looks like this which is invalid: ${query}`,
          );
        }
      });
    }

    (client || pool).query(query, _values, function (error, result) {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    });
  });
};

// Delete from the database
const del = <T>(table: TTables, where: string, values: any[] = [], client?: pkg.PoolClient) => {
  return new Promise(function (resolve: (value: T | null) => void, reject) {
    (client || pool).query(
      `DELETE FROM ${table} WHERE ${where} RETURNING *`,
      values,
      function (err, res) {
        if (err) {
          reject(err);
        } else {
          if (res.rows.length === 1) return resolve(res.rows[0] as T);
          if (!res.rows || !res.rows.length) return resolve(null);
          resolve(res.rows as any);
        }
      },
    );
  });
};

// For any general query, will be used for less common and more advanced queries
const query = (query: string, values: any[] = [], client?: pkg.PoolClient) => {
  return new Promise(function (resolve: (value: any) => void, reject) {
    (client || pool).query(query, values, function (err, res) {
      if (err) {
        reject(err);
      } else {
        resolve(res.rows);
      }
    });
  });
};

const beginTransaction = async (): Promise<pkg.PoolClient> => {
  const client = await pool.connect();
  await client.query("BEGIN");
  return client;
};

const commit = async (client: pkg.PoolClient): Promise<void> => {
  await client.query("COMMIT");
  client.release();
};

const rollback = async (client: pkg.PoolClient): Promise<void> => {
  await client.query("ROLLBACK");
  client.release();
};

export const DB = {
  find,
  findMany,
  insert,
  update,
  delete: del,
  query,
  cleanResult,
  beginTransaction,
  commit,
  rollback,
};
