//! Preparación del motor en el primer arranque (instalaciones empaquetadas).
//!
//! El instalador trae `uv` y el código del motor con versiones exactas (engine/bundle/*.txt).
//! Aquí se crea un entorno Python propio en <datos>/runtime eligiendo la variante de PyTorch
//! adecuada al equipo:
//!   - macOS Apple Silicon → PyTorch de PyPI (Metal)
//!   - Windows/Linux con NVIDIA → la variante CUDA más nueva que soporte el driver, si falla la siguiente
//!   - resto (o si todo lo anterior falla) → CPU
//! Si PyTorch no se puede instalar, el motor arranca igual en modo compatible (sólo modelos ONNX).

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::error::{AppError, AppResult};

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct Manifest {
    pub fingerprint: String,
    pub variant: String,
    pub torch: bool,
    pub gpu: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
pub struct Progress {
    pub step: u32,
    pub total: u32,
    pub title: String,
    pub detail: String,
    pub variant: Option<String>,
}

pub struct Layout {
    pub root: PathBuf,
    pub engine: PathBuf, // recursos: engine/{src,bundle}
    pub uv: PathBuf,
}

impl Layout {
    pub fn venv(&self) -> PathBuf {
        self.root.join("venv")
    }

    pub fn python(&self) -> PathBuf {
        let venv = self.venv();
        if cfg!(windows) { venv.join("Scripts").join("python.exe") } else { venv.join("bin").join("python") }
    }

    fn manifest_path(&self) -> PathBuf {
        self.root.join("manifest.json")
    }

    fn bundle(&self, name: &str) -> PathBuf {
        self.engine.join("bundle").join(name)
    }

    pub fn manifest(&self) -> Option<Manifest> {
        std::fs::read_to_string(self.manifest_path()).ok().and_then(|s| serde_json::from_str(&s).ok())
    }

    /// Huella de las versiones empaquetadas: si cambia (actualización de la app), se reinstala.
    pub fn fingerprint(&self) -> String {
        let mut text = String::new();
        for f in ["core.txt", "torch.txt", "diffusion.txt"] {
            text += &std::fs::read_to_string(self.bundle(f)).unwrap_or_default();
        }
        format!("{:016x}", fnv1a(text.as_bytes()))
    }

    pub fn is_ready(&self) -> bool {
        self.python().exists() && self.manifest().is_some_and(|m| m.fingerprint == self.fingerprint())
    }
}

fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325u64, |h, b| (h ^ *b as u64).wrapping_mul(0x100000001b3))
}

/// GPU NVIDIA y versión mayor del driver (vía nvidia-smi, que instala el propio driver).
pub fn nvidia() -> Option<(String, u32)> {
    let mut cmd = Command::new("nvidia-smi");
    cmd.args(["--query-gpu=name,driver_version", "--format=csv,noheader"]).stdout(Stdio::piped()).stderr(Stdio::null());
    hide_window(&mut cmd);
    let out = cmd.output().ok()?;
    let line = String::from_utf8_lossy(&out.stdout).lines().next()?.to_string();
    let (name, driver) = line.split_once(',')?;
    let major = driver.trim().split('.').next()?.parse().ok()?;
    Some((name.trim().to_string(), major))
}

#[derive(Deserialize)]
struct Variants {
    cuda: Vec<CudaVariant>,
}

#[derive(Deserialize)]
struct CudaVariant {
    name: String,
    min_driver: u32,
}

/// Orden de intento de variantes de PyTorch para este equipo.
pub fn torch_plan(layout: &Layout, gpu: Option<&(String, u32)>) -> Vec<String> {
    if cfg!(target_os = "macos") {
        return vec!["pypi".into()];
    }
    let mut plan = vec![];
    if let Some((_, driver)) = gpu {
        let variants: Option<Variants> = std::fs::read_to_string(layout.bundle("torch-variants.json")).ok().and_then(|s| serde_json::from_str(&s).ok());
        for v in variants.map(|v| v.cuda).unwrap_or_default() {
            if *driver >= v.min_driver {
                plan.push(v.name);
            }
        }
    }
    plan.push("cpu".into());
    plan
}

fn hide_window(_cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        _cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
}

/// Ejecuta uv mostrando su progreso (stderr) línea a línea.
fn uv(layout: &Layout, args: &[&str], on_line: &mut dyn FnMut(&str)) -> AppResult<()> {
    let mut cmd = Command::new(&layout.uv);
    cmd.args(args)
        .env("UV_PYTHON_INSTALL_DIR", layout.root.join("python"))
        .env("UV_CACHE_DIR", layout.root.join("cache"))
        .env("UV_NO_CONFIG", "1")
        .env("NO_COLOR", "1")
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    hide_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| AppError::Engine(format!("No se pudo ejecutar el instalador (uv): {e}")))?;
    let mut tail = Vec::new();
    if let Some(err) = child.stderr.take() {
        for line in BufReader::new(err).lines().map_while(Result::ok) {
            let line = line.trim().to_string();
            if !line.is_empty() {
                on_line(&line);
                tail.push(line);
                if tail.len() > 8 {
                    tail.remove(0);
                }
            }
        }
    }
    let status = child.wait()?;
    if status.success() {
        Ok(())
    } else {
        Err(AppError::Engine(tail.join("\n")))
    }
}

/// Prepara (o actualiza) el entorno del motor. Bloqueante: llamar desde un hilo de trabajo.
pub fn prepare(layout: &Layout, report: &mut dyn FnMut(Progress)) -> AppResult<Manifest> {
    std::fs::create_dir_all(&layout.root)?;
    let gpu = nvidia();
    let plan = torch_plan(layout, gpu.as_ref());
    let total = 4;
    let py = layout.python();
    let py_s = py.to_string_lossy().into_owned();
    let step = |n: u32, title: &str, variant: Option<&str>, report: &mut dyn FnMut(Progress)| {
        report(Progress { step: n, total, title: title.into(), detail: String::new(), variant: variant.map(str::to_owned) });
    };

    if !py.exists() {
        step(1, "Preparando Python", None, report);
        let venv = layout.venv().to_string_lossy().into_owned();
        uv(layout, &["venv", &venv, "--python", "3.12", "--managed-python", "--no-project"], &mut |l| {
            report(Progress { step: 1, total, title: "Preparando Python".into(), detail: l.into(), variant: None })
        })?;
    }

    step(2, "Instalando el motor base", None, report);
    let core = layout.bundle("core.txt").to_string_lossy().into_owned();
    uv(layout, &["pip", "install", "--python", &py_s, "-r", &core], &mut |l| {
        report(Progress { step: 2, total, title: "Instalando el motor base".into(), detail: l.into(), variant: None })
    })?;

    let torch_req = layout.bundle("torch.txt").to_string_lossy().into_owned();
    let mut installed_variant = None;
    for variant in &plan {
        let title = match variant.as_str() {
            "pypi" => "Instalando PyTorch (Metal)".to_string(),
            "cpu" => "Instalando PyTorch (CPU)".to_string(),
            cuda => format!("Instalando PyTorch ({} · {})", cuda.to_uppercase(), gpu.as_ref().map(|g| g.0.as_str()).unwrap_or("NVIDIA")),
        };
        step(3, &title, Some(variant), report);
        let index = format!("https://download.pytorch.org/whl/{variant}");
        let mut args = vec!["pip", "install", "--python", py_s.as_str(), "-r", torch_req.as_str()];
        if variant != "pypi" {
            args.extend(["--index-url", index.as_str()]);
        }
        let ok = uv(layout, &args, &mut |l| {
            report(Progress { step: 3, total, title: title.clone(), detail: l.into(), variant: Some(variant.clone()) })
        });
        if ok.is_ok() {
            installed_variant = Some(variant.clone());
            break;
        }
    }

    if installed_variant.is_some() {
        step(4, "Instalando difusión y modelos de imagen", installed_variant.as_deref(), report);
        let diffusion = layout.bundle("diffusion.txt").to_string_lossy().into_owned();
        uv(layout, &["pip", "install", "--python", &py_s, "-r", &diffusion], &mut |l| {
            report(Progress { step: 4, total, title: "Instalando difusión y modelos de imagen".into(), detail: l.into(), variant: installed_variant.clone() })
        })?;
    }

    let manifest = Manifest {
        fingerprint: layout.fingerprint(),
        variant: installed_variant.clone().unwrap_or_else(|| "sin-pytorch".into()),
        torch: installed_variant.is_some(),
        gpu: gpu.map(|g| g.0),
    };
    std::fs::write(layout.manifest_path(), serde_json::to_string_pretty(&json!(manifest)).unwrap_or_default())?;
    Ok(manifest)
}

/// `true` si existe el motor de desarrollo (engine/.venv) y no estamos en una instalación empaquetada.
pub fn dev_python(engine_dir: &Path) -> Option<PathBuf> {
    let venv = engine_dir.join(".venv");
    let p = if cfg!(windows) { venv.join("Scripts").join("python.exe") } else { venv.join("bin").join("python") };
    p.exists().then_some(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout(dir: &Path) -> Layout {
        Layout { root: dir.join("runtime"), engine: dir.join("engine"), uv: dir.join("uv") }
    }

    #[test]
    fn plan_prefers_newest_cuda_supported_by_driver() {
        let dir = std::env::temp_dir().join(format!("aics-setup-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("engine/bundle")).unwrap();
        std::fs::write(dir.join("engine/bundle/torch-variants.json"), r#"{"torch":"2.14.1","cuda":[{"name":"cu130","min_driver":580},{"name":"cu126","min_driver":560}]}"#).unwrap();
        let l = layout(&dir);
        if cfg!(target_os = "macos") {
            assert_eq!(torch_plan(&l, None), vec!["pypi"]);
        } else {
            assert_eq!(torch_plan(&l, Some(&("RTX".into(), 590))), vec!["cu130", "cu126", "cpu"]);
            assert_eq!(torch_plan(&l, Some(&("RTX".into(), 565))), vec!["cu126", "cpu"]);
            assert_eq!(torch_plan(&l, Some(&("GTX".into(), 470))), vec!["cpu"]);
            assert_eq!(torch_plan(&l, None), vec!["cpu"]);
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn fingerprint_changes_with_bundled_versions() {
        let dir = std::env::temp_dir().join(format!("aics-fp-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("engine/bundle")).unwrap();
        let l = layout(&dir);
        std::fs::write(dir.join("engine/bundle/core.txt"), "pillow==1\n").unwrap();
        let a = l.fingerprint();
        std::fs::write(dir.join("engine/bundle/core.txt"), "pillow==2\n").unwrap();
        assert_ne!(a, l.fingerprint());
        assert!(!l.is_ready());
        let _ = std::fs::remove_dir_all(dir);
    }
}
