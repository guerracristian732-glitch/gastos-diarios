const http = require('http');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { pool, init } = require('./db');
const { setSessionCookie, clearSessionCookie, getSession } = require('./auth');

// Nota: ya no se restringe a una lista fija; el usuario puede escribir el nombre del trabajo que quiera.

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('No encontrado');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

function serveStatic(req, res, urlPath) {
  let filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Prohibido'); return;
  }
  serveFile(res, filePath);
}

async function usuarioDesdeSesion(req) {
  const sesion = getSession(req);
  if (!sesion || !sesion.id) return null;
  const { rows } = await pool.query('SELECT id, nombre, email, usuario FROM usuarios WHERE id = $1', [sesion.id]);
  return rows[0] || null;
}

async function obtenerReporteCompleto(id) {
  const { rows: reporteRows } = await pool.query('SELECT * FROM reportes WHERE id = $1', [id]);
  if (reporteRows.length === 0) return null;
  const { rows: items } = await pool.query('SELECT * FROM reporte_items WHERE reporte_id = $1 ORDER BY id ASC', [id]);
  const total = items.reduce((s, it) => s + parseFloat(it.monto), 0);
  return { ...reporteRows[0], items, total };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const method = req.method;

  try {
    // ---------- AUTENTICACIÓN ----------

    if (pathname === '/api/login' && method === 'POST') {
      const body = await readBody(req);
      const usuarioInput = (body.usuario || '').trim();
      const contrasenaInput = body.contrasena || '';

      if (!usuarioInput || !contrasenaInput) {
        return sendJSON(res, 400, { success: false, error: 'Completa usuario y contraseña' });
      }

      const { rows } = await pool.query('SELECT * FROM usuarios WHERE usuario = $1 OR email = $1', [usuarioInput]);
      const encontrado = rows[0];
      if (!encontrado) return sendJSON(res, 401, { success: false, error: 'Usuario no encontrado' });

      const valido = await bcrypt.compare(contrasenaInput, encontrado.contrasena);
      if (!valido) return sendJSON(res, 401, { success: false, error: 'Contraseña incorrecta' });

      setSessionCookie(res, { id: encontrado.id });
      return sendJSON(res, 200, { success: true });
    }

    if (pathname === '/api/logout' && method === 'POST') {
      clearSessionCookie(res);
      return sendJSON(res, 200, { success: true });
    }

    if (pathname === '/api/me' && method === 'GET') {
      const usuario = await usuarioDesdeSesion(req);
      if (!usuario) return sendJSON(res, 401, { success: false });
      return sendJSON(res, 200, {
        success: true, id: usuario.id, nombre: usuario.nombre, usuario: usuario.usuario, isAdmin: usuario.id === 1
      });
    }

    const usuarioActual = await usuarioDesdeSesion(req);

    // ---------- REPORTES (contenedor con nombre + fecha, formado por varios items) ----------

    if (pathname === '/api/reportes' && method === 'GET') {
      if (!usuarioActual) return sendJSON(res, 401, { success: false, error: 'No autorizado' });

      const fechaInicio = url.searchParams.get('fecha_inicio');
      const fechaFin = url.searchParams.get('fecha_fin');
      const trabajo = url.searchParams.get('trabajo');

      let query = `
        SELECT r.*,
          COALESCE(json_agg(i.* ORDER BY i.id) FILTER (WHERE i.id IS NOT NULL), '[]') AS items
        FROM reportes r
        LEFT JOIN reporte_items i ON i.reporte_id = r.id
        WHERE r.usuario_id = $1
      `;
      const params = [usuarioActual.id];

      if (fechaInicio && fechaFin) {
        params.push(fechaInicio);
        query += ` AND r.fecha >= $${params.length}`;
        params.push(fechaFin);
        query += ` AND r.fecha <= $${params.length}`;
      }
      if (trabajo && trabajo.trim()) {
        params.push(trabajo);
        query += ` AND r.trabajo = $${params.length}`;
      }
      query += ' GROUP BY r.id ORDER BY r.fecha DESC, r.fecha_creacion DESC';

      const { rows } = await pool.query(query, params);
      const reportes = rows.map(r => ({
        ...r,
        total: r.items.reduce((s, it) => s + parseFloat(it.monto), 0)
      }));
      return sendJSON(res, 200, { success: true, reportes });
    }

    // Crear un reporte nuevo con uno o varios productos (items) de una vez
    if (pathname === '/api/reportes' && method === 'POST') {
      if (!usuarioActual) return sendJSON(res, 401, { success: false, error: 'No autorizado' });

      const body = await readBody(req);
      const { nombre, fecha, items, trabajo } = body;

      if (!nombre || !nombre.trim()) return sendJSON(res, 400, { success: false, error: 'El nombre del reporte es obligatorio' });
      if (!Array.isArray(items) || items.length === 0) return sendJSON(res, 400, { success: false, error: 'Agrega al menos un producto' });
      if (!trabajo || !trabajo.trim()) return sendJSON(res, 400, { success: false, error: 'Escribe o selecciona a qué trabajo pertenece el reporte' });

      const { rows: nuevoReporte } = await pool.query(
        `INSERT INTO reportes (usuario_id, nombre, fecha, trabajo) VALUES ($1, $2, $3, $4) RETURNING *`,
        [usuarioActual.id, nombre.trim(), fecha || new Date().toISOString().slice(0,10), trabajo.trim()]
      );
      const reporteId = nuevoReporte[0].id;

      for (const item of items) {
        if (!item.producto || item.cantidad === undefined || item.precio === undefined) continue;
        const cant = Number(item.cantidad);
        const prec = Number(item.precio);
        await pool.query(
          `INSERT INTO reporte_items (reporte_id, producto, cantidad, precio, monto) VALUES ($1, $2, $3, $4, $5)`,
          [reporteId, item.producto.trim(), cant, prec, cant * prec]
        );
      }

      const reporteCompleto = await obtenerReporteCompleto(reporteId);
      return sendJSON(res, 201, { success: true, reporte: reporteCompleto });
    }

    const matchReporte = pathname.match(/^\/api\/reportes\/(\d+)$/);

    // Actualizar el nombre/fecha del reporte (encabezado)
    if (matchReporte && method === 'PUT') {
      if (!usuarioActual) return sendJSON(res, 401, { success: false, error: 'No autorizado' });
      const id = matchReporte[1];
      const body = await readBody(req);
      const { nombre, fecha, trabajo } = body;
      if (!nombre || !nombre.trim()) return sendJSON(res, 400, { success: false, error: 'El nombre del reporte es obligatorio' });
      if (!trabajo || !trabajo.trim()) return sendJSON(res, 400, { success: false, error: 'Escribe o selecciona a qué trabajo pertenece el reporte' });

      const { rows } = await pool.query(
        `UPDATE reportes SET nombre = $1, fecha = $2, trabajo = $3 WHERE id = $4 AND usuario_id = $5 RETURNING *`,
        [nombre.trim(), fecha, trabajo.trim(), id, usuarioActual.id]
      );
      if (rows.length === 0) return sendJSON(res, 404, { success: false, error: 'Reporte no encontrado' });

      const reporteCompleto = await obtenerReporteCompleto(id);
      return sendJSON(res, 200, { success: true, reporte: reporteCompleto });
    }

    if (matchReporte && method === 'DELETE') {
      if (!usuarioActual) return sendJSON(res, 401, { success: false, error: 'No autorizado' });
      const { rowCount } = await pool.query('DELETE FROM reportes WHERE id = $1 AND usuario_id = $2', [matchReporte[1], usuarioActual.id]);
      if (rowCount === 0) return sendJSON(res, 404, { success: false, error: 'Reporte no encontrado' });
      return sendJSON(res, 200, { success: true, message: 'Reporte eliminado' });
    }

    // ---------- ITEMS (productos dentro de un reporte) ----------

    // Agregar un producto nuevo a un reporte ya existente (esto habilita "agregar más" al editar)
    const matchItems = pathname.match(/^\/api\/reportes\/(\d+)\/items$/);
    if (matchItems && method === 'POST') {
      if (!usuarioActual) return sendJSON(res, 401, { success: false, error: 'No autorizado' });
      const reporteId = matchItems[1];

      const { rows: reporteRows } = await pool.query('SELECT id FROM reportes WHERE id = $1 AND usuario_id = $2', [reporteId, usuarioActual.id]);
      if (reporteRows.length === 0) return sendJSON(res, 404, { success: false, error: 'Reporte no encontrado' });

      const body = await readBody(req);
      const { producto, cantidad, precio } = body;
      if (!producto || cantidad === undefined || precio === undefined) {
        return sendJSON(res, 400, { success: false, error: 'Datos incompletos' });
      }
      const cant = Number(cantidad);
      const prec = Number(precio);

      await pool.query(
        `INSERT INTO reporte_items (reporte_id, producto, cantidad, precio, monto) VALUES ($1, $2, $3, $4, $5)`,
        [reporteId, producto.trim(), cant, prec, cant * prec]
      );

      const reporteCompleto = await obtenerReporteCompleto(reporteId);
      return sendJSON(res, 201, { success: true, reporte: reporteCompleto });
    }

    // Actualizar o eliminar un producto específico dentro de un reporte
    const matchItem = pathname.match(/^\/api\/reportes\/(\d+)\/items\/(\d+)$/);
    if (matchItem && method === 'PUT') {
      if (!usuarioActual) return sendJSON(res, 401, { success: false, error: 'No autorizado' });
      const [, reporteId, itemId] = matchItem;

      const { rows: reporteRows } = await pool.query('SELECT id FROM reportes WHERE id = $1 AND usuario_id = $2', [reporteId, usuarioActual.id]);
      if (reporteRows.length === 0) return sendJSON(res, 404, { success: false, error: 'Reporte no encontrado' });

      const body = await readBody(req);
      const { producto, cantidad, precio } = body;
      if (!producto || cantidad === undefined || precio === undefined) {
        return sendJSON(res, 400, { success: false, error: 'Datos incompletos' });
      }
      const cant = Number(cantidad);
      const prec = Number(precio);

      const { rowCount } = await pool.query(
        `UPDATE reporte_items SET producto = $1, cantidad = $2, precio = $3, monto = $4 WHERE id = $5 AND reporte_id = $6`,
        [producto.trim(), cant, prec, cant * prec, itemId, reporteId]
      );
      if (rowCount === 0) return sendJSON(res, 404, { success: false, error: 'Producto no encontrado' });

      const reporteCompleto = await obtenerReporteCompleto(reporteId);
      return sendJSON(res, 200, { success: true, reporte: reporteCompleto });
    }

    if (matchItem && method === 'DELETE') {
      if (!usuarioActual) return sendJSON(res, 401, { success: false, error: 'No autorizado' });
      const [, reporteId, itemId] = matchItem;

      const { rows: reporteRows } = await pool.query('SELECT id FROM reportes WHERE id = $1 AND usuario_id = $2', [reporteId, usuarioActual.id]);
      if (reporteRows.length === 0) return sendJSON(res, 404, { success: false, error: 'Reporte no encontrado' });

      const { rowCount } = await pool.query('DELETE FROM reporte_items WHERE id = $1 AND reporte_id = $2', [itemId, reporteId]);
      if (rowCount === 0) return sendJSON(res, 404, { success: false, error: 'Producto no encontrado' });

      const reporteCompleto = await obtenerReporteCompleto(reporteId);
      return sendJSON(res, 200, { success: true, reporte: reporteCompleto });
    }

    // ---------- ADMINISTRACIÓN DE USUARIOS (solo id=1) ----------

    if (pathname === '/api/usuarios' && method === 'GET') {
      if (!usuarioActual || usuarioActual.id !== 1) return sendJSON(res, 403, { success: false, error: 'No autorizado' });
      const { rows } = await pool.query('SELECT id, nombre, email, usuario, fecha_creacion FROM usuarios ORDER BY id ASC');
      return sendJSON(res, 200, { success: true, usuarios: rows });
    }

    if (pathname === '/api/usuarios' && method === 'POST') {
      if (!usuarioActual || usuarioActual.id !== 1) return sendJSON(res, 403, { success: false, error: 'No autorizado' });

      const body = await readBody(req);
      const nombre = (body.nombre || '').trim();
      const email = (body.email || '').trim();
      const usuario = (body.usuario || '').trim();
      const contrasena = body.contrasena || '';

      if (!nombre || !email || !usuario || !contrasena) {
        return sendJSON(res, 400, { success: false, error: 'Completa todos los campos' });
      }
      if (usuario.length < 3) return sendJSON(res, 400, { success: false, error: 'El usuario debe tener al menos 3 caracteres' });
      if (contrasena.length < 6) return sendJSON(res, 400, { success: false, error: 'La contraseña debe tener al menos 6 caracteres' });
      const emailValido = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      if (!emailValido) return sendJSON(res, 400, { success: false, error: 'Email no válido' });

      const existe = await pool.query('SELECT id FROM usuarios WHERE usuario = $1 OR email = $2', [usuario, email]);
      if (existe.rows.length > 0) return sendJSON(res, 400, { success: false, error: 'El usuario o email ya existe' });

      const hash = await bcrypt.hash(contrasena, 10);
      await pool.query(`INSERT INTO usuarios (nombre, email, usuario, contrasena) VALUES ($1, $2, $3, $4)`, [nombre, email, usuario, hash]);
      return sendJSON(res, 201, { success: true, message: 'Usuario creado exitosamente' });
    }

    const matchUsuario = pathname.match(/^\/api\/usuarios\/(\d+)$/);
    if (matchUsuario && method === 'DELETE') {
      if (!usuarioActual || usuarioActual.id !== 1) return sendJSON(res, 403, { success: false, error: 'No autorizado' });
      const id = Number(matchUsuario[1]);
      if (id === 1) return sendJSON(res, 400, { success: false, error: 'No puedes eliminar al admin' });
      await pool.query('DELETE FROM usuarios WHERE id = $1', [id]);
      return sendJSON(res, 200, { success: true, message: 'Usuario eliminado exitosamente' });
    }

    // ---------- ARCHIVOS ESTÁTICOS ----------

    if (method === 'GET') {
      let urlPath = pathname === '/' ? '/index.html' : pathname;
      return serveStatic(req, res, urlPath);
    }

    sendJSON(res, 404, { success: false, error: 'Ruta no encontrada' });
  } catch (e) {
    console.error(e);
    sendJSON(res, 500, { success: false, error: 'Error interno del servidor' });
  }
});

const PORT = process.env.PORT || 3000;

init()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Servidor corriendo en http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('No se pudo conectar a la base de datos:', err.message);
    process.exit(1);
  });