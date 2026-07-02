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

  // ¿Existe una tabla "reportes" de la versión anterior (plana, un producto por fila)?
  const { rows: colsAntiguas } = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'reportes' AND column_name = 'producto'
  `);
  const requiereMigracion = colsAntiguas.length > 0;

  if (requiereMigracion) {
    await pool.query('ALTER TABLE reportes RENAME TO reportes_old;');
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reportes (
      id SERIAL PRIMARY KEY,
      usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      nombre TEXT NOT NULL DEFAULT 'Reporte',
      fecha DATE NOT NULL DEFAULT CURRENT_DATE,
      fecha_creacion TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reporte_items (
      id SERIAL PRIMARY KEY,
      reporte_id INTEGER NOT NULL REFERENCES reportes(id) ON DELETE CASCADE,
      producto TEXT NOT NULL,
      cantidad INTEGER NOT NULL DEFAULT 0,
      precio NUMERIC(10,2) NOT NULL DEFAULT 0,
      monto NUMERIC(10,2) NOT NULL DEFAULT 0,
      fecha_creacion TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  if (requiereMigracion) {
    const { rows: viejos } = await pool.query('SELECT * FROM reportes_old ORDER BY id ASC');
    for (const fila of viejos) {
      const { rows: nuevoReporte } = await pool.query(
        `INSERT INTO reportes (usuario_id, nombre, fecha, fecha_creacion) VALUES ($1, $2, $3, $4) RETURNING id`,
        [fila.usuario_id, fila.nombre_reporte || 'Reporte', fila.fecha_creacion, fila.fecha_creacion]
      );
      await pool.query(
        `INSERT INTO reporte_items (reporte_id, producto, cantidad, precio, monto, fecha_creacion) VALUES ($1, $2, $3, $4, $5, $6)`,
        [nuevoReporte[0].id, fila.producto, fila.cantidad, fila.precio, fila.monto, fila.fecha_creacion]
      );
    }
    await pool.query('DROP TABLE reportes_old;');
    console.log(`Migración completada: ${viejos.length} registros antiguos convertidos a la nueva estructura de reportes.`);
  }

  // Usuario administrador por defecto
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
