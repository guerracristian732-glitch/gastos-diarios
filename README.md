# Gastos Diarios

Sistema de control de gastos diarios: login con usuarios, registro de gastos (producto, cantidad, precio), agrupación por día, edición/eliminación, filtro por rango de fechas, exportación a PDF (general y por día), y panel de administración de usuarios.

## Tecnología
- Node.js (servidor HTTP nativo, sin Express)
- **PostgreSQL en Neon** (base de datos gratuita, permanente, en la nube)
- Frontend en React (cargado desde CDN, sin build) + Tailwind CSS
- PDF generado en el navegador con jsPDF
- Sesiones con cookies firmadas (HMAC), sin librerías externas de sesión

## Usuario administrador por defecto
Al iniciar el servidor por primera vez, se crea automáticamente:
- **Usuario:** `admin`
- **Contraseña:** `admin123`

**Cámbiala apenas puedas** (no hay una pantalla de "cambiar mi contraseña" todavía — si la necesitas, dime y la agregamos).

El usuario con `id = 1` (el admin creado automáticamente) es el único que puede entrar al Panel de Administración y crear/eliminar usuarios.

---

## Paso 1: Crear tu base de datos gratuita en Neon

1. Ve a **https://neon.tech**, crea una cuenta gratuita.
2. Crea un proyecto nuevo (ej. "gastos-diarios").
3. Copia el **"Connection string"** (botón "Show password" para verla completa).

---

## Paso 2: Correrlo en localhost

1. Descomprime el proyecto y abre una terminal dentro de la carpeta `gastos-diarios`.
2. Instala dependencias:
   ```bash
   npm install
   ```
3. Copia el archivo de ejemplo:
   ```bash
   cp .env.example .env
   ```
4. Abre `.env` y pega tu cadena de conexión de Neon en `DATABASE_URL`. También puedes cambiar `COOKIE_SECRET` por cualquier texto largo y aleatorio (no es obligatorio, pero es más seguro).
5. Ejecuta:
   ```bash
   node server.js
   ```
6. Abre `http://localhost:3000` — te redirigirá al login automáticamente.

---

## Paso 3: Desplegar en Render (hosting gratuito)

1. Sube el proyecto a un repositorio de GitHub (el `.env` no se sube, está protegido en `.gitignore`).
2. Ve a **https://render.com**, crea cuenta gratis.
3. **New +** → **Web Service** → conecta tu repositorio.
4. Configura:
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: Free
5. En **Environment Variables**, agrega dos:
   - `DATABASE_URL` → tu cadena de conexión de Neon
   - `COOKIE_SECRET` → cualquier texto largo y aleatorio
6. **Deploy Web Service**.

Como los datos viven en Neon (no en Render), nunca se pierden aunque el servicio gratuito "duerma" por inactividad.

---

## Estructura del proyecto

```
gastos-diarios/
├── server.js       # Servidor HTTP + todas las rutas de la API
├── db.js           # Conexión a PostgreSQL (Neon) + creación de tablas
├── auth.js         # Manejo de sesiones con cookies firmadas
├── package.json
├── .env.example
├── .gitignore
└── public/
    ├── login.html   # Pantalla de inicio de sesión
    ├── index.html   # Dashboard principal (React)
    ├── admin.html   # Panel de administración de usuarios (solo admin)
    └── img/         # Logos
```

## Endpoints de la API

| Método | Ruta                  | Descripción                         | Acceso        |
|--------|-----------------------|---------------------------------------|---------------|
| POST   | /api/login            | Iniciar sesión                        | Público       |
| POST   | /api/logout           | Cerrar sesión                         | Autenticado   |
| GET    | /api/me               | Datos de la sesión actual             | Autenticado   |
| GET    | /api/reportes         | Listar reportes (filtros opcionales)  | Autenticado   |
| POST   | /api/reportes         | Crear reporte                         | Autenticado   |
| PUT    | /api/reportes/:id     | Actualizar reporte                    | Autenticado   |
| DELETE | /api/reportes/:id     | Eliminar reporte                      | Autenticado   |
| GET    | /api/usuarios         | Listar usuarios                       | Solo admin    |
| POST   | /api/usuarios         | Crear usuario                         | Solo admin    |
| DELETE | /api/usuarios/:id     | Eliminar usuario                      | Solo admin    |

## Notas
- El monto se calcula automáticamente: `cantidad * precio`.
- Los reportes se agrupan por fecha en el dashboard, con total por día.
- El botón "Descargar PDF" genera el reporte directamente en el navegador (general o de un solo día).
- Las contraseñas se guardan con hash `bcrypt`, nunca en texto plano.
