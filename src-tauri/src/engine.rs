//! Ciclo de vida del sidecar Python y cliente HTTP hacia él.
//!
//! El sidecar escucha sólo en 127.0.0.1, en un puerto libre elegido aquí, y
//! exige un token aleatorio por sesión. La UI nunca habla con él directamente:
//! todo pasa por comandos de Rust.
//!
//! Para no dejar procesos pesados corriendo, el motor se apaga tras `idle_after()` sin uso
//! (estado `idle`) y vuelve a arrancar solo con la siguiente petición.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::error::{AppError, AppResult};
use crate::paths::Paths;
use crate::setup::{self, Layout, Manifest};

/// Tiempo sin usar el motor tras el cual se apaga su proceso (5 minutos; AICS_ENGINE_IDLE_SECS lo cambia para pruebas).
pub fn idle_after() -> Duration {
    static IDLE: OnceLock<Duration> = OnceLock::new();
    *IDLE.get_or_init(|| {
        let secs = std::env::var("AICS_ENGINE_IDLE_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(5 * 60);
        Duration::from_secs(secs)
    })
}

#[derive(Serialize, Clone, Debug)]
pub struct EngineStatus {
    pub state: String, // preparing | starting | ready | idle | error | stopped
    pub message: String,
    pub python: Option<String>,
    pub port: Option<u16>,
    /// Progreso de la preparación del primer arranque.
    pub setup: Option<setup::Progress>,
    /// Qué se instaló (variante de PyTorch, GPU) en instalaciones empaquetadas.
    pub runtime: Option<Manifest>,
    /// `true` si el error ocurrió preparando el motor (la UI ofrece reintentar).
    pub setup_failed: bool,
}

struct Inner {
    child: Option<Child>,
    port: u16,
    token: String,
    status: EngineStatus,
}

pub struct Engine {
    inner: Mutex<Inner>,
    http: reqwest::Client,
    last_used: Mutex<Instant>,
    /// Serializa despertar y dormir para que no se crucen.
    lifecycle: tokio::sync::Mutex<()>,
    app: OnceLock<AppHandle>,
}

fn engine_dir() -> PathBuf {
    std::env::var_os("AICS_ENGINE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../engine")))
}

/// Motor empaquetado como recurso de la app (instalaciones): engine/{src,bundle}.
fn bundled_engine(app: &AppHandle) -> Option<PathBuf> {
    app.path().resource_dir().ok().map(|r| r.join("engine")).filter(|p| p.join("bundle").join("core.txt").exists())
}

/// `uv` viaja junto al ejecutable (externalBin de Tauri).
fn bundled_uv() -> PathBuf {
    let dir = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf())).unwrap_or_default();
    dir.join(if cfg!(windows) { "uv.exe" } else { "uv" })
}

enum Interpreter {
    /// Python listo; `pythonpath` apunta al código del motor si no está instalado como paquete.
    Ready { python: PathBuf, pythonpath: Option<PathBuf>, runtime: Option<Manifest> },
    NeedsSetup(Layout),
    Missing(String),
}

/// Orden: AICS_PYTHON → venv de desarrollo (engine/.venv) → entorno preparado en <datos>/runtime.
fn locate(app: &AppHandle, paths: &Paths) -> Interpreter {
    if let Some(p) = std::env::var_os("AICS_PYTHON") {
        return Interpreter::Ready { python: PathBuf::from(p), pythonpath: None, runtime: None };
    }
    let bundled = bundled_engine(app);
    if cfg!(debug_assertions) || bundled.is_none() {
        if let Some(python) = setup::dev_python(&engine_dir()) {
            return Interpreter::Ready { python, pythonpath: None, runtime: None };
        }
    }
    let Some(engine) = bundled else {
        return Interpreter::Missing(format!("No se encontró el entorno Python del motor. Ejecuta `uv sync --extra diffusion` en {}", engine_dir().display()));
    };
    let layout = Layout { root: paths.root.join("runtime"), engine: engine.clone(), uv: bundled_uv() };
    if layout.is_ready() {
        Interpreter::Ready { python: layout.python(), pythonpath: Some(engine.join("src")), runtime: layout.manifest() }
    } else {
        Interpreter::NeedsSetup(layout)
    }
}

fn free_port() -> std::io::Result<u16> {
    Ok(std::net::TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

impl Engine {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                child: None,
                port: 0,
                token: String::new(),
                status: EngineStatus { state: "stopped".into(), message: "Motor detenido".into(), python: None, port: None, setup: None, runtime: None, setup_failed: false },
            }),
            http: reqwest::Client::builder().timeout(Duration::from_secs(30)).build().expect("cliente http"),
            last_used: Mutex::new(Instant::now()),
            lifecycle: tokio::sync::Mutex::new(()),
            app: OnceLock::new(),
        }
    }

    pub fn status(&self) -> EngineStatus {
        self.inner.lock().unwrap().status.clone()
    }

    fn set_status(&self, app: &AppHandle, state: &str, message: impl Into<String>) {
        let status = {
            let mut inner = self.inner.lock().unwrap();
            inner.status.state = state.into();
            inner.status.message = message.into();
            if state != "preparing" {
                inner.status.setup = None;
            }
            inner.status.clone()
        };
        let _ = app.emit("engine-status", status);
    }

    /// Lanza el sidecar y espera a que responda /health.
    fn set_setup(&self, app: &AppHandle, progress: setup::Progress) {
        let status = {
            let mut inner = self.inner.lock().unwrap();
            inner.status.state = "preparing".into();
            inner.status.message = progress.title.clone();
            inner.status.setup = Some(progress);
            inner.status.setup_failed = false;
            inner.status.clone()
        };
        let _ = app.emit("engine-status", status);
    }

    pub async fn start(&self, app: &AppHandle, paths: &Paths) {
        let _ = self.app.set(app.clone());
        *self.last_used.lock().unwrap() = Instant::now();
        self.stop();
        let (python, pythonpath, runtime) = match locate(app, paths) {
            Interpreter::Ready { python, pythonpath, runtime } => (python, pythonpath, runtime),
            Interpreter::Missing(msg) => return self.set_status(app, "error", msg),
            Interpreter::NeedsSetup(layout) => {
                self.set_setup(app, setup::Progress { step: 0, total: 4, title: "Preparando el motor de IA".into(), detail: String::new(), variant: None });
                let handle = app.clone();
                let result = tauri::async_runtime::spawn_blocking(move || {
                    let state = handle.state::<crate::AppState>();
                    let mut last = Instant::now() - Duration::from_secs(1);
                    let manifest = setup::prepare(&layout, &mut |p| {
                        // Limita los eventos a ~8 por segundo: uv imprime muchas líneas.
                        if last.elapsed() >= Duration::from_millis(120) || p.detail.is_empty() {
                            last = Instant::now();
                            state.engine.set_setup(&handle, p);
                        }
                    })?;
                    Ok::<_, AppError>((layout.python(), layout.engine.join("src"), manifest))
                })
                .await;
                match result {
                    Ok(Ok((python, src, manifest))) => (python, Some(src), Some(manifest)),
                    Ok(Err(e)) => {
                        let status = {
                            let mut inner = self.inner.lock().unwrap();
                            inner.status.state = "error".into();
                            inner.status.message = format!("No se pudo preparar el motor: {e}");
                            inner.status.setup_failed = true;
                            inner.status.clone()
                        };
                        let _ = app.emit("engine-status", status);
                        return;
                    }
                    Err(e) => return self.set_status(app, "error", format!("No se pudo preparar el motor: {e}")),
                }
            }
        };
        let spawned = (|| -> std::io::Result<(Child, u16, String)> {
            let port = free_port()?;
            let token = uuid::Uuid::new_v4().simple().to_string();
            let log = std::fs::File::create(paths.logs().join("engine.log"))?;
            let mut cmd = Command::new(&python);
            cmd.args(["-m", "aics_engine", "--port", &port.to_string(), "--token", &token])
                .arg("--data-dir").arg(&paths.root)
                .args(["--parent-pid", &std::process::id().to_string()])
                .env("PYTHONUNBUFFERED", "1")
                .stdin(Stdio::null())
                .stdout(log.try_clone()?)
                .stderr(log);
            if let Some(src) = &pythonpath {
                cmd.env("PYTHONPATH", src);
            }
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x0800_0000); // sin ventana de consola
            }
            let child = cmd.spawn()?;
            Ok((child, port, token))
        })();

        let (child, port, token) = match spawned {
            Ok(v) => v,
            Err(e) => return self.set_status(app, "error", format!("No se pudo iniciar el motor: {e}")),
        };
        {
            let mut inner = self.inner.lock().unwrap();
            inner.child = Some(child);
            inner.port = port;
            inner.token = token;
            inner.status.python = Some(python.display().to_string());
            inner.status.port = Some(port);
            inner.status.runtime = runtime.clone();
            inner.status.setup_failed = false;
        }
        self.set_status(app, "starting", "Iniciando motor de IA…");

        let deadline = Instant::now() + Duration::from_secs(90);
        while Instant::now() < deadline {
            if self.exited() {
                return self.set_status(app, "error", format!(
                    "El motor terminó al iniciar. Revisa {}", paths.logs().join("engine.log").display()
                ));
            }
            if self.http.get(self.url("/health")).send().await.is_ok_and(|r| r.status().is_success()) {
                return self.set_status(app, "ready", "Motor listo");
            }
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
        self.set_status(app, "error", "El motor no respondió a tiempo");
    }

    fn exited(&self) -> bool {
        let mut inner = self.inner.lock().unwrap();
        match inner.child.as_mut().map(|c| c.try_wait()) {
            Some(Ok(Some(_))) | Some(Err(_)) => true,
            _ => false,
        }
    }

    pub fn stop(&self) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(mut child) = inner.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        inner.status.state = "stopped".into();
        inner.status.port = None;
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{}", self.inner.lock().unwrap().port, path)
    }

    /// Apaga el proceso si lleva `idle_after()` sin uso y no hay trabajos ni descargas en curso.
    /// `jobs_active` se consulta en la base de datos (los trabajos siempre pasan por ella).
    pub async fn sleep_if_idle(&self, app: &AppHandle, jobs_active: impl Fn() -> bool) {
        let idle = || self.status().state == "ready" && self.last_used.lock().unwrap().elapsed() >= idle_after();
        if !idle() {
            return;
        }
        let _guard = self.lifecycle.lock().await;
        if !idle() || jobs_active() {
            return;
        }
        let token = self.inner.lock().unwrap().token.clone();
        let downloading = match self.send(self.http.get(self.url("/models")), token).await {
            Ok(models) => models.as_array().is_some_and(|list| list.iter().any(|m| matches!(m["status"].as_str(), Some("downloading" | "queued")))),
            Err(_) => true, // ante la duda, no se apaga
        };
        if downloading || !idle() {
            return;
        }
        self.stop();
        self.set_status(app, "idle", "En reposo · se activa solo al usarlo");
    }

    /// Vuelve a lanzar el motor si estaba en reposo (o espera a que termine de despertar).
    async fn wake(&self) {
        let _guard = self.lifecycle.lock().await;
        if self.status().state != "idle" {
            return;
        }
        let Some(app) = self.app.get().cloned() else { return };
        let state = app.state::<crate::AppState>();
        self.start(&app, &state.paths).await;
    }

    async fn ensure_ready(&self) -> AppResult<String> {
        *self.last_used.lock().unwrap() = Instant::now();
        if self.status().state == "idle" {
            self.wake().await;
        }
        let inner = self.inner.lock().unwrap();
        if inner.status.state != "ready" {
            return Err(AppError::Engine(inner.status.message.clone()));
        }
        Ok(inner.token.clone())
    }

    async fn send(&self, req: reqwest::RequestBuilder, token: String) -> AppResult<Value> {
        let resp = req.header("X-AICS-Token", token).send().await?;
        let status = resp.status();
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            let detail = body["detail"].as_str().map(str::to_owned).unwrap_or_else(|| status.to_string());
            return Err(AppError::Engine(detail));
        }
        Ok(body)
    }

    pub async fn get(&self, path: &str) -> AppResult<Value> {
        let token = self.ensure_ready().await?;
        self.send(self.http.get(self.url(path)), token).await
    }

    pub async fn delete(&self, path: &str) -> AppResult<Value> {
        let token = self.ensure_ready().await?;
        self.send(self.http.delete(self.url(path)), token).await
    }

    pub async fn post(&self, path: &str, body: &Value) -> AppResult<Value> {
        let token = self.ensure_ready().await?;
        self.send(self.http.post(self.url(path)).json(body), token).await
    }
}
