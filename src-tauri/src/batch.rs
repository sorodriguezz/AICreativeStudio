//! Producción: workflows reutilizables (cadenas de pasos) y lotes (un workflow sobre muchas imágenes).
//!
//! Un workflow es una lista de pasos:
//!   - `{"kind": "job", "mode": "...", "prompt": "...", "params": {...}}` → un trabajo del motor; su
//!     resultado es la entrada del paso siguiente.
//!   - `{"kind": "export", "targets": [...]}` → exporta la imagen actual a la carpeta del lote.
//!
//! El ejecutor procesa los elementos de uno en uno (el motor usa la GPU de a un trabajo) y
//! emite `batch-update` para la UI.

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::ExportTarget;
use crate::db::{self, new_id, Asset};
use crate::error::{AppError, AppResult};
use crate::jobs::{self, CreateJobInput};
use crate::AppState;

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Step {
    Job {
        mode: String,
        #[serde(default)]
        prompt: String,
        #[serde(default)]
        params: Value,
        /// Texto para la UI, p. ej. "Restaurar (documental)".
        #[serde(default)]
        label: String,
    },
    Export {
        targets: Vec<ExportTarget>,
        #[serde(default)]
        label: String,
    },
}

#[derive(Serialize, Debug, Clone)]
pub struct Workflow {
    pub id: String,
    pub name: String,
    pub description: String,
    pub steps: Value,
    pub builtin: bool,
    pub created_at: String,
}

/// (id, nombre, descripción, pasos)
const BUILTIN: &[(&str, &str, &str, &str)] = &[
    ("wf-restore-doc", "Restaurar foto antigua", "Modo documental: limpia rayas y polvo, reduce ruido y recupera rostros sin inventar.",
     r##"[{"kind":"job","label":"Restaurar (documental)","mode":"restore","params":{"operation":"restore","restore_mode":"documental"}}]"##),
    ("wf-restore-color", "Restaurar y colorear", "Modo creativo con coloreado y ampliación ×2.",
     r##"[{"kind":"job","label":"Restaurar y colorear","mode":"restore","params":{"operation":"restore","restore_mode":"creativo","colorize":true}},
        {"kind":"job","label":"Ampliar ×2","mode":"enhance","params":{"operation":"upscale","scale":2}}]"##),
    ("wf-clean-upscale", "Limpiar y ampliar", "Reduce ruido y amplía ×2: fotos de móvil o escaneos.",
     r##"[{"kind":"job","label":"Reducir ruido","mode":"enhance","params":{"operation":"denoise","strength":0.8}},
        {"kind":"job","label":"Ampliar ×2","mode":"enhance","params":{"operation":"upscale","scale":2}}]"##),
    ("wf-product", "Producto con fondo blanco", "Quita el fondo y exporta en cuadrado 2000 px, PNG transparente y JPG blanco.",
     r##"[{"kind":"job","label":"Quitar fondo","mode":"edit","params":{"operation":"background_removal"}},
        {"kind":"export","label":"Exportar catálogo","targets":[
          {"name":"catalogo","format":"jpg","width":2000,"height":2000,"fit":"contain","background":"#FFFFFF","padding":0.08,"quality":92},
          {"name":"transparente","format":"png","width":2000,"height":2000,"fit":"contain","background":"transparent","padding":0.08}]}]"##),
    ("wf-portrait", "Retrato editorial", "Retoque de piel y look editorial, luego ampliación ×2.",
     r##"[{"kind":"job","label":"Retoque editorial","mode":"photo","params":{"operation":"portrait_retouch","look":"editorial","skin":0.5,"vignette":0.15}},
        {"kind":"job","label":"Ampliar ×2","mode":"enhance","params":{"operation":"upscale","scale":2}}]"##),
    ("wf-social", "Pack para redes", "Exporta post 4:5, historia 9:16 y post para X en JPG.",
     r##"[{"kind":"export","label":"Exportar redes","targets":[
          {"name":"instagram-post","format":"jpg","width":1080,"height":1350,"fit":"cover","quality":90},
          {"name":"historia","format":"jpg","width":1080,"height":1920,"fit":"cover","quality":90},
          {"name":"post-x","format":"jpg","width":1600,"height":900,"fit":"cover","quality":90}]}]"##),
];

pub fn seed(conn: &Connection) -> AppResult<()> {
    for (id, name, desc, steps) in BUILTIN {
        let steps: Value = serde_json::from_str(steps).expect("workflow integrado válido");
        conn.execute(
            "INSERT INTO workflows (id, name, description, steps_json, builtin) VALUES (?1, ?2, ?3, ?4, 1)
             ON CONFLICT(id) DO UPDATE SET name = ?2, description = ?3, steps_json = ?4",
            params![id, name, desc, steps.to_string()],
        )?;
    }
    Ok(())
}

fn workflow_from_row(r: &Row) -> rusqlite::Result<Workflow> {
    Ok(Workflow {
        id: r.get("id")?,
        name: r.get("name")?,
        description: r.get("description")?,
        steps: r.get::<_, String>("steps_json").ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(json!([])),
        builtin: r.get::<_, i64>("builtin")? == 1,
        created_at: r.get("created_at")?,
    })
}

pub fn list_workflows(conn: &Connection) -> AppResult<Vec<Workflow>> {
    let mut stmt = conn.prepare("SELECT * FROM workflows ORDER BY builtin DESC, created_at, rowid")?;
    let rows = stmt.query_map([], workflow_from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get_workflow(conn: &Connection, id: &str) -> AppResult<Option<Workflow>> {
    Ok(conn.query_row("SELECT * FROM workflows WHERE id = ?1", params![id], workflow_from_row).optional()?)
}

/// Valida los pasos con el mismo tipo que usa el ejecutor.
pub fn parse_steps(steps: &Value) -> AppResult<Vec<Step>> {
    let parsed: Vec<Step> = serde_json::from_value(steps.clone()).map_err(|e| AppError::Invalid(format!("Workflow inválido: {e}")))?;
    if parsed.is_empty() {
        return Err(AppError::Invalid("El workflow necesita al menos un paso.".into()));
    }
    Ok(parsed)
}

pub fn save_workflow(conn: &Connection, id: Option<&str>, name: &str, description: &str, steps: &Value) -> AppResult<String> {
    parse_steps(steps)?;
    if name.trim().is_empty() {
        return Err(AppError::Invalid("El workflow necesita un nombre.".into()));
    }
    if let Some(id) = id {
        if get_workflow(conn, id)?.is_some_and(|w| w.builtin) {
            return Err(AppError::Invalid("Los workflows incluidos no se modifican: duplícalo primero.".into()));
        }
    }
    let id = id.map(str::to_owned).unwrap_or_else(new_id);
    conn.execute(
        "INSERT INTO workflows (id, name, description, steps_json, builtin) VALUES (?1, ?2, ?3, ?4, 0)
         ON CONFLICT(id) DO UPDATE SET name = ?2, description = ?3, steps_json = ?4, updated_at = datetime('now')",
        params![id, name.trim(), description, steps.to_string()],
    )?;
    Ok(id)
}

pub fn delete_workflow(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM workflows WHERE id = ?1 AND builtin = 0", params![id])?;
    Ok(())
}

// ---------- Lotes ----------

#[derive(Serialize, Debug, Clone)]
pub struct Batch {
    pub id: String,
    pub project_id: String,
    pub workflow_id: Option<String>,
    pub name: String,
    pub status: String, // running | completed | partial | failed | cancelled
    pub total: i64,
    pub done: i64,
    pub failed: i64,
    pub current: Option<String>,
    pub export_dir: String,
    pub created_at: String,
    pub finished_at: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
pub struct BatchItem {
    pub id: String,
    pub input: Option<Asset>,
    pub output: Option<Asset>,
    pub status: String, // pending | running | completed | failed | cancelled
    pub step: i64,
    pub error: Option<String>,
    pub exports: Value,
}

fn batch_from_row(r: &Row) -> rusqlite::Result<Batch> {
    Ok(Batch {
        id: r.get("id")?,
        project_id: r.get("project_id")?,
        workflow_id: r.get("workflow_id")?,
        name: r.get("name")?,
        status: r.get("status")?,
        total: r.get("total")?,
        done: r.get("done")?,
        failed: r.get("failed")?,
        current: r.get("current")?,
        export_dir: r.get("export_dir")?,
        created_at: r.get("created_at")?,
        finished_at: r.get("finished_at")?,
    })
}

pub fn get_batch(conn: &Connection, id: &str) -> AppResult<Option<Batch>> {
    Ok(conn.query_row("SELECT * FROM batches WHERE id = ?1", params![id], batch_from_row).optional()?)
}

pub fn list_batches(conn: &Connection, project_id: Option<&str>) -> AppResult<Vec<Batch>> {
    let mut stmt = conn.prepare("SELECT * FROM batches WHERE (?1 IS NULL OR project_id = ?1) ORDER BY created_at DESC, rowid DESC LIMIT 50")?;
    let rows = stmt.query_map(params![project_id], batch_from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn batch_items(conn: &Connection, batch_id: &str) -> AppResult<Vec<BatchItem>> {
    let mut stmt = conn.prepare("SELECT * FROM batch_items WHERE batch_id = ?1 ORDER BY rowid")?;
    let rows: Vec<(String, Option<String>, Option<String>, String, i64, Option<String>, Option<String>)> = stmt
        .query_map(params![batch_id], |r| {
            Ok((r.get("id")?, r.get("input_asset_id")?, r.get("output_asset_id")?, r.get("status")?, r.get("step")?, r.get("error")?, r.get("exports_json")?))
        })?
        .collect::<Result<_, _>>()?;
    rows.into_iter()
        .map(|(id, input, output, status, step, error, exports)| {
            Ok(BatchItem {
                id,
                input: match input { Some(a) => db::get_asset(conn, &a)?, None => None },
                output: match output { Some(a) => db::get_asset(conn, &a)?, None => None },
                status,
                step,
                error,
                exports: exports.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(json!([])),
            })
        })
        .collect()
}

pub fn create_batch(conn: &Connection, project_id: &str, workflow: &Workflow, asset_ids: &[String], export_dir: &str) -> AppResult<String> {
    if asset_ids.is_empty() {
        return Err(AppError::Invalid("Elige al menos una imagen.".into()));
    }
    let id = new_id();
    conn.execute(
        "INSERT INTO batches (id, project_id, workflow_id, name, status, total, export_dir) VALUES (?1, ?2, ?3, ?4, 'running', ?5, ?6)",
        params![id, project_id, workflow.id, workflow.name, asset_ids.len() as i64, export_dir],
    )?;
    for asset in asset_ids {
        conn.execute("INSERT INTO batch_items (id, batch_id, input_asset_id, status) VALUES (?1, ?2, ?3, 'pending')", params![new_id(), id, asset])?;
    }
    Ok(id)
}

/// Lotes interrumpidos al cerrar la app.
pub fn recover(conn: &Connection) -> AppResult<()> {
    conn.execute("UPDATE batch_items SET status = 'cancelled' WHERE status IN ('pending', 'running')", [])?;
    conn.execute("UPDATE batches SET status = 'cancelled', current = NULL, finished_at = datetime('now') WHERE status = 'running'", [])?;
    Ok(())
}

#[derive(Default)]
pub struct Cancellations(pub Mutex<HashSet<String>>);

fn emit(app: &AppHandle, batch_id: &str) {
    let state = app.state::<AppState>();
    let conn = state.db.lock().unwrap();
    if let Ok(Some(b)) = get_batch(&conn, batch_id) {
        let _ = app.emit("batch-update", b);
    }
}

async fn wait_job(app: &AppHandle, job_id: &str, batch_id: &str) -> AppResult<db::JobRecord> {
    let state = app.state::<AppState>();
    loop {
        tokio::time::sleep(Duration::from_millis(600)).await;
        let job = db::get_job(&state.db.lock().unwrap(), job_id)?.ok_or_else(|| AppError::Invalid("El trabajo desapareció".into()))?;
        if matches!(job.status.as_str(), "completed" | "failed" | "cancelled" | "rejected") {
            return Ok(job);
        }
        if state.cancellations.0.lock().unwrap().contains(batch_id) {
            let _ = jobs::cancel(app, job_id).await;
        }
    }
}

/// Ejecuta el lote completo: elementos en orden, pasos en cadena.
pub async fn run(app: AppHandle, batch_id: String) {
    let state = app.state::<AppState>();
    let (batch, steps, items) = {
        let conn = state.db.lock().unwrap();
        let Ok(Some(batch)) = get_batch(&conn, &batch_id) else { return };
        let steps = batch
            .workflow_id
            .as_deref()
            .and_then(|w| get_workflow(&conn, w).ok().flatten())
            .and_then(|w| parse_steps(&w.steps).ok())
            .unwrap_or_default();
        let items: Vec<(String, String)> = conn
            .prepare("SELECT id, input_asset_id FROM batch_items WHERE batch_id = ?1 ORDER BY rowid")
            .and_then(|mut s| s.query_map(params![batch_id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect())
            .unwrap_or_default();
        (batch, steps, items)
    };

    for (item_id, input_id) in items {
        if state.cancellations.0.lock().unwrap().contains(&batch_id) {
            break;
        }
        {
            let conn = state.db.lock().unwrap();
            let _ = conn.execute("UPDATE batch_items SET status = 'running' WHERE id = ?1", params![item_id]);
            let _ = conn.execute("UPDATE batches SET current = ?2 WHERE id = ?1", params![batch_id, input_id]);
        }
        emit(&app, &batch_id);
        let result = run_item(&app, &batch, &steps, &item_id, &input_id).await;
        {
            let conn = state.db.lock().unwrap();
            match &result {
                Ok(output) => {
                    let _ = conn.execute("UPDATE batch_items SET status = 'completed', output_asset_id = ?2 WHERE id = ?1", params![item_id, output]);
                    let _ = conn.execute("UPDATE batches SET done = done + 1 WHERE id = ?1", params![batch_id]);
                }
                Err(e) => {
                    let cancelled = state.cancellations.0.lock().unwrap().contains(&batch_id);
                    let status = if cancelled { "cancelled" } else { "failed" };
                    let _ = conn.execute("UPDATE batch_items SET status = ?2, error = ?3 WHERE id = ?1", params![item_id, status, e.to_string()]);
                    if !cancelled {
                        let _ = conn.execute("UPDATE batches SET failed = failed + 1 WHERE id = ?1", params![batch_id]);
                    }
                }
            }
        }
        emit(&app, &batch_id);
    }

    let cancelled = state.cancellations.0.lock().unwrap().remove(&batch_id);
    {
        let conn = state.db.lock().unwrap();
        let _ = conn.execute("UPDATE batch_items SET status = 'cancelled' WHERE batch_id = ?1 AND status IN ('pending', 'running')", params![batch_id]);
        let _ = conn.execute(
            "UPDATE batches SET current = NULL, finished_at = datetime('now'),
               status = CASE WHEN ?2 THEN 'cancelled' WHEN failed = 0 THEN 'completed' WHEN done = 0 THEN 'failed' ELSE 'partial' END
             WHERE id = ?1",
            params![batch_id, cancelled],
        );
    }
    emit(&app, &batch_id);
}

async fn run_item(app: &AppHandle, batch: &Batch, steps: &[Step], item_id: &str, input_id: &str) -> AppResult<Option<String>> {
    let state = app.state::<AppState>();
    let mut current = input_id.to_string();
    for (n, step) in steps.iter().enumerate() {
        {
            let conn = state.db.lock().unwrap();
            conn.execute("UPDATE batch_items SET step = ?2 WHERE id = ?1", params![item_id, n as i64])?;
        }
        match step {
            Step::Job { mode, prompt, params, .. } => {
                let job = jobs::create(app, CreateJobInput {
                    project_id: batch.project_id.clone(),
                    mode: mode.clone(),
                    prompt: prompt.clone(),
                    negative_prompt: String::new(),
                    params: params.clone(),
                    input_asset_id: Some(current.clone()),
                    person_id: None,
                    session_id: None,
                })
                .await?;
                let job = if matches!(job.status.as_str(), "failed" | "rejected" | "cancelled") { job } else { wait_job(app, &job.id, &batch.id).await? };
                if job.status != "completed" {
                    return Err(AppError::Invalid(job.error.unwrap_or_else(|| format!("El paso {} no terminó", n + 1))));
                }
                current = job.output_asset_id.ok_or_else(|| AppError::Invalid("El paso no produjo imagen".into()))?;
            }
            Step::Export { targets, .. } => {
                let asset = db::get_asset(&state.db.lock().unwrap(), &current)?.ok_or_else(|| AppError::Invalid("Imagen perdida".into()))?;
                let dir = std::path::PathBuf::from(&batch.export_dir);
                let targets = targets.clone();
                let result = tauri::async_runtime::spawn_blocking(move || crate::commands::export_to(&asset, targets, dir, true))
                    .await
                    .map_err(|e| AppError::Invalid(e.to_string()))??;
                let conn = state.db.lock().unwrap();
                conn.execute(
                    "UPDATE batch_items SET exports_json = json_insert(COALESCE(exports_json, '[]'), '$[#]', json(?2)) WHERE id = ?1",
                    params![item_id, json!(result.files).to_string()],
                )?;
            }
        }
    }
    Ok(Some(current))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_workflows_parse() {
        for (_, _, _, steps) in BUILTIN {
            parse_steps(&serde_json::from_str(steps).unwrap()).unwrap();
        }
        assert!(parse_steps(&json!([])).is_err());
        assert!(parse_steps(&json!([{"kind": "nope"}])).is_err());
    }

    #[test]
    fn workflows_and_batches_roundtrip() {
        let path = std::env::temp_dir().join(format!("aics-batch-{}-{}.db", std::process::id(), new_id()));
        let conn = db::open(&path).unwrap();
        assert!(list_workflows(&conn).unwrap().len() >= BUILTIN.len());
        assert!(save_workflow(&conn, Some("wf-social"), "x", "", &json!([{"kind": "export", "targets": []}])).is_err());
        let steps = json!([{"kind": "job", "mode": "enhance", "params": {"operation": "upscale", "scale": 2}}]);
        let id = save_workflow(&conn, None, "Mío", "", &steps).unwrap();
        let wf = get_workflow(&conn, &id).unwrap().unwrap();
        let a = db::insert_original(&conn, "general", "/x/a.png", Some(1), Some(1), "a.png").unwrap();
        let b = create_batch(&conn, "general", &wf, &[a], "/x/out").unwrap();
        assert_eq!(batch_items(&conn, &b).unwrap().len(), 1);
        recover(&conn).unwrap();
        assert_eq!(get_batch(&conn, &b).unwrap().unwrap().status, "cancelled");
        delete_workflow(&conn, &id).unwrap();
        assert!(get_workflow(&conn, &id).unwrap().is_none());
    }
}
