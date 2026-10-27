use std::path::PathBuf;

/// Estructura de archivos local de la app:
///
/// ```text
/// <app_data>/
///   aics.db
///   projects/<project_id>/{originals,references,results,previews,exports}
///   models/   (HF_HOME del motor)
///   tmp/
///   logs/
/// ```
#[derive(Clone, Debug)]
pub struct Paths {
    pub root: PathBuf,
}

pub const PROJECT_DIRS: [&str; 5] = ["originals", "references", "results", "previews", "exports"];

impl Paths {
    pub fn new(root: PathBuf) -> std::io::Result<Self> {
        for dir in ["projects", "models", "tmp", "logs"] {
            std::fs::create_dir_all(root.join(dir))?;
        }
        Ok(Self { root })
    }

    pub fn db(&self) -> PathBuf {
        self.root.join("aics.db")
    }

    pub fn logs(&self) -> PathBuf {
        self.root.join("logs")
    }

    pub fn tmp(&self) -> PathBuf {
        self.root.join("tmp")
    }

    pub fn project(&self, project_id: &str) -> PathBuf {
        self.root.join("projects").join(project_id)
    }

    pub fn ensure_project(&self, project_id: &str) -> std::io::Result<PathBuf> {
        let base = self.project(project_id);
        for dir in PROJECT_DIRS {
            std::fs::create_dir_all(base.join(dir))?;
        }
        Ok(base)
    }

    /// Borra los temporales de sesiones anteriores.
    pub fn clean_tmp(&self) {
        let tmp = self.tmp();
        let _ = std::fs::remove_dir_all(&tmp);
        let _ = std::fs::create_dir_all(&tmp);
    }
}
