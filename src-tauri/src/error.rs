use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("base de datos: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("motor de IA: {0}")]
    Engine(String),
    #[error("archivo: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Invalid(String),
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        AppError::Engine(e.to_string())
    }
}

// Los comandos de Tauri devuelven el error como texto legible para la UI.
impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
