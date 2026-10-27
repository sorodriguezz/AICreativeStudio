//! Orquestación de trabajos: persistencia en SQLite + envío al motor + seguimiento.

use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::db::{self, JobRecord};
use crate::persons;
use crate::error::{AppError, AppResult};
use crate::AppState;

#[derive(Deserialize, Debug)]
pub struct CreateJobInput {
    pub project_id: String,
    pub mode: String,
    pub prompt: String,
    #[serde(default)]
    pub negative_prompt: String,
    #[serde(default)]
    pub params: Value,
    #[serde(default)]
    pub input_asset_id: Option<String>,
    /// Persona registrada cuya identidad se usa (Photo Studio).
    #[serde(default)]
    pub person_id: Option<String>,
    /// Sesión de la sección: un id, "new" para abrir una nueva, o nada (lotes: resultados guardados directo).
    #[serde(default)]
    pub session_id: Option<String>,
}

fn section_label(mode: &str) -> &'static str {
    match mode {
        "create" => "Creación",
        "brand" => "Marca",
        "edit" => "Edición",
        "enhance" => "Mejora",
        "restore" => "Restauración",
        "photo" => "Photo Studio",
        _ => "Sesión",
    }
}

/// Proveedor elegido en Configuración: motor local o la CLI de una suscripción (ChatGPT, Gemini, Claude).
pub fn apply_provider(conn: &rusqlite::Connection, params: &mut Value) -> AppResult<()> {
    for (param, key) in [("provider", "provider.images"), ("prompt_provider", "provider.prompts")] {
        if params[param].is_null() {
            if let Some(v) = db::get_setting(conn, key)?.filter(|v| !v.is_empty()) {
                params[param] = json!(v);
            }
        }
    }
    Ok(())
}

/// Operaciones que no necesitan prompt.
const PROMPTLESS: [&str; 4] = ["upscale", "background_removal", "relight", "portrait_retouch"];

const TERMINAL: [&str; 4] = ["completed", "failed", "cancelled", "rejected"];

pub async fn create(app: &AppHandle, input: CreateJobInput) -> AppResult<JobRecord> {
    let state = app.state::<AppState>();
    let id = db::new_id();
    let mut params = if input.params.is_object() { input.params.clone() } else { json!({}) };
    let operation = params["operation"].as_str().unwrap_or("auto").to_string();
    let promptless = params["operation"].as_str().is_some_and(|op| PROMPTLESS.contains(&op));
    if input.prompt.trim().is_empty() && !promptless {
        return Err(AppError::Invalid("Escribe un prompt".into()));
    }
    let (output_dir, input_image, references) = {
        let conn = state.db.lock().unwrap();
        if !db::project_exists(&conn, &input.project_id)? {
            return Err(AppError::Invalid("Proyecto inexistente".into()));
        }
        // Identidad de personas reales: sólo con una persona registrada, mayor de edad y con referencias.
        let references = match input.person_id.as_deref() {
            Some(pid) => persons::authorize(&conn, pid, &operation)?,
            None if persons::needs_identity(&operation) => return Err(AppError::Invalid("Elige una persona registrada para usar su identidad.".into())),
            None => vec![],
        };
        // La pose puede venir de otra imagen del proyecto.
        if let Some(pose_asset) = params["pose_image_asset_id"].as_str().map(str::to_owned) {
            let path = db::get_asset(&conn, &pose_asset)?.ok_or_else(|| AppError::Invalid("La foto de la pose ya no existe".into()))?.path;
            params["pose_image"] = json!(path);
        }
        let input_asset = match input.input_asset_id.as_deref() {
            Some(asset_id) => Some(db::get_asset(&conn, asset_id)?.ok_or_else(|| AppError::Invalid("La imagen de entrada ya no existe".into()))?),
            None => None,
        };
        let input_image = input_asset.as_ref().map(|a| a.path.clone());
        apply_provider(&conn, &mut params)?;
        let session_id = match input.session_id.as_deref() {
            None => None,
            Some("new") => {
                // Nombre: el prompt, o lo que describe la imagen de entrada, o la sección.
                let from_input = input_asset.as_ref().and_then(|a| a.metadata["source_name"].as_str().or(a.metadata["prompt"].as_str()).map(str::to_owned));
                let name = Some(input.prompt.trim().to_owned()).filter(|p| !p.is_empty()).or(from_input.filter(|s| !s.is_empty()))
                    .map(|n| format!("{} · {n}", section_label(&input.mode)))
                    .unwrap_or_else(|| section_label(&input.mode).to_owned());
                Some(db::create_session(&conn, &input.project_id, &input.mode, &name)?)
            }
            Some(id) => Some(db::get_session(&conn, id)?.ok_or_else(|| AppError::Invalid("La sesión ya no existe".into()))?.id),
        };
        db::insert_job(&conn, &db::NewJob {
            id: &id,
            project_id: &input.project_id,
            mode: &input.mode,
            prompt: &input.prompt,
            negative: &input.negative_prompt,
            params: &params,
            input_asset_id: input.input_asset_id.as_deref(),
            person_id: input.person_id.as_deref(),
            session_id: session_id.as_deref(),
        })?;
        if let Some(pid) = input.person_id.as_deref() {
            persons::audit(&conn, Some(pid), "trabajo_con_identidad", json!({ "job_id": id, "operation": operation, "prompt": input.prompt }))?;
        }
        db::touch_project(&conn, &input.project_id)?;
        (state.paths.ensure_project(&input.project_id)?.join("results"), input_image, references)
    };

    let body = json!({
        "job_id": id,
        "mode": input.mode,
        "prompt": input.prompt,
        "negative_prompt": input.negative_prompt,
        "params": params,
        "output_dir": output_dir,
        "input_image": input_image,
        "person_id": input.person_id,
        "identity_references": references,
    });
    match state.engine.post("/jobs", &body).await {
        Ok(engine_state) => {
            let conn = state.db.lock().unwrap();
            db::apply_engine_state(&conn, &id, &engine_state)?;
        }
        Err(e) => {
            let conn = state.db.lock().unwrap();
            db::fail_job(&conn, &id, &e.to_string())?;
        }
    }

    let job = {
        let conn = state.db.lock().unwrap();
        db::get_job(&conn, &id)?.ok_or_else(|| AppError::Invalid("job perdido".into()))?
    };
    let _ = app.emit("job-update", &job);
    if !TERMINAL.contains(&job.status.as_str()) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move { track(app, id).await });
    }
    Ok(job)
}

/// Sigue el job en el motor hasta que termina, emitiendo `job-update` a la UI.
async fn track(app: AppHandle, id: String) {
    let state = app.state::<AppState>();
    let mut last_progress = -1.0;
    let mut failures = 0;
    loop {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let engine_state = match state.engine.get(&format!("/jobs/{id}")).await {
            Ok(s) => {
                failures = 0;
                s
            }
            Err(e) => {
                failures += 1;
                if failures < 10 {
                    continue;
                }
                let conn = state.db.lock().unwrap();
                let _ = db::fail_job(&conn, &id, &format!("Se perdió la conexión con el motor: {e}"));
                if let Ok(Some(job)) = db::get_job(&conn, &id) {
                    let _ = app.emit("job-update", &job);
                }
                return;
            }
        };

        let status = engine_state["status"].as_str().unwrap_or("failed").to_string();
        let progress = engine_state["progress"].as_f64().unwrap_or(0.0);
        let terminal = TERMINAL.contains(&status.as_str());
        if !terminal && progress == last_progress {
            continue;
        }
        last_progress = progress;

        let job = {
            let mut conn = state.db.lock().unwrap();
            if db::apply_engine_state(&conn, &id, &engine_state).is_err() {
                return;
            }
            let job = match db::get_job(&conn, &id) {
                Ok(Some(j)) => j,
                _ => return,
            };
            if status == "completed" {
                let outputs = engine_state["outputs"].as_array().cloned().unwrap_or_default();
                let rating = engine_state["policy"]["rating"].as_str().unwrap_or("general");
                if let Err(e) = db::record_outputs(&mut conn, &job, &outputs, rating) {
                    let _ = db::fail_job(&conn, &id, &format!("No se pudieron registrar los resultados: {e}"));
                }
            }
            db::get_job(&conn, &id).ok().flatten().unwrap_or(job)
        };
        let _ = app.emit("job-update", &job);
        if terminal {
            return;
        }
    }
}

pub async fn cancel(app: &AppHandle, id: &str) -> AppResult<()> {
    let state = app.state::<AppState>();
    state.engine.post(&format!("/jobs/{id}/cancel"), &json!({})).await?;
    Ok(())
}
