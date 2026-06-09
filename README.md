# vps-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-stdio-blue.svg)](https://modelcontextprotocol.io)
[![Node](https://img.shields.io/badge/Node-%E2%89%A518-green.svg)](https://nodejs.org)

Servidor **MCP stateless** para conectarte a **cualquier VPS** por SSH usando
**tus propias credenciales** y operar sobre él: ejecutar comandos, subir/bajar
archivos y leer/escribir ficheros remotos.

Corre en local por **stdio**. No mantiene sesión ni guarda credenciales: cada
llamada abre la conexión SSH, hace el trabajo y la cierra. El servidor no
contiene datos de ningún VPS — las credenciales las pone cada usuario en la
config de su propio cliente MCP.

## Tools expuestas

| Tool | Qué hace |
|------|----------|
| `ssh_test_connection` | Verifica conectividad y autenticación (devuelve user + hostname). |
| `ssh_exec` | Ejecuta un comando shell y devuelve `stdout`, `stderr` y `code`. |
| `ssh_read_file` | Lee un archivo remoto (con límite de tamaño, por defecto 1 MiB). |
| `ssh_upload_file` | Sube un archivo local al VPS por SFTP (deploy de artefactos). |
| `ssh_download_file` | Descarga un archivo remoto a tu disco local (backups, binarios, sin límite). |
| `ssh_write_file` | Escribe texto directo a un archivo remoto (configs, `.env`, scripts). |

Las credenciales se definen **una vez** por variables de entorno en la config del
cliente MCP. Cualquier campo se puede sobreescribir por llamada (`host`, `port`,
`username`, `password`, `privateKeyPath`, `passphrase`, `timeoutMs`).

## Requisitos

- Node.js ≥ 18
- Un cliente MCP (Claude Code, Claude Desktop, etc.)
- Acceso SSH a un VPS (password o clave privada)

## Instalación

```bash
git clone https://github.com/MauricioPerera/vps-mcp.git
cd vps-mcp
npm install
```

Anotá la ruta absoluta a `index.js` (la necesitás para la config). En estos
ejemplos se usa `/ruta/a/vps-mcp/index.js`.

## Configuración en Claude Code

Añadir el servidor con las credenciales como env vars:

```bash
claude mcp add vps --scope user \
  --env VPS_HOST=<TU_IP> --env VPS_USER=root --env VPS_PASSWORD="<TU_PASSWORD>" \
  -- node /ruta/a/vps-mcp/index.js
```

> **Windows:** usá barras normales en la ruta (`C:/ruta/a/vps-mcp/index.js`); el
> shell de PowerShell se come los `\` al pasarlos como argumento.

O manualmente en el JSON de config MCP:

```json
{
  "mcpServers": {
    "vps": {
      "command": "node",
      "args": ["/ruta/a/vps-mcp/index.js"],
      "env": {
        "VPS_HOST": "<TU_IP>",
        "VPS_PORT": "22",
        "VPS_USER": "root",
        "VPS_PASSWORD": "<TU_PASSWORD>"
      }
    }
  }
}
```

### Autenticación por clave (recomendado sobre password)

```json
"env": {
  "VPS_HOST": "<TU_IP>",
  "VPS_USER": "root",
  "VPS_KEY_PATH": "C:\\Users\\<usuario>\\.ssh\\id_ed25519",
  "VPS_KEY_PASSPHRASE": "opcional"
}
```

## Variables de entorno

| Variable | Default | Descripción |
|----------|---------|-------------|
| `VPS_HOST` | — | IP o host del VPS (obligatorio). |
| `VPS_PORT` | `22` | Puerto SSH. |
| `VPS_USER` | `root` | Usuario SSH. |
| `VPS_PASSWORD` | — | Password (si no usás clave). |
| `VPS_KEY_PATH` | — | Ruta a la clave privada (tiene prioridad sobre password). |
| `VPS_KEY_PASSPHRASE` | — | Passphrase de la clave, si tiene. |
| `VPS_TIMEOUT_MS` | `60000` | Timeout por comando. |

## Prueba rápida (sin cliente MCP)

El script `test-client.js` levanta el server por stdio y llama a
`ssh_test_connection` + `ssh_exec`. Con `--write` prueba además la escritura y
ejecución de un script remoto (y limpia al terminar).

PowerShell (Windows):

```powershell
$env:VPS_HOST="<TU_IP>"; $env:VPS_USER="root"; $env:VPS_PASSWORD="<TU_PASSWORD>"
node test-client.js          # solo lectura
node test-client.js --write  # incluye write + exec en /tmp
```

Bash (Linux/macOS):

```bash
VPS_HOST=<TU_IP> VPS_USER=root VPS_PASSWORD="<TU_PASSWORD>" node test-client.js
```

## Arquitectura

```
MCP client (Claude Code/Desktop)
        │  stdio (JSON-RPC)
        ▼
   index.js  ── por cada tool call ──►  ssh2.Client.connect()
   (stateless)                          exec  /  SFTP (get·put·read·write)
        ▲                               conn.end()   ◄── se cierra siempre
        │
   credenciales: env VPS_* (override por llamada)
```

- **Sin estado entre llamadas**: no hay pool ni sesión persistente; cada tool
  abre y cierra su propia conexión. Robusto frente a sesiones colgadas.
- **stdout reservado** para el canal MCP; los logs van a stderr.
- Auth: si `VPS_KEY_PATH` está presente tiene prioridad sobre `VPS_PASSWORD`.

## Detalle de cada tool

### `ssh_test_connection`
Sin argumentos obligatorios. Ejecuta `echo OK; id -un; hostname` y devuelve
`{ connected, code, stdout, stderr, host }`.

### `ssh_exec`
- `command` (string, obligatorio): comando shell a ejecutar.
- Devuelve `{ code, signal, stdout, stderr, host }`.

### `ssh_read_file`
- `path` (string, obligatorio): ruta absoluta remota.
- `maxBytes` (int, opcional, default `1048576`): corta la lectura para no
  inundar el contexto; marca `truncated: true` si el archivo es mayor.

### `ssh_upload_file`
- `localPath` (string, obligatorio): ruta local del archivo a subir.
- `remotePath` (string, obligatorio): destino remoto. Si termina en `/`, se
  añade el nombre del archivo local.
- `mode` (string, opcional): permisos octales, ej. `'0755'` para un ejecutable.
- `mkdirp` (bool, opcional, default `true`): crea el directorio remoto si falta.

### `ssh_download_file`
- `remotePath` (string, obligatorio): ruta remota del archivo a descargar.
- `localPath` (string, obligatorio): destino local. Si termina en `/` o `\`, se
  añade el nombre del archivo remoto.
- `mkdirp` (bool, opcional, default `true`): crea el directorio local si falta.
- Maneja binarios y archivos grandes (sin límite de tamaño), a diferencia de
  `ssh_read_file`.

### `ssh_write_file`
- `remotePath` (string, obligatorio): ruta remota del archivo.
- `content` (string, obligatorio): contenido de texto a escribir.
- `mode` (string, opcional): permisos octales, ej. `'0644'`.
- `append` (bool, opcional, default `false`): añade en vez de sobrescribir.
- `mkdirp` (bool, opcional, default `true`): crea el directorio remoto si falta.

Todas aceptan además los overrides opcionales: `host`, `port`, `username`,
`password`, `privateKeyPath`, `passphrase`, `timeoutMs`.

## Ejemplo: deploy en 2 pasos

```text
1) ssh_upload_file  localPath=./dist/app.tar.gz  remotePath=/opt/app/  mode=0644
2) ssh_exec         command="cd /opt/app && tar xzf app.tar.gz && systemctl restart app"
```

Backup remoto → disco local:

```text
1) ssh_exec          command="pg_dump mydb | gzip > /tmp/db.sql.gz"
2) ssh_download_file  remotePath=/tmp/db.sql.gz  localPath=D:/backups/
```

O config + script sin archivo local:

```text
1) ssh_write_file  remotePath=/opt/app/.env  content="NODE_ENV=production\nPORT=3000"
2) ssh_write_file  remotePath=/opt/app/deploy.sh  content="#!/bin/sh\n..."  mode=0755
3) ssh_exec        command=/opt/app/deploy.sh
```

## Nota de seguridad

El password queda en texto plano en la config del MCP. Para uso real conviene
clave SSH y/o restringir permisos del archivo de config.
