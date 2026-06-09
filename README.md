# vps-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-stdio-blue.svg)](https://modelcontextprotocol.io)
[![Node](https://img.shields.io/badge/Node-%E2%89%A518-green.svg)](https://nodejs.org)

Servidor **MCP stateless** para conectarte a tu VPS por SSH y ejecutar comandos.
Corre en local por **stdio**. No mantiene sesión: cada llamada abre la conexión
SSH, ejecuta y la cierra.

## Tools expuestas

| Tool | Qué hace |
|------|----------|
| `ssh_test_connection` | Verifica conectividad y autenticación (devuelve user + hostname). |
| `ssh_exec` | Ejecuta un comando shell y devuelve `stdout`, `stderr` y `code`. |
| `ssh_read_file` | Lee un archivo remoto (con límite de tamaño, por defecto 1 MiB). |

Las credenciales se definen **una vez** por variables de entorno en la config del
cliente MCP. Cualquier campo se puede sobreescribir por llamada (`host`, `port`,
`username`, `password`, `privateKeyPath`, `passphrase`, `timeoutMs`).

## Instalación

```powershell
cd D:\repos\vps\vps-mcp
npm install
```

## Configuración en Claude Code

Añadir el servidor con las credenciales como env vars:

```powershell
claude mcp add vps --scope user `
  --env VPS_HOST=<TU_IP> --env VPS_USER=root --env VPS_PASSWORD="<TU_PASSWORD>" `
  -- node D:/repos/vps/vps-mcp/index.js
```

> En Windows usá barras normales (`D:/...`) en la ruta: el shell se come los `\`.

O manualmente en el JSON de config MCP:

```json
{
  "mcpServers": {
    "vps": {
      "command": "node",
      "args": ["D:\\repos\\vps\\vps-mcp\\index.js"],
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

```powershell
$env:VPS_HOST="<TU_IP>"; $env:VPS_USER="root"; $env:VPS_PASSWORD="<TU_PASSWORD>"
node test-client.js
```

## Arquitectura

```
MCP client (Claude Code/Desktop)
        │  stdio (JSON-RPC)
        ▼
   index.js  ── por cada tool call ──►  ssh2.Client.connect()
   (stateless)                          exec / read
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

Todas aceptan además los overrides opcionales: `host`, `port`, `username`,
`password`, `privateKeyPath`, `passphrase`, `timeoutMs`.

## Nota de seguridad

El password queda en texto plano en la config del MCP. Para uso real conviene
clave SSH y/o restringir permisos del archivo de config.
