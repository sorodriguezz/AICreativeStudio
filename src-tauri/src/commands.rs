//! Comandos expuestos a la UI (invoke). Toda la comunicación UI → motor pasa por aquí.

use std::path::Path;

use base64::Engine as _;
use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::brand;
use crate::db::{self, Asset, BrandKit, JobRecord, Preset, Project};
use crate::imaging::{self, Fit, Format, VectorStyle};
use crate::engine::EngineStatus;
use crate::error::{AppError, AppResult};
use crate::jobs::{self, CreateJobInput};
use crate::AppState;

// ---------- Motor ----------

#[tauri::command]
pub fn engine_status(state: State<'_, AppState>) -> EngineStatus {
    state.engine.status()
}

#[tauri::command]
pub async fn restart_engine(app: AppHandle, state: State<'_, AppState>) -> AppResult<EngineStatus> {
    state.engine.start(&app, &state.paths).await;
    Ok(state.engine.status())
}

/// Estado de las CLIs de suscripción (instalada, sesión iniciada, qué puede hacer).
#[tauri::command]
pub async fn providers_status(state: State<'_, AppState>, refresh: Option<bool>) -> AppResult<Value> {
    state.engine.get(if refresh.unwrap_or(false) { "/providers?refresh=true" } else { "/providers" }).await
}

/// Detiene el motor para que el instalador de la actualización pueda reemplazar sus archivos.
#[tauri::command]
pub fn stop_engine(state: State<'_, AppState>) {
    state.engine.stop();
}

/// Hay trabajos en cola o en curso (instalar una actualización los interrumpiría).
#[tauri::command]
pub fn jobs_running(state: State<'_, AppState>) -> AppResult<bool> {
    db::active_jobs(&state.db.lock().unwrap())
}

#[tauri::command]
pub async fn hardware_info(state: State<'_, AppState>) -> AppResult<Value> {
    state.engine.get("/hardware").await
}

#[tauri::command]
pub async fn list_models(state: State<'_, AppState>) -> AppResult<Value> {
    state.engine.get("/models").await
}

/// Paquetes de modelos recomendados para el hardware de este equipo.
#[tauri::command]
pub async fn model_packs(state: State<'_, AppState>) -> AppResult<Value> {
    state.engine.get("/models/packs").await
}

/// Encola descargas (de a una, verificando espacio en disco).
#[tauri::command]
pub async fn queue_models(state: State<'_, AppState>, ids: Vec<String>) -> AppResult<Value> {
    state.engine.post("/models/queue", &json!({ "ids": ids })).await
}

#[tauri::command]
pub async fn delete_model(state: State<'_, AppState>, model_id: String) -> AppResult<Value> {
    state.engine.delete(&format!("/models/{model_id}")).await
}

#[tauri::command]
pub async fn download_model(state: State<'_, AppState>, model_id: String) -> AppResult<Value> {
    state.engine.post(&format!("/models/{model_id}/download"), &json!({})).await
}

#[tauri::command]
pub async fn analyze_prompt(state: State<'_, AppState>, prompt: String, mode: String, params: Option<Value>, input_asset_id: Option<String>) -> AppResult<Value> {
    let mut params = params.filter(Value::is_object).unwrap_or(json!({}));
    let input_image = {
        let conn = state.db.lock().unwrap();
        jobs::apply_provider(&conn, &mut params)?;
        match input_asset_id {
            Some(id) => db::get_asset(&conn, &id)?.map(|a| a.path),
            None => None,
        }
    };
    state
        .engine
        .post("/analyze", &json!({ "prompt": prompt, "mode": mode, "params": params, "input_image": input_image }))
        .await
}

// ---------- Proyectos ----------

#[tauri::command]
pub fn list_projects(state: State<'_, AppState>) -> AppResult<Vec<Project>> {
    db::list_projects(&state.db.lock().unwrap())
}

#[tauri::command]
pub fn create_project(state: State<'_, AppState>, name: String, kind: Option<String>) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Invalid("El proyecto necesita un nombre".into()));
    }
    let id = db::create_project(&state.db.lock().unwrap(), name, kind.as_deref().unwrap_or("general"))?;
    state.paths.ensure_project(&id)?;
    Ok(id)
}

#[tauri::command]
pub fn rename_project(state: State<'_, AppState>, id: String, name: String) -> AppResult<()> {
    db::rename_project(&state.db.lock().unwrap(), &id, name.trim())
}

/// Borra el proyecto, sus imágenes y su carpeta. Devuelve los ids de las imágenes eliminadas.
#[tauri::command]
pub fn delete_project(state: State<'_, AppState>, id: String) -> AppResult<Vec<String>> {
    let mut conn = state.db.lock().unwrap();
    let deleted = db::delete_project(&mut conn, &id)?;
    for asset in &deleted {
        let path = Path::new(&asset.path);
        if path.starts_with(&state.paths.root) && !db::path_in_use(&conn, &asset.path)? {
            let _ = std::fs::remove_file(path);
        }
    }
    let _ = std::fs::remove_dir_all(state.paths.project(&id));
    Ok(deleted.into_iter().map(|a| a.id).collect())
}

#[tauri::command]
pub fn set_project_cover(state: State<'_, AppState>, project_id: String, asset_id: Option<String>) -> AppResult<()> {
    db::set_project_cover(&state.db.lock().unwrap(), &project_id, asset_id.as_deref())
}

// ---------- Presets ----------

#[tauri::command]
pub fn list_presets(state: State<'_, AppState>, category: Option<String>) -> AppResult<Vec<Preset>> {
    db::list_presets(&state.db.lock().unwrap(), category.as_deref())
}

// ---------- Jobs y assets ----------

#[tauri::command]
pub async fn create_job(app: AppHandle, input: CreateJobInput) -> AppResult<JobRecord> {
    jobs::create(&app, input).await
}

#[tauri::command]
pub async fn cancel_job(app: AppHandle, id: String) -> AppResult<()> {
    jobs::cancel(&app, &id).await
}

#[tauri::command]
pub fn get_job(state: State<'_, AppState>, id: String) -> AppResult<Option<JobRecord>> {
    db::get_job(&state.db.lock().unwrap(), &id)
}

#[tauri::command]
pub fn list_jobs(state: State<'_, AppState>, project_id: Option<String>, limit: Option<i64>) -> AppResult<Vec<JobRecord>> {
    db::list_jobs(&state.db.lock().unwrap(), project_id.as_deref(), limit.unwrap_or(100))
}

#[tauri::command]
pub fn list_assets(state: State<'_, AppState>, project_id: Option<String>, job_id: Option<String>, limit: Option<i64>, all: Option<bool>) -> AppResult<Vec<Asset>> {
    let all = all.unwrap_or(false) || job_id.is_some();
    db::query_assets(&state.db.lock().unwrap(), project_id.as_deref(), job_id.as_deref(), limit.unwrap_or(200), all)
}

#[tauri::command]
pub fn get_asset(state: State<'_, AppState>, id: String) -> AppResult<Option<Asset>> {
    db::get_asset(&state.db.lock().unwrap(), &id)
}

#[tauri::command]
pub fn asset_children(state: State<'_, AppState>, id: String) -> AppResult<Vec<Asset>> {
    db::asset_children(&state.db.lock().unwrap(), &id)
}

/// Cuántas ediciones derivadas se irían junto con `ids` (para avisar antes de eliminar).
#[tauri::command]
pub fn deletion_preview(state: State<'_, AppState>, ids: Vec<String>) -> AppResult<Value> {
    let conn = state.db.lock().unwrap();
    let all = db::deletion_set(&conn, &ids, true)?;
    Ok(json!({ "versions": all.iter().filter(|id| !ids.contains(id)).count() }))
}

/// Elimina imágenes del proyecto: el registro y su archivo (sólo si está dentro de la carpeta de datos
/// de la app; los archivos del usuario fuera de ella nunca se tocan).
#[tauri::command]
pub fn delete_assets(state: State<'_, AppState>, ids: Vec<String>, with_versions: Option<bool>) -> AppResult<Vec<String>> {
    remove_assets(&state, &ids, with_versions.unwrap_or(false))
}

fn remove_assets(state: &AppState, ids: &[String], with_versions: bool) -> AppResult<Vec<String>> {
    let mut conn = state.db.lock().unwrap();
    let deleted = db::delete_assets(&mut conn, ids, with_versions)?;
    for asset in &deleted {
        let path = Path::new(&asset.path);
        if path.starts_with(&state.paths.root) && !db::path_in_use(&conn, &asset.path)? {
            let _ = std::fs::remove_file(path);
        }
    }
    Ok(deleted.into_iter().map(|a| a.id).collect())
}

// ---------- Sesiones ----------

#[tauri::command]
pub fn list_sessions(state: State<'_, AppState>, project_id: String, section: String) -> AppResult<Vec<db::Session>> {
    db::list_sessions(&state.db.lock().unwrap(), &project_id, &section)
}

#[tauri::command]
pub fn rename_session(state: State<'_, AppState>, id: String, name: String) -> AppResult<()> {
    db::rename_session(&state.db.lock().unwrap(), &id, &name)
}

/// Borra la sesión, sus trabajos y las imágenes que no se agregaron a la biblioteca.
/// Las guardadas se quedan en la biblioteca. Devuelve los ids de las imágenes eliminadas.
#[tauri::command]
pub fn delete_session(state: State<'_, AppState>, id: String) -> AppResult<Vec<String>> {
    let (jobs, unsaved) = db::session_contents(&state.db.lock().unwrap(), &id)?;
    let removed = remove_assets(&state, &unsaved, false)?;
    let mut conn = state.db.lock().unwrap();
    db::delete_jobs(&mut conn, &jobs)?;
    db::delete_session_row(&conn, &id)?;
    Ok(removed)
}

/// Agrega imágenes a la biblioteca (o las quita, sin borrarlas: vuelven a ser sólo de su sesión).
#[tauri::command]
pub fn set_assets_saved(state: State<'_, AppState>, ids: Vec<String>, saved: bool) -> AppResult<()> {
    db::set_saved(&state.db.lock().unwrap(), &ids, saved)
}

#[derive(serde::Serialize)]
pub struct HistoryCleared {
    pub jobs: usize,
    pub assets: Vec<String>,
}

/// Borra entradas del historial: las indicadas, o todas las terminadas (de un proyecto o de todos).
/// Con `with_images`, también sus imágenes; si no, quedan en la biblioteca.
#[tauri::command]
pub fn delete_history(state: State<'_, AppState>, ids: Option<Vec<String>>, project_id: Option<String>, with_images: bool) -> AppResult<HistoryCleared> {
    let ids = match ids {
        Some(ids) => ids,
        None => db::finished_job_ids(&state.db.lock().unwrap(), project_id.as_deref())?,
    };
    let assets = if with_images {
        let asset_ids = db::assets_of_jobs(&state.db.lock().unwrap(), &ids)?;
        remove_assets(&state, &asset_ids, false)?
    } else {
        vec![]
    };
    let jobs = db::delete_jobs(&mut state.db.lock().unwrap(), &ids)?;
    Ok(HistoryCleared { jobs, assets })
}

const IMPORTABLE: [&str; 7] = ["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff"];

/// Copia una imagen del usuario al proyecto (originals/) y la registra como asset original.
#[tauri::command]
pub fn import_image(state: State<'_, AppState>, project_id: String, path: String) -> AppResult<Asset> {
    let src = Path::new(&path);
    let ext = src.extension().and_then(|e| e.to_str()).map(str::to_lowercase).unwrap_or_default();
    if !IMPORTABLE.contains(&ext.as_str()) {
        return Err(AppError::Invalid(format!("Formato no soportado ({ext}). Usa PNG, JPG, WebP, BMP o TIFF.")));
    }
    if !src.is_file() {
        return Err(AppError::Invalid("No se encontró el archivo".into()));
    }
    let conn = state.db.lock().unwrap();
    if !db::project_exists(&conn, &project_id)? {
        return Err(AppError::Invalid("Proyecto inexistente".into()));
    }
    let dest = state.paths.ensure_project(&project_id)?.join("originals").join(format!("{}.{ext}", db::new_id()));
    std::fs::copy(src, &dest)?;
    let (w, h) = imagesize::size(&dest).map(|s| (Some(s.width as i64), Some(s.height as i64))).unwrap_or((None, None));
    let name = src.file_name().and_then(|n| n.to_str()).unwrap_or("imagen");
    let id = db::insert_original(&conn, &project_id, &dest.to_string_lossy(), w, h, name)?;
    db::get_asset(&conn, &id)?.ok_or_else(|| AppError::Invalid("No se pudo registrar la imagen".into()))
}

/// Guarda una máscara pintada en la UI (data URL PNG) y devuelve su ruta para el motor.
#[tauri::command]
pub fn save_mask(state: State<'_, AppState>, project_id: String, data_url: String) -> AppResult<String> {
    let encoded = data_url.strip_prefix("data:image/png;base64,").ok_or_else(|| AppError::Invalid("Máscara inválida".into()))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| AppError::Invalid(format!("Máscara inválida: {e}")))?;
    let dest = state.paths.ensure_project(&project_id)?.join("previews").join(format!("mask_{}.png", db::new_id()));
    std::fs::write(&dest, bytes)?;
    Ok(dest.to_string_lossy().into_owned())
}

// ---------- Reiluminación ----------

/// Imagen y normales a tamaño de vista previa (data URLs) para iluminar en vivo en la UI.
#[tauri::command]
pub async fn relight_prepare(state: State<'_, AppState>, asset_id: String, max_side: Option<u32>) -> AppResult<Value> {
    let path = asset_path(&state, &asset_id)?;
    state.engine.post("/relight/prepare", &json!({ "image": path, "max_side": max_side.unwrap_or(768) })).await
}

fn asset_path(state: &AppState, asset_id: &str) -> AppResult<String> {
    db::get_asset(&state.db.lock().unwrap(), asset_id)?
        .map(|a| a.path)
        .ok_or_else(|| AppError::Invalid("La imagen ya no existe".into()))
}

fn require_asset(state: &AppState, asset_id: &str) -> AppResult<Asset> {
    db::get_asset(&state.db.lock().unwrap(), asset_id)?.ok_or_else(|| AppError::Invalid("La imagen ya no existe".into()))
}

/// Trabajo pesado de imagen fuera del hilo principal.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| AppError::Invalid(e.to_string()))?
}

// ---------- Exportar ----------

#[derive(serde::Deserialize, serde::Serialize, Debug, Clone)]
pub struct ExportTarget {
    /// Sufijo del archivo, p. ej. "instagram-post".
    pub name: String,
    pub format: Format,
    pub width: Option<u32>,
    pub height: Option<u32>,
    #[serde(default)]
    pub fit: Option<Fit>,
    /// "transparent" o color hex.
    #[serde(default)]
    pub background: Option<String>,
    #[serde(default)]
    pub padding: Option<f32>,
    #[serde(default)]
    pub quality: Option<u8>,
}

#[derive(serde::Serialize)]
pub struct ExportResult {
    pub dir: String,
    pub files: Vec<String>,
}

fn base_name(asset: &Asset) -> String {
    let source = asset.metadata["prompt"].as_str().filter(|s| !s.is_empty()).or(asset.metadata["source_name"].as_str()).unwrap_or("imagen");
    let s = brand::slug(source.rsplit_once('.').map(|(a, _)| a).filter(|_| asset.kind == "original").unwrap_or(source));
    s.split('-').take(6).collect::<Vec<_>>().join("-")
}

/// Exporta un asset a varios formatos y tamaños de una vez.
#[tauri::command]
pub async fn export_asset(state: State<'_, AppState>, asset_id: String, targets: Vec<ExportTarget>, dest_dir: Option<String>) -> AppResult<ExportResult> {
    if targets.is_empty() {
        return Err(AppError::Invalid("Elige al menos un formato".into()));
    }
    let asset = require_asset(&state, &asset_id)?;
    let dir = match dest_dir {
        Some(d) => std::path::PathBuf::from(d),
        None => state.paths.ensure_project(&asset.project_id)?.join("exports").join(format!("{}-{}", base_name(&asset), &db::new_id()[..6])),
    };
    blocking(move || export_to(&asset, targets, dir, false)).await
}

/// Genera los archivos de exportación en `dir`. Con `unique`, el nombre lleva un sufijo del asset
/// (lotes: varias imágenes con el mismo prompt en la misma carpeta).
pub fn export_to(asset: &Asset, targets: Vec<ExportTarget>, dir: std::path::PathBuf, unique: bool) -> AppResult<ExportResult> {
    let base = if unique { format!("{}-{}", base_name(asset), &asset.id[..6]) } else { base_name(asset) };
    std::fs::create_dir_all(&dir)?;
    let img = imaging::load(std::path::Path::new(&asset.path))?;
    let mut files = Vec::new();
    for t in targets {
        let background = t.background.as_deref().filter(|b| *b != "transparent").and_then(imaging::parse_hex);
        let out = match (t.width, t.height) {
            (Some(w), Some(h)) if t.format != Format::Ico => imaging::fit(&img, w, h, t.fit.unwrap_or(Fit::Cover), background, t.padding.unwrap_or(0.0)),
            _ => match background {
                Some(bg) => imaging::fit(&img, img.width(), img.height(), Fit::Contain, Some(bg), 0.0),
                None => img.clone(),
            },
        };
        let mut path = dir.join(format!("{base}-{}.{}", brand::slug(&t.name), t.format.ext()));
        let mut n = 2;
        while path.exists() {
            path = dir.join(format!("{base}-{}-{n}.{}", brand::slug(&t.name), t.format.ext()));
            n += 1;
        }
        match t.format {
            Format::Svg => {
                let style = if imaging::has_transparency(&out) { VectorStyle::Logo } else { VectorStyle::Detailed };
                std::fs::write(&path, imaging::vectorize(&out, style)?)?;
            }
            f => imaging::save(&out, &path, f, t.quality.unwrap_or(92), background)?,
        }
        files.push(path.to_string_lossy().into_owned());
    }
    Ok(ExportResult { dir: dir.to_string_lossy().into_owned(), files })
}

/// Convierte un asset a SVG y lo guarda como versión nueva.
#[tauri::command]
pub async fn vectorize_asset(state: State<'_, AppState>, asset_id: String, style: Option<VectorStyle>) -> AppResult<Asset> {
    let asset = require_asset(&state, &asset_id)?;
    let dest = state.paths.ensure_project(&asset.project_id)?.join("results").join(format!("{}.svg", db::new_id()));
    let src = asset.path.clone();
    let dest_for_job = dest.clone();
    blocking(move || {
        let img = imaging::load(std::path::Path::new(&src))?;
        let style = style.unwrap_or(if imaging::has_transparency(&img) { VectorStyle::Logo } else { VectorStyle::Detailed });
        std::fs::write(&dest_for_job, imaging::vectorize(&img, style)?)?;
        Ok(())
    })
    .await?;
    let conn = state.db.lock().unwrap();
    let id = db::insert_derived(&conn, &asset, &dest.to_string_lossy(), "vectorize")?;
    db::get_asset(&conn, &id)?.ok_or_else(|| AppError::Invalid("No se pudo registrar el SVG".into()))
}

// ---------- Kits de marca ----------

#[derive(serde::Serialize)]
pub struct KitView {
    #[serde(flatten)]
    pub kit: BrandKit,
    pub logo: Option<Asset>,
}

fn kit_view(conn: &rusqlite::Connection, kit: BrandKit) -> AppResult<KitView> {
    let logo = match &kit.logo_asset_id {
        Some(id) => db::get_asset(conn, id)?,
        None => None,
    };
    Ok(KitView { kit, logo })
}

/// Crea un kit desde un logo con fondo transparente. Si no lo tiene, responde `needs_transparency`
/// para que la UI ofrezca quitar el fondo primero.
#[tauri::command]
pub async fn create_brand_kit(state: State<'_, AppState>, asset_id: String, name: String) -> AppResult<KitView> {
    let name = if name.trim().is_empty() { "Mi marca".to_string() } else { name.trim().to_string() };
    let asset = require_asset(&state, &asset_id)?;
    let kit_id = db::new_id();
    let dir = state.paths.ensure_project(&asset.project_id)?.join("exports").join("kits").join(&kit_id);
    let (src, dir_job, name_job) = (asset.path.clone(), dir.clone(), name.clone());
    let (palette, colors, files) = blocking(move || {
        let img = imaging::load(std::path::Path::new(&src))?;
        if !imaging::has_transparency(&img) {
            return Err(AppError::Invalid("needs_transparency".into()));
        }
        brand::build_kit(&img, &name_job, &dir_job)
    })
    .await?;
    let conn = state.db.lock().unwrap();
    db::insert_kit(&conn, &db::NewKit {
        id: &kit_id,
        project_id: &asset.project_id,
        name: &name,
        logo_asset_id: &asset.id,
        colors: &json!(colors),
        palette: &json!(palette),
        files: &json!(files),
        dir: &dir.to_string_lossy(),
    })?;
    let kit = db::get_kit(&conn, &kit_id)?.ok_or_else(|| AppError::Invalid("No se pudo registrar el kit".into()))?;
    kit_view(&conn, kit)
}

#[tauri::command]
pub fn list_brand_kits(state: State<'_, AppState>, project_id: Option<String>) -> AppResult<Vec<KitView>> {
    let conn = state.db.lock().unwrap();
    db::list_kits(&conn, project_id.as_deref())?.into_iter().map(|k| kit_view(&conn, k)).collect()
}

/// Copia la carpeta completa del kit a donde elija el usuario.
#[tauri::command]
pub async fn export_brand_kit(state: State<'_, AppState>, kit_id: String, dest_dir: String) -> AppResult<String> {
    let kit = db::get_kit(&state.db.lock().unwrap(), &kit_id)?.ok_or_else(|| AppError::Invalid("El kit ya no existe".into()))?;
    blocking(move || Ok(brand::copy_kit(std::path::Path::new(&kit.dir), std::path::Path::new(&dest_dir), &kit.name)?.to_string_lossy().into_owned())).await
}

// ---------- Photo Studio: personas ----------

use crate::persons::{self, AuditEntry, Person, Reference};

#[derive(serde::Serialize)]
pub struct PersonDetail {
    pub person: Person,
    pub references: Vec<Reference>,
    pub audit: Vec<AuditEntry>,
    pub generated: Vec<Asset>,
}

#[tauri::command]
pub fn list_persons(state: State<'_, AppState>) -> AppResult<Vec<Person>> {
    persons::list(&state.db.lock().unwrap())
}

#[tauri::command]
pub fn person_detail(state: State<'_, AppState>, id: String) -> AppResult<PersonDetail> {
    let conn = state.db.lock().unwrap();
    Ok(PersonDetail {
        person: persons::get(&conn, &id)?.ok_or_else(|| AppError::Invalid("La persona ya no existe".into()))?,
        references: persons::references(&conn, &id)?,
        audit: persons::audit_log(&conn, &id, 50)?,
        generated: db::assets_of_person(&conn, &id, 60)?,
    })
}

#[tauri::command]
pub fn create_person(state: State<'_, AppState>, name: String, notes: Option<String>, is_adult: bool) -> AppResult<String> {
    persons::create(&state.db.lock().unwrap(), &name, notes.as_deref(), is_adult)
}

#[tauri::command]
pub fn update_person(state: State<'_, AppState>, id: String, name: String, notes: Option<String>, is_adult: Option<bool>) -> AppResult<()> {
    persons::update(&state.db.lock().unwrap(), &id, &name, notes.as_deref(), is_adult)
}

/// Elimina la persona y sus fotos de referencia (los archivos incluidos).
#[tauri::command]
pub fn delete_person(state: State<'_, AppState>, id: String) -> AppResult<()> {
    persons::delete(&state.db.lock().unwrap(), &id)?;
    let _ = std::fs::remove_dir_all(state.paths.root.join("persons").join(&id));
    Ok(())
}

/// Agrega una foto de referencia: debe tener exactamente un rostro y parecerse a las demás.
#[tauri::command]
pub async fn add_person_reference(state: State<'_, AppState>, person_id: String, path: String) -> AppResult<Reference> {
    let src = std::path::Path::new(&path);
    let ext = src.extension().and_then(|e| e.to_str()).map(str::to_lowercase).unwrap_or_default();
    if !IMPORTABLE.contains(&ext.as_str()) {
        return Err(AppError::Invalid(format!("Formato no soportado ({ext}).")));
    }
    let analysis = state.engine.post("/faces/analyze", &json!({ "image": path })).await?;
    let faces = analysis["faces"].as_array().cloned().unwrap_or_default();
    match faces.len() {
        0 => return Err(AppError::Invalid("No se detectó ningún rostro en la foto.".into())),
        1 => {}
        n => return Err(AppError::Invalid(format!("La foto tiene {n} rostros. Usa una foto donde aparezca sólo esta persona."))),
    }
    let face_w = faces[0]["box"][2].as_f64().unwrap_or(0.0);
    if face_w < 64.0 {
        return Err(AppError::Invalid("El rostro es muy pequeño. Usa una foto más cercana (al menos 64 px de ancho de cara).".into()));
    }
    let embedding: Vec<f32> = serde_json::from_value(analysis["embedding"].clone()).map_err(|_| AppError::Invalid("No se pudo leer el rostro".into()))?;

    let conn = state.db.lock().unwrap();
    persons::get(&conn, &person_id)?.ok_or_else(|| AppError::Invalid("La persona ya no existe".into()))?;
    let existing = persons::embeddings(&conn, &person_id)?;
    if !existing.is_empty() {
        let best = existing.iter().map(|e| persons::cosine(e, &embedding)).fold(f32::MIN, f32::max);
        if best < persons::SAME_PERSON {
            return Err(AppError::Invalid(format!(
                "Esta foto no parece ser de la misma persona que las otras referencias (similitud {best:.2}; mínimo {:.2}).",
                persons::SAME_PERSON
            )));
        }
    }
    let dir = state.paths.root.join("persons").join(&person_id).join("referencias");
    std::fs::create_dir_all(&dir)?;
    let dest = dir.join(format!("{}.{ext}", db::new_id()));
    std::fs::copy(src, &dest)?;
    let dest_s = dest.to_string_lossy().into_owned();
    let id = persons::add_reference(&conn, &persons::NewReference {
        person_id: &person_id,
        path: &dest_s,
        width: analysis["width"].as_i64(),
        height: analysis["height"].as_i64(),
        embedding: &embedding,
        face: &faces[0],
    })?;
    persons::references(&conn, &person_id)?
        .into_iter()
        .find(|r| r.id == id)
        .ok_or_else(|| AppError::Invalid("No se pudo registrar la referencia".into()))
}

#[tauri::command]
pub fn remove_person_reference(state: State<'_, AppState>, id: String) -> AppResult<()> {
    if let Some(path) = persons::remove_reference(&state.db.lock().unwrap(), &id)? {
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}

/// Pose (formato OpenPose normalizado) de la persona principal de una imagen del proyecto.
#[tauri::command]
pub async fn pose_estimate(state: State<'_, AppState>, asset_id: String) -> AppResult<Value> {
    let path = asset_path(&state, &asset_id)?;
    state.engine.post("/pose/estimate", &json!({ "image": path })).await
}

// ---------- Restauración ----------

/// Daños detectados (máscara PNG) para revisarlos antes de restaurar.
#[tauri::command]
pub async fn restore_detect(state: State<'_, AppState>, asset_id: String, sensitivity: Option<f32>) -> AppResult<Value> {
    let path = asset_path(&state, &asset_id)?;
    state.engine.post("/restore/detect", &json!({ "image": path, "sensitivity": sensitivity.unwrap_or(0.35) })).await
}

// ---------- Producción: workflows y lotes ----------

use crate::batch::{self, Batch, BatchItem, Workflow};

#[tauri::command]
pub fn list_workflows(state: State<'_, AppState>) -> AppResult<Vec<Workflow>> {
    batch::list_workflows(&state.db.lock().unwrap())
}

#[tauri::command]
pub fn save_workflow(state: State<'_, AppState>, id: Option<String>, name: String, description: Option<String>, steps: Value) -> AppResult<String> {
    batch::save_workflow(&state.db.lock().unwrap(), id.as_deref(), &name, description.as_deref().unwrap_or(""), &steps)
}

#[tauri::command]
pub fn delete_workflow(state: State<'_, AppState>, id: String) -> AppResult<()> {
    batch::delete_workflow(&state.db.lock().unwrap(), &id)
}

/// Aplica un workflow a varias imágenes. Corre en segundo plano y emite `batch-update`.
#[tauri::command]
pub fn start_batch(app: AppHandle, state: State<'_, AppState>, project_id: String, workflow_id: String, asset_ids: Vec<String>, export_dir: Option<String>) -> AppResult<String> {
    let conn = state.db.lock().unwrap();
    let wf = batch::get_workflow(&conn, &workflow_id)?.ok_or_else(|| AppError::Invalid("El workflow ya no existe".into()))?;
    batch::parse_steps(&wf.steps)?;
    let dir = match export_dir.filter(|d| !d.is_empty()) {
        Some(d) => std::path::PathBuf::from(d),
        None => state.paths.ensure_project(&project_id)?.join("exports").join(format!("lote-{}-{}", brand::slug(&wf.name), &db::new_id()[..6])),
    };
    let id = batch::create_batch(&conn, &project_id, &wf, &asset_ids, &dir.to_string_lossy())?;
    let (app2, id2) = (app.clone(), id.clone());
    tauri::async_runtime::spawn(async move { batch::run(app2, id2).await });
    Ok(id)
}

#[derive(serde::Serialize)]
pub struct BatchDetail {
    pub batch: Batch,
    pub items: Vec<BatchItem>,
    pub workflow: Option<Workflow>,
}

#[tauri::command]
pub fn list_batches(state: State<'_, AppState>, project_id: Option<String>) -> AppResult<Vec<Batch>> {
    batch::list_batches(&state.db.lock().unwrap(), project_id.as_deref())
}

#[tauri::command]
pub fn batch_detail(state: State<'_, AppState>, id: String) -> AppResult<BatchDetail> {
    let conn = state.db.lock().unwrap();
    let b = batch::get_batch(&conn, &id)?.ok_or_else(|| AppError::Invalid("El lote ya no existe".into()))?;
    let workflow = match &b.workflow_id { Some(w) => batch::get_workflow(&conn, w)?, None => None };
    Ok(BatchDetail { items: batch::batch_items(&conn, &id)?, batch: b, workflow })
}

#[tauri::command]
pub fn cancel_batch(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.cancellations.0.lock().unwrap().insert(id);
    Ok(())
}

// ---------- Ajustes ----------

#[tauri::command]
pub fn app_info(state: State<'_, AppState>) -> Value {
    json!({ "data_dir": state.paths.root, "version": env!("CARGO_PKG_VERSION") })
}

#[tauri::command]
pub fn get_setting(state: State<'_, AppState>, key: String) -> AppResult<Option<String>> {
    db::get_setting(&state.db.lock().unwrap(), &key)
}

#[tauri::command]
pub fn set_setting(state: State<'_, AppState>, key: String, value: String) -> AppResult<()> {
    db::set_setting(&state.db.lock().unwrap(), &key, &value)
}
