# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/) y
[SemVer](https://semver.org/lang/es/).

## [1.4.0]

### Added
- `engines.node >= 18`, `keywords`, `homepage`, `bugs` y scripts `test`
  (chequeo offline) y `smoke` (cliente contra un VPS real) en `package.json`.
- Este `CHANGELOG.md`.
- Notas en el README sobre la superficie de **shell root** y la
  **compatibilidad del remoto** (asume GNU/Linux).

### Changed
- `ssh_task_status` ahora distingue **`stopped`** (matado con `ssh_task_stop`)
  de **`crashed`** (murió solo: kill externo, OOM, reboot). Antes ambos se
  reportaban como `stopped`.
- El parseo del bloque de metadatos de los tasks es **por campo** (key=value por
  línea); un campo malformado ya no anula el estado completo.

### Fixed
- `ssh_read_file` reutiliza `shQuote` en vez de un quoting inline duplicado;
  `maxBytes` se castea a número antes de interpolar.

## [1.3.0]

### Added
- Tasks en background para comandos largos: `ssh_task_start`, `ssh_task_status`,
  `ssh_task_logs`, `ssh_task_stop`, `ssh_task_list`. El comando corre detached en
  el VPS (`setsid`/`nohup`) con salida y exit code persistidos en `VPS_TASK_DIR`,
  sobreviviendo al cierre de la conexión y al timeout por llamada.
- Variable de entorno `VPS_TASK_DIR` (default `/tmp/vps-mcp-tasks`).

## [1.2.0]

### Added
- `ssh_download_file`: descarga remoto → local por SFTP (binarios y archivos
  grandes, sin límite de tamaño).

## [1.1.0]

### Added
- `ssh_upload_file`: subida local → VPS por SFTP, con `mode` y `mkdirp`.
- `ssh_write_file`: escritura de texto directa a un archivo remoto.

## [1.0.0]

### Added
- Servidor MCP stateless inicial por stdio con `ssh_exec`,
  `ssh_test_connection` y `ssh_read_file`. Auth por password o clave SSH,
  credenciales por variables de entorno con override por llamada.
