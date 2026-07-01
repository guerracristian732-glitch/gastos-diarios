const http = require('http');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { pool, init } = require('./db');
const { setSessionCookie, clearSessionCookie, getSession } = require('./auth');

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

      const { rows } = await pool.query(
        'SELECT * FROM usuarios WHERE usuario = $1 OR email = $1',
        [usuarioInput]
      );
      const encontrado = rows[0];

      if (!encontrado) {
        return sendJSON(res, 401, { success: false, error: 'Usuario no encontrado' });
      }

      const valido = await bcrypt.compare(contrasenaInput, encontrado.contrasena);
      if (!valido) {
        return sendJSON(res, 401, { success: false, error: 'Contraseña incorrecta' });
      }

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
        success: true,
        id: usuario.id,
        nombre: usuario.nombre,
        usuario: usuario.usuario,
        isAdmin: usuario.id === 1
      });
    }

    // A partir de aquí, todas las rutas requieren sesión activa
    const usuarioActual = await usuarioDesdeSesion(req);

    // ---------- REPORTES ----------

    if (pathname === '/api/reportes' && method === 'GET') {
      if (!usuarioActual) return sendJSON(res, 401, { success: false, error: 'No autorizado' });

      const usuarioIdFiltro = url.searchParams.get('usuario_id');
      const fechaInicio = url.searchParams.get('fecha_inicio');
      const fechaFin = url.searchParams.get('fecha_fin');

      let query = 'SELECT * FROM reportes WHERE 1=1';
      const params = [];

      if (usuarioIdFiltro) {
        params.push(Number(usuarioIdFiltro));
        query += ` AND usuario_id = $${params.length}`;
      }
      if (fechaInicio && fechaFin) {
        params.push(`${fechaInicio} 00:00:00`);
        query += ` AND fecha_creacion >= $${params.length}`;
        params.push(`${fechaFin} 23:59:59`);
        query += ` AND fecha_creacion <= $${params.length}`;
      }
      query += ' ORDER BY fecha_creacion DESC';

      const { rows } = await pool.query(query, params);
      return sendJSON(res, 200, { success: true, reportes: rows });
    }

    if (pathname === '/api/reportes' && method === 'POST') {
      if (!usuarioActual) return sendJSON(res, 401, { success: false, error: 'No autorizado' });

      const body = await readBody(req);
      const { nombre_reporte, producto, cantidad, precio, fecha } = body;

      if (!producto || cantidad === undefined || precio === undefined) {
        return sendJSON(res, 400, { success: false, error: 'Datos incompletos' });
      }

      const cant = Number(cantidad);
      const prec = Number(precio);
      const monto = cant * prec;
      const fechaCreacion = fecha ? `${fecha} 00:00:00` : new Date();

      const { rows } = await pool.query(
        `INSERT INTO reportes (usuario_id, nombre_reporte, producto, cantidad, precio, monto, fecha_creacion)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [usuarioActual.id, (nombre_reporte || '').trim(), producto.trim(), cant, prec, monto, fechaCreacion]
      );

      return sendJSON(res, 201, { success: true, message: 'Reporte creado', id: rows[0].id, monto });
    }

    const matchReporte = pathname.match(/^\/api\/reportes\/(\d+)$/);

    if (matchReporte && method === 'PUT') {
      if (!usuarioActual) return sendJSON(res, 401, { success: false, error: 'No autorizado' });

      const id = matchReporte[1];
      const body = await readBody(req);
      const { nombre_reporte, producto, cantidad, precio, fecha } = body;

      if (!producto || cantidad === undefined || precio === undefined) {
        return sendJSON(res, 400, { success: false, error: 'Datos incompletos' });
      }

      const cant = Number(cantidad);
      const prec = Number(precio);
      const monto = cant * prec;

      let query = `UPDATE reportes SET nombre_reporte = $1, producto = $2, cantidad = $3, precio = $4, monto = $5`;
      const params = [(nombre_reporte || '').trim(), producto.trim(), cant, prec, monto];

      if (fecha) {
        params.push(`${fecha} 00:00:00`);
        query += `, fecha_creacion = $${params.length}`;
      }

      params.push(id);
      query += ` WHERE id = $${params.length} RETURNING *`;

      const { rows } = await pool.query(query, params);
      if (rows.length === 0) return sendJSON(res, 404, { success: false, error: 'Reporte no encontrado' });
      return sendJSON(res, 200, { success: true, message: 'Reporte actualizado' });
    }

    if (matchReporte && method === 'DELETE') {
      if (!usuarioActual) return sendJSON(res, 401, { success: false, error: 'No autorizado' });

      const id = matchReporte[1];
      const { rowCount } = await pool.query('DELETE FROM reportes WHERE id = $1', [id]);
      if (rowCount === 0) return sendJSON(res, 404, { success: false, error: 'Reporte no encontrado' });
      return sendJSON(res, 200, { success: true, message: 'Reporte eliminado' });
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
      if (usuario.length < 3) {
        return sendJSON(res, 400, { success: false, error: 'El usuario debe tener al menos 3 caracteres' });
      }
      if (contrasena.length < 6) {
        return sendJSON(res, 400, { success: false, error: 'La contraseña debe tener al menos 6 caracteres' });
      }
      const emailValido = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      if (!emailValido) {
        return sendJSON(res, 400, { success: false, error: 'Email no válido' });
      }

      const existe = await pool.query('SELECT id FROM usuarios WHERE usuario = $1 OR email = $2', [usuario, email]);
      if (existe.rows.length > 0) {
        return sendJSON(res, 400, { success: false, error: 'El usuario o email ya existe' });
      }

      const hash = await bcrypt.hash(contrasena, 10);
      await pool.query(
        `INSERT INTO usuarios (nombre, email, usuario, contrasena) VALUES ($1, $2, $3, $4)`,
        [nombre, email, usuario, hash]
      );

      return sendJSON(res, 201, { success: true, message: 'Usuario creado exitosamente' });
    }

    const matchUsuario = pathname.match(/^\/api\/usuarios\/(\d+)$/);
    if (matchUsuario && method === 'DELETE') {
      if (!usuarioActual || usuarioActual.id !== 1) return sendJSON(res, 403, { success: false, error: 'No autorizado' });

      const id = Number(matchUsuario[1]);
      if (id === 1) {
        return sendJSON(res, 400, { success: false, error: 'No puedes eliminar al admin' });
      }
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
