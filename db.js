require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

if (!process.env.DATABASE_URL) {
  console.error('ERROR: falta la variable de entorno DATABASE_URL.');
  console.error('Crea un archivo .env (mira .env.example) con tu cadena de conexión de Neon.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      usuario TEXT UNIQUE NOT NULL,
      contrasena TEXT NOT NULL,
      fecha_creacion TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reportes (
      id SERIAL PRIMARY KEY,
      usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      nombre_reporte TEXT NOT NULL DEFAULT '',
      producto TEXT NOT NULL,
      cantidad INTEGER NOT NULL DEFAULT 0,
      precio NUMERIC(10,2) NOT NULL DEFAULT 0,
      monto NUMERIC(10,2) NOT NULL DEFAULT 0,
      fecha_creacion TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  // Por si la tabla ya existía de una versión anterior sin esta columna
  await pool.query(`ALTER TABLE reportes ADD COLUMN IF NOT EXISTS nombre_reporte TEXT NOT NULL DEFAULT '';`);

  // Crear usuario administrador por defecto si no existe ningún usuario todavía
  const { rows } = await pool.query('SELECT COUNT(*)::int AS total FROM usuarios');
  if (rows[0].total === 0) {
    const hash = await bcrypt.hash('admin123', 10);
    await pool.query(
      `INSERT INTO usuarios (nombre, email, usuario, contrasena) VALUES ($1, $2, $3, $4)`,
      ['Administrador', 'admin@gastos.com', 'admin', hash]
    );
    console.log('Usuario administrador creado: usuario="admin" contraseña="admin123" (cámbiala después de iniciar sesión)');
  }
}

module.exports = { pool, init };
