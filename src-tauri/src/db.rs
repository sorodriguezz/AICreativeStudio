use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::AppResult;

const MIGRATIONS: &[&str] = &[
    // v1 — esquema base universal
    r#"
    CREATE TABLE projects (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        kind        TEXT NOT NULL DEFAULT 'general',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE assets (
        id            TEXT PRIMARY KEY,
        project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        job_id        TEXT,
        kind          TEXT NOT NULL,              -- original | reference | result | preview | export
        path          TEXT NOT NULL,
        width         INTEGER,
        height        INTEGER,
        rating        TEXT NOT NULL DEFAULT 'general',  -- general | sensitive
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_assets_project ON assets(project_id, created_at DESC);

    CREATE TABLE asset_references (
        id          TEXT PRIMARY KEY,
        asset_id    TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        role        TEXT NOT NULL,                -- identity | style | pose | body | background
        tags_json   TEXT NOT NULL DEFAULT '[]',
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE jobs (
        id              TEXT PRIMARY KEY,
        project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        mode            TEXT NOT NULL,
        prompt          TEXT NOT NULL,
        negative_prompt TEXT NOT NULL DEFAULT '',
        params_json     TEXT NOT NULL DEFAULT '{}',
        intent_json     TEXT,
        plan_json       TEXT,
        policy_json     TEXT,
        status          TEXT NOT NULL DEFAULT 'queued',
        progress        REAL NOT NULL DEFAULT 0,
        message         TEXT,
        error           TEXT,
        output_asset_id TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at     TEXT
    );
    CREATE INDEX idx_jobs_project ON jobs(project_id, created_at DESC);

    CREATE TABLE versions (
        id              TEXT PRIMARY KEY,
        parent_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
        child_asset_id  TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        job_id          TEXT,
        operation_type  TEXT NOT NULL,
        prompt          TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE presets (
        id            TEXT PRIMARY KEY,
        category      TEXT NOT NULL,
        name          TEXT NOT NULL,
        settings_json TEXT NOT NULL DEFAULT '{}',
        builtin       INTEGER NOT NULL DEFAULT 0,
        sort          INTEGER NOT NULL DEFAULT 0
    );

    -- Sólo para proyectos de fotografía con personas reales.
    CREATE TABLE persons (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        notes       TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE consents (
        id          TEXT PRIMARY KEY,
        person_id   TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
        scope       TEXT NOT NULL,
        file_path   TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    "#,
    // v2 — edición: imagen de entrada de cada job (para versiones padre → hijo)
    r#"
    ALTER TABLE jobs ADD COLUMN input_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL;
    CREATE INDEX idx_versions_parent ON versions(parent_asset_id);
    "#,
    // v3 — kits de marca
    r#"
    CREATE TABLE brand_kits (
        id            TEXT PRIMARY KEY,
        project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name          TEXT NOT NULL,
        logo_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
        colors_json   TEXT NOT NULL,
        palette_json  TEXT NOT NULL,
        files_json    TEXT NOT NULL,
        dir           TEXT NOT NULL,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_kits_project ON brand_kits(project_id, created_at DESC);
    "#,
    // v4 — Photo Studio: personas, referencias, consentimientos y trazabilidad
    r#"
    ALTER TABLE persons ADD COLUMN is_adult INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE persons ADD COLUMN updated_at TEXT;
    ALTER TABLE consents ADD COLUMN uses_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE consents ADD COLUMN signed_at TEXT;
    ALTER TABLE consents ADD COLUMN expires_at TEXT;
    ALTER TABLE consents ADD COLUMN revoked_at TEXT;
    ALTER TABLE consents ADD COLUMN notes TEXT;
    ALTER TABLE consents ADD COLUMN attested INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE person_references (
        id             TEXT PRIMARY KEY,
        person_id      TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
        path           TEXT NOT NULL,
        width          INTEGER,
        height         INTEGER,
        embedding_json TEXT NOT NULL,
        face_json      TEXT,
        created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE audit_log (
        id          TEXT PRIMARY KEY,
        person_id   TEXT,
        action      TEXT NOT NULL,
        detail_json TEXT NOT NULL DEFAULT '{}',
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_audit_person ON audit_log(person_id, created_at DESC);
    ALTER TABLE jobs ADD COLUMN person_id TEXT REFERENCES persons(id) ON DELETE SET NULL;
    "#,
    // v5 — producción: workflows reutilizables y lotes
    r#"
    CREATE TABLE workflows (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        steps_json  TEXT NOT NULL,
        builtin     INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT
    );
    CREATE TABLE batches (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        workflow_id TEXT REFERENCES workflows(id) ON DELETE SET NULL,
        name        TEXT NOT NULL,
        status      TEXT NOT NULL,
        total       INTEGER NOT NULL DEFAULT 0,
        done        INTEGER NOT NULL DEFAULT 0,
        failed      INTEGER NOT NULL DEFAULT 0,
        current     TEXT,
        export_dir  TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT
    );
    CREATE TABLE batch_items (
        id              TEXT PRIMARY KEY,
        batch_id        TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
        input_asset_id  TEXT REFERENCES assets(id) ON DELETE SET NULL,
        output_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        step            INTEGER NOT NULL DEFAULT 0,
        error           TEXT,
        exports_json    TEXT
    );
    "#,
    // v6 — portada elegida por el usuario para cada proyecto
    r#"
    ALTER TABLE projects ADD COLUMN cover_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL;
    "#,
    // v7 — sesiones de trabajo por sección; los resultados no se guardan en la biblioteca hasta que el usuario lo pide
    r#"
    CREATE TABLE sessions (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        section     TEXT NOT NULL,              -- create | brand | edit | enhance | restore | photo
        name        TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_sessions ON sessions(project_id, section, updated_at DESC);
    ALTER TABLE jobs ADD COLUMN session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL;
    ALTER TABLE assets ADD COLUMN saved INTEGER NOT NULL DEFAULT 1;
    "#,
];

/// (id, categoría, nombre, ajustes)
const BUILTIN_PRESETS: &[(&str, &str, &str, &str)] = &[
    ("free", "create", "Libre", r#"{}"#),
    ("photo", "create", "Fotográfico", r#"{"prompt_suffix":"photorealistic, natural light, sharp focus, high detail, 50mm photo","negative_suffix":"illustration, cartoon, painting"}"#),
    ("cinematic", "create", "Cinematográfico", r#"{"prompt_suffix":"cinematic lighting, dramatic atmosphere, film still, color graded, depth of field"}"#),
    ("illustration", "create", "Ilustración", r#"{"prompt_suffix":"digital illustration, clean lines, vibrant colors"}"#),
    ("watercolor", "create", "Acuarela", r#"{"prompt_suffix":"watercolor painting, soft washes, paper texture"}"#),
    ("anime", "create", "Anime", r#"{"prompt_suffix":"anime style, cel shading, detailed background"}"#),
    ("wallpaper", "create", "Wallpaper 16:9", r#"{"prompt_suffix":"wallpaper, wide composition, highly detailed, epic scale","aspect":"16:9"}"#),
    ("phone-wallpaper", "create", "Wallpaper móvil 9:16", r#"{"prompt_suffix":"phone wallpaper, vertical composition, highly detailed","aspect":"9:16"}"#),
    ("logo-minimal", "brand", "Logo minimalista", r#"{"mode":"brand","prompt_suffix":"minimalist logo, simple geometric mark, two colors","aspect":"1:1"}"#),
    ("logo-emblem", "brand", "Logo emblema", r#"{"mode":"brand","prompt_suffix":"emblem logo, badge, balanced symmetric design","aspect":"1:1"}"#),
    ("app-icon", "brand", "Ícono de app", r#"{"mode":"brand","prompt_suffix":"app icon, rounded square, flat design, bold simple symbol","aspect":"1:1"}"#),
    ("deck-cover", "brand", "Portada de presentación", r#"{"mode":"brand","prompt_suffix":"corporate presentation cover background, modern, clean, space for title","aspect":"16:9"}"#),
    ("social-post", "brand", "Post redes 4:5", r#"{"mode":"brand","prompt_suffix":"social media post graphic, eye-catching, clean layout","aspect":"4:5"}"#),
    ("social-story", "brand", "Historia 9:16", r#"{"mode":"brand","prompt_suffix":"vertical social media story graphic, bold, clean layout","aspect":"9:16"}"#),
    ("edit-free", "edit", "Libre", r#"{}"#),
    ("edit-photo", "edit", "Fotográfico", r#"{"prompt_suffix":"photorealistic, natural light, high detail"}"#),
    ("edit-cinematic", "edit", "Cinematográfico", r#"{"prompt_suffix":"cinematic lighting, film still, color graded"}"#),
    ("edit-watercolor", "edit", "Acuarela", r#"{"prompt_suffix":"watercolor painting, soft washes, paper texture"}"#),
    ("edit-studio", "edit", "Estudio de producto", r#"{"prompt_suffix":"clean studio backdrop, soft box lighting, professional product photography"}"#),
];

pub fn open(path: &std::path::Path) -> AppResult<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
    migrate(&conn)?;
    seed(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> AppResult<()> {
    let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        conn.execute_batch(&format!("BEGIN; {sql}; PRAGMA user_version = {}; COMMIT;", i + 1))?;
    }
    Ok(())
}

fn seed(conn: &Connection) -> AppResult<()> {
    for (i, (id, category, name, settings)) in BUILTIN_PRESETS.iter().enumerate() {
        conn.execute(
            "INSERT INTO presets (id, category, name, settings_json, builtin, sort) VALUES (?1, ?2, ?3, ?4, 1, ?5)
             ON CONFLICT(id) DO UPDATE SET category = ?2, name = ?3, settings_json = ?4, sort = ?5",
            params![id, category, name, settings, i as i64],
        )?;
    }
    let has_project: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM projects)", [], |r| r.get(0))?;
    if !has_project {
        conn.execute("INSERT INTO projects (id, name, kind) VALUES ('general', 'General', 'general')", [])?;
    }
    crate::batch::seed(conn)?;
    crate::batch::recover(conn)?;
    // Jobs que quedaron a medias si la app se cerró durante la ejecución.
    conn.execute(
        "UPDATE jobs SET status = 'failed', error = 'Interrumpido al cerrar la app', finished_at = datetime('now')
         WHERE status IN ('queued', 'running')",
        [],
    )?;
    Ok(())
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn json_col(row: &Row, idx: &str) -> rusqlite::Result<Value> {
    let raw: Option<String> = row.get(idx)?;
    Ok(raw.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null))
}

// ---------- Proyectos ----------

#[derive(Serialize, Debug, Clone)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub created_at: String,
    pub updated_at: String,
    pub asset_count: i64,
    pub cover_path: Option<String>,
    /// Portada elegida; si es None, se usa la imagen más reciente.
    pub cover_asset_id: Option<String>,
}

pub fn list_projects(conn: &Connection) -> AppResult<Vec<Project>> {
    let mut stmt = conn.prepare(
        "SELECT p.*, (SELECT COUNT(*) FROM assets a WHERE a.project_id = p.id AND a.kind IN ('result', 'original') AND a.saved = 1) AS asset_count,
                COALESCE(
                    (SELECT a.path FROM assets a WHERE a.id = p.cover_asset_id AND a.saved = 1),
                    (SELECT a.path FROM assets a WHERE a.project_id = p.id AND a.kind IN ('result', 'original') AND a.saved = 1 ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1)
                ) AS cover_path
         FROM projects p ORDER BY p.updated_at DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Project {
            id: r.get("id")?,
            name: r.get("name")?,
            kind: r.get("kind")?,
            created_at: r.get("created_at")?,
            updated_at: r.get("updated_at")?,
            asset_count: r.get("asset_count")?,
            cover_path: r.get("cover_path")?,
            cover_asset_id: r.get("cover_asset_id")?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn create_project(conn: &Connection, name: &str, kind: &str) -> AppResult<String> {
    let id = new_id();
    conn.execute("INSERT INTO projects (id, name, kind) VALUES (?1, ?2, ?3)", params![id, name, kind])?;
    Ok(id)
}

pub fn rename_project(conn: &Connection, id: &str, name: &str) -> AppResult<()> {
    conn.execute("UPDATE projects SET name = ?2, updated_at = datetime('now') WHERE id = ?1", params![id, name])?;
    Ok(())
}

/// Elige la portada del proyecto (None vuelve a la imagen más reciente). La imagen debe ser del proyecto.
pub fn set_project_cover(conn: &Connection, project_id: &str, asset_id: Option<&str>) -> AppResult<()> {
    if let Some(asset) = asset_id {
        let ok: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM assets WHERE id = ?1 AND project_id = ?2)", params![asset, project_id], |r| r.get(0))?;
        if !ok {
            return Err(crate::error::AppError::Invalid("La imagen no pertenece a este proyecto".into()));
        }
    }
    conn.execute("UPDATE projects SET cover_asset_id = ?2 WHERE id = ?1", params![project_id, asset_id])?;
    Ok(())
}

/// Borra el proyecto con todo lo suyo (imágenes, trabajos, sesiones, kits y lotes).
/// Devuelve las imágenes borradas para quitar sus archivos. Siempre queda al menos un proyecto.
pub fn delete_project(conn: &mut Connection, id: &str) -> AppResult<Vec<Asset>> {
    if !project_exists(conn, id)? {
        return Err(crate::error::AppError::Invalid("El proyecto no existe".into()));
    }
    let others: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM projects WHERE id != ?1)", params![id], |r| r.get(0))?;
    if !others {
        return Err(crate::error::AppError::Invalid("No puedes borrar el único proyecto. Crea otro primero.".into()));
    }
    let busy: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM jobs WHERE project_id = ?1 AND status IN ('queued', 'running'))
             OR EXISTS(SELECT 1 FROM batches WHERE project_id = ?1 AND status = 'running')",
        params![id],
        |r| r.get(0),
    )?;
    if busy {
        return Err(crate::error::AppError::Invalid("El proyecto tiene trabajos en curso. Espera a que terminen o cancélalos.".into()));
    }
    let tx = conn.transaction()?;
    let assets = {
        let mut stmt = tx.prepare("SELECT * FROM assets WHERE project_id = ?1")?;
        let rows = stmt.query_map(params![id], asset_from_row)?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    tx.execute("DELETE FROM assets WHERE project_id = ?1", params![id])?;
    tx.execute("DELETE FROM projects WHERE id = ?1", params![id])?;
    tx.commit()?;
    Ok(assets)
}

pub fn touch_project(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("UPDATE projects SET updated_at = datetime('now') WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn project_exists(conn: &Connection, id: &str) -> AppResult<bool> {
    Ok(conn.query_row("SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)", params![id], |r| r.get(0))?)
}

// ---------- Presets ----------

#[derive(Serialize, Debug)]
pub struct Preset {
    pub id: String,
    pub category: String,
    pub name: String,
    pub settings: Value,
    pub builtin: bool,
}

pub fn list_presets(conn: &Connection, category: Option<&str>) -> AppResult<Vec<Preset>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM presets WHERE (?1 IS NULL OR category = ?1) ORDER BY builtin DESC, sort, name",
    )?;
    let rows = stmt.query_map(params![category], |r| {
        Ok(Preset {
            id: r.get("id")?,
            category: r.get("category")?,
            name: r.get("name")?,
            settings: json_col(r, "settings_json")?,
            builtin: r.get::<_, i64>("builtin")? == 1,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

// ---------- Jobs ----------

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct JobRecord {
    pub id: String,
    pub project_id: String,
    pub mode: String,
    pub prompt: String,
    pub negative_prompt: String,
    pub params: Value,
    pub intent: Value,
    pub plan: Value,
    pub policy: Value,
    pub status: String,
    pub progress: f64,
    pub message: Option<String>,
    pub error: Option<String>,
    pub output_asset_id: Option<String>,
    pub input_asset_id: Option<String>,
    pub session_id: Option<String>,
    pub created_at: String,
    pub finished_at: Option<String>,
}

fn job_from_row(r: &Row) -> rusqlite::Result<JobRecord> {
    Ok(JobRecord {
        id: r.get("id")?,
        project_id: r.get("project_id")?,
        mode: r.get("mode")?,
        prompt: r.get("prompt")?,
        negative_prompt: r.get("negative_prompt")?,
        params: json_col(r, "params_json")?,
        intent: json_col(r, "intent_json")?,
        plan: json_col(r, "plan_json")?,
        policy: json_col(r, "policy_json")?,
        status: r.get("status")?,
        progress: r.get("progress")?,
        message: r.get("message")?,
        error: r.get("error")?,
        output_asset_id: r.get("output_asset_id")?,
        input_asset_id: r.get("input_asset_id")?,
        session_id: r.get("session_id")?,
        created_at: r.get("created_at")?,
        finished_at: r.get("finished_at")?,
    })
}

pub struct NewJob<'a> {
    pub id: &'a str,
    pub project_id: &'a str,
    pub mode: &'a str,
    pub prompt: &'a str,
    pub negative: &'a str,
    pub params: &'a Value,
    pub input_asset_id: Option<&'a str>,
    pub person_id: Option<&'a str>,
    pub session_id: Option<&'a str>,
}

pub fn insert_job(conn: &Connection, job: &NewJob) -> AppResult<()> {
    conn.execute(
        "INSERT INTO jobs (id, project_id, mode, prompt, negative_prompt, params_json, input_asset_id, person_id, session_id, message)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'Enviando al motor')",
        params![job.id, job.project_id, job.mode, job.prompt, job.negative, job.params.to_string(), job.input_asset_id, job.person_id, job.session_id],
    )?;
    Ok(())
}

/// Aplica el estado que reporta el motor (JobState de Python).
pub fn apply_engine_state(conn: &Connection, id: &str, state: &Value) -> AppResult<()> {
    let s = |k: &str| state.get(k).filter(|v| !v.is_null()).map(|v| v.to_string());
    let terminal = matches!(state["status"].as_str(), Some("completed" | "failed" | "cancelled" | "rejected"));
    conn.execute(
        "UPDATE jobs SET status = ?2, progress = ?3, message = ?4, error = ?5,
             intent_json = COALESCE(?6, intent_json), plan_json = COALESCE(?7, plan_json), policy_json = COALESCE(?8, policy_json),
             finished_at = CASE WHEN ?9 THEN COALESCE(finished_at, datetime('now')) ELSE finished_at END
         WHERE id = ?1",
        params![
            id,
            state["status"].as_str().unwrap_or("failed"),
            state["progress"].as_f64().unwrap_or(0.0),
            state["message"].as_str(),
            state["error"].as_str(),
            s("intent"),
            s("plan"),
            s("policy"),
            terminal,
        ],
    )?;
    Ok(())
}

pub fn fail_job(conn: &Connection, id: &str, error: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE jobs SET status = 'failed', error = ?2, message = 'Error', finished_at = datetime('now') WHERE id = ?1",
        params![id, error],
    )?;
    Ok(())
}

/// ¿Hay trabajos en cola o ejecutándose?
pub fn active_jobs(conn: &Connection) -> AppResult<bool> {
    Ok(conn.query_row("SELECT EXISTS(SELECT 1 FROM jobs WHERE status IN ('queued', 'running'))", [], |r| r.get(0))?)
}

pub fn get_job(conn: &Connection, id: &str) -> AppResult<Option<JobRecord>> {
    Ok(conn.query_row("SELECT * FROM jobs WHERE id = ?1", params![id], job_from_row).optional()?)
}

pub fn list_jobs(conn: &Connection, project_id: Option<&str>, limit: i64) -> AppResult<Vec<JobRecord>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM jobs WHERE (?1 IS NULL OR project_id = ?1) ORDER BY created_at DESC, rowid DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![project_id, limit], job_from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

// ---------- Assets ----------

#[derive(Serialize, Debug, Clone)]
pub struct Asset {
    pub id: String,
    pub project_id: String,
    pub job_id: Option<String>,
    pub kind: String,
    pub path: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub rating: String,
    pub metadata: Value,
    /// En la biblioteca. Los resultados de una sesión empiezan sin guardar.
    pub saved: bool,
    pub created_at: String,
}

fn asset_from_row(r: &Row) -> rusqlite::Result<Asset> {
    Ok(Asset {
        id: r.get("id")?,
        project_id: r.get("project_id")?,
        job_id: r.get("job_id")?,
        kind: r.get("kind")?,
        path: r.get("path")?,
        width: r.get("width")?,
        height: r.get("height")?,
        rating: r.get("rating")?,
        metadata: json_col(r, "metadata_json")?,
        saved: r.get::<_, i64>("saved")? == 1,
        created_at: r.get("created_at")?,
    })
}

/// Registra los resultados de un job como assets + versión (padre = imagen de entrada, si la hay).
pub fn record_outputs(conn: &mut Connection, job: &JobRecord, outputs: &[Value], rating: &str) -> AppResult<Vec<String>> {
    let tx = conn.transaction()?;
    let mut ids = Vec::new();
    for out in outputs {
        let id = new_id();
        let operation = out["operation"].as_str().unwrap_or("text_to_image");
        let mut meta = serde_json::json!({
            "seed": out["seed"], "model_id": out["model_id"], "prompt": job.prompt,
            "operation": operation, "parent_id": job.input_asset_id,
        });
        for key in ["validation", "person_id", "report"] {
            if !out[key].is_null() {
                meta[key] = out[key].clone();
            }
        }
        // Los trabajos de una sesión dejan sus resultados sin guardar; los de lotes y versiones anteriores, guardados.
        tx.execute(
            "INSERT INTO assets (id, project_id, job_id, kind, path, width, height, rating, metadata_json, saved)
             VALUES (?1, ?2, ?3, 'result', ?4, ?5, ?6, ?7, ?8, ?9)",
            params![id, job.project_id, job.id, out["path"].as_str().unwrap_or_default(), out["width"].as_i64(), out["height"].as_i64(), rating, meta.to_string(), job.session_id.is_none() as i64],
        )?;
        tx.execute(
            "INSERT INTO versions (id, parent_asset_id, child_asset_id, job_id, operation_type, prompt) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![new_id(), job.input_asset_id, id, job.id, operation, job.prompt],
        )?;
        ids.push(id);
    }
    if let Some(first) = ids.first() {
        tx.execute("UPDATE jobs SET output_asset_id = ?2 WHERE id = ?1", params![job.id, first])?;
    }
    tx.execute("UPDATE projects SET updated_at = datetime('now') WHERE id = ?1", params![job.project_id])?;
    tx.execute("UPDATE sessions SET updated_at = datetime('now') WHERE id = ?1", params![job.session_id])?;
    tx.commit()?;
    Ok(ids)
}

/// Imágenes de la biblioteca (sólo las guardadas, salvo que se pidan por trabajo).
#[cfg(test)]
pub fn list_assets(conn: &Connection, project_id: Option<&str>, job_id: Option<&str>, limit: i64) -> AppResult<Vec<Asset>> {
    query_assets(conn, project_id, job_id, limit, job_id.is_some())
}

pub fn query_assets(conn: &Connection, project_id: Option<&str>, job_id: Option<&str>, limit: i64, include_unsaved: bool) -> AppResult<Vec<Asset>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM assets WHERE kind IN ('result', 'original') AND (?1 IS NULL OR project_id = ?1) AND (?2 IS NULL OR job_id = ?2)
           AND (?4 OR saved = 1)
         ORDER BY created_at DESC, rowid DESC LIMIT ?3",
    )?;
    let rows = stmt.query_map(params![project_id, job_id, limit, include_unsaved], asset_from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Imágenes generadas con la identidad de una persona.
pub fn assets_of_person(conn: &Connection, person_id: &str, limit: i64) -> AppResult<Vec<Asset>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM assets WHERE json_extract(metadata_json, '$.person_id') = ?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![person_id, limit], asset_from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get_asset(conn: &Connection, id: &str) -> AppResult<Option<Asset>> {
    Ok(conn.query_row("SELECT * FROM assets WHERE id = ?1", params![id], asset_from_row).optional()?)
}

/// Versiones derivadas directamente de un asset (ediciones hechas sobre él), más recientes primero.
pub fn asset_children(conn: &Connection, id: &str) -> AppResult<Vec<Asset>> {
    let mut stmt = conn.prepare(
        "SELECT a.* FROM versions v JOIN assets a ON a.id = v.child_asset_id
         WHERE v.parent_asset_id = ?1 ORDER BY a.created_at DESC, a.rowid DESC",
    )?;
    let rows = stmt.query_map(params![id], asset_from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Asset derivado sin IA (p. ej. SVG vectorizado), registrado como versión hija de `parent_id`.
pub fn insert_derived(conn: &Connection, parent: &Asset, path: &str, operation: &str) -> AppResult<String> {
    let id = new_id();
    let meta = serde_json::json!({
        "prompt": parent.metadata.get("prompt"), "operation": operation, "parent_id": parent.id,
    });
    conn.execute(
        "INSERT INTO assets (id, project_id, kind, path, width, height, rating, metadata_json) VALUES (?1, ?2, 'result', ?3, ?4, ?5, ?6, ?7)",
        params![id, parent.project_id, path, parent.width, parent.height, parent.rating, meta.to_string()],
    )?;
    conn.execute(
        "INSERT INTO versions (id, parent_asset_id, child_asset_id, operation_type) VALUES (?1, ?2, ?3, ?4)",
        params![new_id(), parent.id, id, operation],
    )?;
    Ok(id)
}

/// Lo que se borraría al eliminar `ids`: con `with_versions`, también todas las ediciones hechas a partir
/// de ellas (en cascada). Sin repetir y en orden de descubrimiento.
pub fn deletion_set(conn: &Connection, ids: &[String], with_versions: bool) -> AppResult<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    let mut stmt = conn.prepare(
        "WITH RECURSIVE tree(id) AS (
             SELECT ?1
             UNION SELECT v.child_asset_id FROM versions v JOIN tree t ON v.parent_asset_id = t.id
         ) SELECT id FROM tree",
    )?;
    for id in ids {
        let found: Vec<String> = if with_versions {
            stmt.query_map(params![id], |r| r.get(0))?.collect::<Result<_, _>>()?
        } else {
            vec![id.clone()]
        };
        for f in found {
            if !out.contains(&f) {
                out.push(f);
            }
        }
    }
    Ok(out)
}

/// Elimina assets del registro y devuelve los que se borraron (para quitar sus archivos).
/// Las ediciones que no se incluyan quedan como imágenes sueltas (su padre pasa a NULL).
pub fn delete_assets(conn: &mut Connection, ids: &[String], with_versions: bool) -> AppResult<Vec<Asset>> {
    let all = deletion_set(conn, ids, with_versions)?;
    for id in &all {
        let in_use: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM jobs WHERE input_asset_id = ?1 AND status IN ('queued', 'running'))
                 OR EXISTS(SELECT 1 FROM batch_items WHERE input_asset_id = ?1 AND status IN ('pending', 'running'))",
            params![id],
            |r| r.get(0),
        )?;
        if in_use {
            return Err(crate::error::AppError::Invalid(
                "Una de las imágenes se está usando en un trabajo en curso. Espera a que termine o cancélalo.".into(),
            ));
        }
    }
    let tx = conn.transaction()?;
    let mut deleted = Vec::new();
    for id in &all {
        let Some(asset) = tx.query_row("SELECT * FROM assets WHERE id = ?1", params![id], asset_from_row).optional()? else { continue };
        tx.execute("DELETE FROM assets WHERE id = ?1", params![id])?;
        // El trabajo que la generó apunta a otra de sus imágenes, si le queda alguna.
        tx.execute(
            "UPDATE jobs SET output_asset_id = (SELECT a.id FROM assets a WHERE a.job_id = jobs.id ORDER BY a.created_at, a.rowid LIMIT 1)
             WHERE output_asset_id = ?1",
            params![id],
        )?;
        if let Some(person) = asset.metadata["person_id"].as_str() {
            crate::persons::audit(&tx, Some(person), "imagen_eliminada", serde_json::json!({ "asset_id": id }))?;
        }
        tx.execute("UPDATE projects SET updated_at = datetime('now') WHERE id = ?1", params![asset.project_id])?;
        deleted.push(asset);
    }
    tx.commit()?;
    Ok(deleted)
}

/// Trabajos terminados del historial (todos, o los de un proyecto). Los que están en curso no se tocan.
pub fn finished_job_ids(conn: &Connection, project_id: Option<&str>) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT id FROM jobs WHERE (?1 IS NULL OR project_id = ?1) AND status NOT IN ('queued', 'running')")?;
    let rows = stmt.query_map(params![project_id], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Imágenes que produjeron estos trabajos.
pub fn assets_of_jobs(conn: &Connection, job_ids: &[String]) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT id FROM assets WHERE job_id = ?1")?;
    let mut out = Vec::new();
    for id in job_ids {
        out.extend(stmt.query_map(params![id], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?);
    }
    Ok(out)
}

/// Quita trabajos del historial. Sus imágenes quedan en la biblioteca salvo que se borren aparte.
pub fn delete_jobs(conn: &mut Connection, ids: &[String]) -> AppResult<usize> {
    let tx = conn.transaction()?;
    let mut n = 0;
    for id in ids {
        n += tx.execute("DELETE FROM jobs WHERE id = ?1 AND status NOT IN ('queued', 'running')", params![id])?;
    }
    tx.commit()?;
    Ok(n)
}

// ---------- Sesiones ----------

#[derive(Serialize, Debug, Clone)]
pub struct Session {
    pub id: String,
    pub project_id: String,
    pub section: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    pub jobs: i64,
    pub images: i64,
    /// Imágenes que se borrarán con la sesión (no agregadas a la biblioteca).
    pub unsaved: i64,
    pub cover_path: Option<String>,
}

const SESSION_SELECT: &str = "SELECT s.*,
    (SELECT COUNT(*) FROM jobs j WHERE j.session_id = s.id) AS jobs,
    (SELECT COUNT(*) FROM assets a JOIN jobs j ON a.job_id = j.id WHERE j.session_id = s.id) AS images,
    (SELECT COUNT(*) FROM assets a JOIN jobs j ON a.job_id = j.id WHERE j.session_id = s.id AND a.saved = 0) AS unsaved,
    (SELECT a.path FROM assets a JOIN jobs j ON a.job_id = j.id WHERE j.session_id = s.id ORDER BY a.created_at DESC LIMIT 1) AS cover_path
    FROM sessions s";

fn session_from_row(r: &Row) -> rusqlite::Result<Session> {
    Ok(Session {
        id: r.get("id")?,
        project_id: r.get("project_id")?,
        section: r.get("section")?,
        name: r.get("name")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
        jobs: r.get("jobs")?,
        images: r.get("images")?,
        unsaved: r.get("unsaved")?,
        cover_path: r.get("cover_path")?,
    })
}

pub fn list_sessions(conn: &Connection, project_id: &str, section: &str) -> AppResult<Vec<Session>> {
    let mut stmt = conn.prepare(&format!("{SESSION_SELECT} WHERE s.project_id = ?1 AND s.section = ?2 ORDER BY s.updated_at DESC, s.rowid DESC"))?;
    let rows = stmt.query_map(params![project_id, section], session_from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get_session(conn: &Connection, id: &str) -> AppResult<Option<Session>> {
    Ok(conn.query_row(&format!("{SESSION_SELECT} WHERE s.id = ?1"), params![id], session_from_row).optional()?)
}

pub fn create_session(conn: &Connection, project_id: &str, section: &str, name: &str) -> AppResult<String> {
    let id = new_id();
    let name: String = name.trim().chars().take(60).collect();
    let name = if name.is_empty() { "Sesión sin título".to_string() } else { name };
    conn.execute("INSERT INTO sessions (id, project_id, section, name) VALUES (?1, ?2, ?3, ?4)", params![id, project_id, section, name])?;
    Ok(id)
}

pub fn rename_session(conn: &Connection, id: &str, name: &str) -> AppResult<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(crate::error::AppError::Invalid("La sesión necesita un nombre".into()));
    }
    conn.execute("UPDATE sessions SET name = ?2 WHERE id = ?1", params![id, name])?;
    Ok(())
}

/// Trabajos e imágenes sin guardar de una sesión (para borrarla).
pub fn session_contents(conn: &Connection, id: &str) -> AppResult<(Vec<String>, Vec<String>)> {
    let active: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM jobs WHERE session_id = ?1 AND status IN ('queued', 'running'))", params![id], |r| r.get(0))?;
    if active {
        return Err(crate::error::AppError::Invalid("La sesión tiene un trabajo en curso. Espera a que termine o cancélalo.".into()));
    }
    let mut stmt = conn.prepare("SELECT id FROM jobs WHERE session_id = ?1")?;
    let jobs: Vec<String> = stmt.query_map(params![id], |r| r.get(0))?.collect::<Result<_, _>>()?;
    let mut stmt = conn.prepare("SELECT a.id FROM assets a JOIN jobs j ON a.job_id = j.id WHERE j.session_id = ?1 AND a.saved = 0")?;
    let unsaved: Vec<String> = stmt.query_map(params![id], |r| r.get(0))?.collect::<Result<_, _>>()?;
    Ok((jobs, unsaved))
}

pub fn delete_session_row(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM sessions WHERE id = ?1", params![id])?;
    Ok(())
}

/// Agrega (o quita) imágenes de la biblioteca.
pub fn set_saved(conn: &Connection, ids: &[String], saved: bool) -> AppResult<()> {
    for id in ids {
        conn.execute("UPDATE assets SET saved = ?2 WHERE id = ?1", params![id, saved as i64])?;
        if !saved {
            conn.execute("UPDATE projects SET cover_asset_id = NULL WHERE cover_asset_id = ?1", params![id])?;
        }
    }
    Ok(())
}

/// ¿Algún asset restante usa este archivo? (para no borrar un archivo compartido).
pub fn path_in_use(conn: &Connection, path: &str) -> AppResult<bool> {
    Ok(conn.query_row("SELECT EXISTS(SELECT 1 FROM assets WHERE path = ?1)", params![path], |r| r.get(0))?)
}

// ---------- Kits de marca ----------

#[derive(Serialize, Debug, Clone)]
pub struct BrandKit {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub logo_asset_id: Option<String>,
    pub colors: Value,
    pub palette: Value,
    pub files: Value,
    pub dir: String,
    pub created_at: String,
}

fn kit_from_row(r: &Row) -> rusqlite::Result<BrandKit> {
    Ok(BrandKit {
        id: r.get("id")?,
        project_id: r.get("project_id")?,
        name: r.get("name")?,
        logo_asset_id: r.get("logo_asset_id")?,
        colors: json_col(r, "colors_json")?,
        palette: json_col(r, "palette_json")?,
        files: json_col(r, "files_json")?,
        dir: r.get("dir")?,
        created_at: r.get("created_at")?,
    })
}

pub struct NewKit<'a> {
    pub id: &'a str,
    pub project_id: &'a str,
    pub name: &'a str,
    pub logo_asset_id: &'a str,
    pub colors: &'a Value,
    pub palette: &'a Value,
    pub files: &'a Value,
    pub dir: &'a str,
}

pub fn insert_kit(conn: &Connection, kit: &NewKit) -> AppResult<()> {
    conn.execute(
        "INSERT INTO brand_kits (id, project_id, name, logo_asset_id, colors_json, palette_json, files_json, dir) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![kit.id, kit.project_id, kit.name, kit.logo_asset_id, kit.colors.to_string(), kit.palette.to_string(), kit.files.to_string(), kit.dir],
    )?;
    conn.execute("UPDATE projects SET updated_at = datetime('now') WHERE id = ?1", params![kit.project_id])?;
    Ok(())
}

pub fn list_kits(conn: &Connection, project_id: Option<&str>) -> AppResult<Vec<BrandKit>> {
    let mut stmt = conn.prepare("SELECT * FROM brand_kits WHERE (?1 IS NULL OR project_id = ?1) ORDER BY created_at DESC, rowid DESC")?;
    let rows = stmt.query_map(params![project_id], kit_from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get_kit(conn: &Connection, id: &str) -> AppResult<Option<BrandKit>> {
    Ok(conn.query_row("SELECT * FROM brand_kits WHERE id = ?1", params![id], kit_from_row).optional()?)
}

pub fn insert_original(conn: &Connection, project_id: &str, path: &str, width: Option<i64>, height: Option<i64>, name: &str) -> AppResult<String> {
    let id = new_id();
    let meta = serde_json::json!({ "source_name": name, "operation": "import" });
    conn.execute(
        "INSERT INTO assets (id, project_id, kind, path, width, height, metadata_json) VALUES (?1, ?2, 'original', ?3, ?4, ?5, ?6)",
        params![id, project_id, path, width, height, meta.to_string()],
    )?;
    conn.execute("UPDATE projects SET updated_at = datetime('now') WHERE id = ?1", params![project_id])?;
    Ok(id)
}

// ---------- Ajustes ----------

pub fn get_setting(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    Ok(conn.query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| r.get(0)).optional()?)
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
        params![key, value],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        migrate(&conn).unwrap();
        seed(&conn).unwrap();
        conn
    }

    #[test]
    fn migrations_and_seed_are_idempotent() {
        let conn = mem();
        migrate(&conn).unwrap();
        seed(&conn).unwrap();
        assert_eq!(list_projects(&conn).unwrap().len(), 1);
        assert_eq!(list_presets(&conn, None).unwrap().len(), BUILTIN_PRESETS.len());
        assert!(list_presets(&conn, Some("brand")).unwrap().iter().all(|p| p.category == "brand"));
    }

    #[test]
    fn job_lifecycle_records_outputs() {
        let mut conn = mem();
        let params = serde_json::json!({});
        insert_job(&conn, &NewJob { id: "j1", project_id: "general", mode: "create", prompt: "un lobo", negative: "", params: &params, input_asset_id: None, person_id: None, session_id: None }).unwrap();
        let state = serde_json::json!({"status": "completed", "progress": 1.0, "message": "Listo", "error": null,
                                       "intent": {"domain": "create"}, "plan": null, "policy": {"rating": "general"}});
        apply_engine_state(&conn, "j1", &state).unwrap();
        let job = get_job(&conn, "j1").unwrap().unwrap();
        assert_eq!(job.status, "completed");
        assert_eq!(job.intent["domain"], "create");
        assert!(job.finished_at.is_some());

        let outputs = vec![serde_json::json!({"path": "/x/1.png", "width": 64, "height": 64, "seed": 1, "model_id": "m"})];
        let ids = record_outputs(&mut conn, &job, &outputs, "general").unwrap();
        assert_eq!(get_job(&conn, "j1").unwrap().unwrap().output_asset_id.as_deref(), Some(ids[0].as_str()));
        assert_eq!(list_assets(&conn, Some("general"), None, 10).unwrap().len(), 1);
        assert_eq!(list_projects(&conn).unwrap()[0].asset_count, 1);
    }

    #[test]
    fn edits_are_recorded_as_child_versions() {
        let mut conn = mem();
        let original = insert_original(&conn, "general", "/x/in.png", Some(640), Some(480), "in.png").unwrap();
        let params = serde_json::json!({ "operation": "upscale" });
        insert_job(&conn, &NewJob { id: "j2", project_id: "general", mode: "enhance", prompt: "", negative: "", params: &params, input_asset_id: Some(&original), person_id: None, session_id: None }).unwrap();
        let job = get_job(&conn, "j2").unwrap().unwrap();
        let outputs = vec![serde_json::json!({"path": "/x/out.png", "width": 1280, "height": 960, "seed": null, "model_id": "realesrgan-x4", "operation": "upscale"})];
        let ids = record_outputs(&mut conn, &job, &outputs, "general").unwrap();
        let children = asset_children(&conn, &original).unwrap();
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].id, ids[0]);
        assert_eq!(children[0].metadata["operation"], "upscale");
        assert_eq!(list_assets(&conn, Some("general"), None, 10).unwrap().len(), 2);

        let parent = get_asset(&conn, &ids[0]).unwrap().unwrap();
        let svg = insert_derived(&conn, &parent, "/x/out.svg", "vectorize").unwrap();
        assert_eq!(asset_children(&conn, &parent.id).unwrap()[0].id, svg);
    }

    #[test]
    fn deleting_assets_keeps_or_cascades_versions() {
        let mut conn = mem();
        let original = insert_original(&conn, "general", "/x/in.png", Some(64), Some(64), "in.png").unwrap();
        let parent = get_asset(&conn, &original).unwrap().unwrap();
        let edit = insert_derived(&conn, &parent, "/x/edit.png", "upscale").unwrap();
        let edit_asset = get_asset(&conn, &edit).unwrap().unwrap();
        let edit2 = insert_derived(&conn, &edit_asset, "/x/edit2.png", "vectorize").unwrap();
        assert_eq!(deletion_set(&conn, &[original.clone()], true).unwrap().len(), 3);

        // Sin versiones: las ediciones quedan como imágenes sueltas.
        let gone = delete_assets(&mut conn, &[original.clone()], false).unwrap();
        assert_eq!(gone.len(), 1);
        assert!(get_asset(&conn, &original).unwrap().is_none());
        assert!(get_asset(&conn, &edit).unwrap().is_some());
        assert!(!path_in_use(&conn, "/x/in.png").unwrap());

        // Con versiones: se va toda la rama.
        assert_eq!(delete_assets(&mut conn, &[edit.clone()], true).unwrap().len(), 2);
        assert!(get_asset(&conn, &edit2).unwrap().is_none());
        assert_eq!(list_assets(&conn, Some("general"), None, 10).unwrap().len(), 0);
    }

    #[test]
    fn deleting_refuses_assets_in_use_and_repoints_jobs() {
        let mut conn = mem();
        let original = insert_original(&conn, "general", "/x/in.png", Some(64), Some(64), "in.png").unwrap();
        let params = serde_json::json!({});
        insert_job(&conn, &NewJob { id: "j3", project_id: "general", mode: "enhance", prompt: "", negative: "", params: &params, input_asset_id: Some(&original), person_id: None, session_id: None }).unwrap();
        assert!(delete_assets(&mut conn, &[original.clone()], false).is_err());

        conn.execute("UPDATE jobs SET status = 'completed' WHERE id = 'j3'", []).unwrap();
        let job = get_job(&conn, "j3").unwrap().unwrap();
        let outputs = vec![
            serde_json::json!({"path": "/x/a.png", "width": 64, "height": 64}),
            serde_json::json!({"path": "/x/b.png", "width": 64, "height": 64}),
        ];
        let ids = record_outputs(&mut conn, &job, &outputs, "general").unwrap();
        delete_assets(&mut conn, &[ids[0].clone()], false).unwrap();
        assert_eq!(get_job(&conn, "j3").unwrap().unwrap().output_asset_id.as_deref(), Some(ids[1].as_str()));
        delete_assets(&mut conn, &[ids[1].clone(), original], false).unwrap();
        assert_eq!(get_job(&conn, "j3").unwrap().unwrap().output_asset_id, None);
    }

    #[test]
    fn deleting_a_project_removes_its_contents_but_not_the_last_one() {
        let mut conn = mem();
        assert!(delete_project(&mut conn, "general").is_err()); // el único
        let other = create_project(&conn, "Otro", "general").unwrap();
        let a = insert_original(&conn, &other, "/x/a.png", Some(8), Some(8), "a.png").unwrap();
        let params = serde_json::json!({});
        insert_job(&conn, &NewJob { id: "jp", project_id: &other, mode: "create", prompt: "", negative: "", params: &params, input_asset_id: Some(&a), person_id: None, session_id: None }).unwrap();
        assert!(delete_project(&mut conn, &other).is_err()); // trabajo en curso

        conn.execute("UPDATE jobs SET status = 'completed' WHERE id = 'jp'", []).unwrap();
        let removed = delete_project(&mut conn, &other).unwrap();
        assert_eq!(removed.len(), 1);
        assert!(!project_exists(&conn, &other).unwrap());
        assert!(get_job(&conn, "jp").unwrap().is_none());
        assert!(get_asset(&conn, &a).unwrap().is_none());
    }

    #[test]
    fn project_cover_can_be_chosen_and_falls_back() {
        let mut conn = mem();
        let a = insert_original(&conn, "general", "/x/a.png", Some(8), Some(8), "a.png").unwrap();
        let b = insert_original(&conn, "general", "/x/b.png", Some(8), Some(8), "b.png").unwrap();
        let cover = |c: &Connection| list_projects(c).unwrap()[0].cover_path.clone();
        assert_eq!(cover(&conn).as_deref(), Some("/x/b.png")); // la más reciente
        assert_eq!(list_projects(&conn).unwrap()[0].asset_count, 2);

        set_project_cover(&conn, "general", Some(&a)).unwrap();
        assert_eq!(cover(&conn).as_deref(), Some("/x/a.png"));
        let other = create_project(&conn, "Otro", "general").unwrap();
        assert!(set_project_cover(&conn, &other, Some(&a)).is_err());

        // Si se borra la portada, vuelve a la más reciente.
        delete_assets(&mut conn, &[a], false).unwrap();
        assert_eq!(cover(&conn).as_deref(), Some("/x/b.png"));
        let _ = b;
    }

    #[test]
    fn history_can_be_cleared_keeping_or_removing_images() {
        let mut conn = mem();
        let params = serde_json::json!({});
        for id in ["h1", "h2", "h3"] {
            insert_job(&conn, &NewJob { id, project_id: "general", mode: "create", prompt: "x", negative: "", params: &params, input_asset_id: None, person_id: None, session_id: None }).unwrap();
        }
        conn.execute("UPDATE jobs SET status = 'completed' WHERE id IN ('h1', 'h2')", []).unwrap();
        let job = get_job(&conn, "h1").unwrap().unwrap();
        record_outputs(&mut conn, &job, &[serde_json::json!({"path": "/x/h1.png"})], "general").unwrap();

        let finished = finished_job_ids(&conn, Some("general")).unwrap();
        assert_eq!(finished.len(), 2); // h3 sigue en cola
        assert_eq!(assets_of_jobs(&conn, &finished).unwrap().len(), 1);
        assert_eq!(delete_jobs(&mut conn, &["h1".into(), "h3".into()]).unwrap(), 1);
        assert!(get_job(&conn, "h1").unwrap().is_none() && get_job(&conn, "h3").unwrap().is_some());
        assert_eq!(list_assets(&conn, Some("general"), None, 10).unwrap().len(), 1); // la imagen se conserva
    }

    #[test]
    fn session_results_stay_out_of_the_library_until_saved() {
        let mut conn = mem();
        let s = create_session(&conn, "general", "create", "Creación · un lobo").unwrap();
        let params = serde_json::json!({});
        insert_job(&conn, &NewJob { id: "s1", project_id: "general", mode: "create", prompt: "un lobo", negative: "", params: &params, input_asset_id: None, person_id: None, session_id: Some(&s) }).unwrap();
        conn.execute("UPDATE jobs SET status = 'completed' WHERE id = 's1'", []).unwrap();
        let job = get_job(&conn, "s1").unwrap().unwrap();
        let ids = record_outputs(&mut conn, &job, &[serde_json::json!({"path": "/x/1.png"}), serde_json::json!({"path": "/x/2.png"})], "general").unwrap();

        assert_eq!(list_assets(&conn, Some("general"), None, 10).unwrap().len(), 0); // biblioteca vacía
        assert_eq!(query_assets(&conn, Some("general"), None, 10, true).unwrap().len(), 2);
        assert_eq!(list_projects(&conn).unwrap()[0].asset_count, 0);
        let info = list_sessions(&conn, "general", "create").unwrap();
        assert_eq!((info[0].jobs, info[0].images, info[0].unsaved), (1, 2, 2));

        set_saved(&conn, &[ids[0].clone()], true).unwrap();
        assert_eq!(list_assets(&conn, Some("general"), None, 10).unwrap().len(), 1);
        let (jobs, unsaved) = session_contents(&conn, &s).unwrap();
        assert_eq!((jobs.len(), unsaved), (1, vec![ids[1].clone()]));
    }

    #[test]
    fn kits_roundtrip() {
        let conn = mem();
        let logo = insert_original(&conn, "general", "/x/logo.png", Some(10), Some(10), "logo.png").unwrap();
        let v = serde_json::json!({"primary": "#FF0000"});
        let files = serde_json::json!([]);
        insert_kit(&conn, &NewKit { id: "k1", project_id: "general", name: "Aurora", logo_asset_id: &logo, colors: &v, palette: &files, files: &files, dir: "/x/k1" }).unwrap();
        assert_eq!(list_kits(&conn, Some("general")).unwrap().len(), 1);
        assert_eq!(get_kit(&conn, "k1").unwrap().unwrap().colors["primary"], "#FF0000");
    }
}
