mod batch;
mod brand;
mod commands;
mod db;
mod engine;
mod error;
mod imaging;
mod jobs;
mod paths;
mod persons;
mod setup;

use std::sync::Mutex;

use tauri::{Manager, RunEvent};

pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    pub engine: engine::Engine,
    pub paths: paths::Paths,
    pub cancellations: batch::Cancellations,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // AICS_DATA_DIR permite probar una instalación limpia sin tocar los datos reales.
            let root = std::env::var_os("AICS_DATA_DIR").map(std::path::PathBuf::from).map(Ok).unwrap_or_else(|| app.path().app_data_dir())?;
            let paths = paths::Paths::new(root)?;
            paths.clean_tmp();
            let conn = db::open(&paths.db())?;
            app.manage(AppState { db: Mutex::new(conn), engine: engine::Engine::new(), paths, cancellations: Default::default() });

            // El motor arranca en segundo plano para que la ventana abra al instante.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<AppState>();
                state.engine.start(&handle, &state.paths).await;
            });

            // Apaga el motor cuando lleva un rato sin usarse (se despierta solo con la siguiente petición).
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let every = (engine::idle_after() / 4).clamp(std::time::Duration::from_secs(2), std::time::Duration::from_secs(30));
                loop {
                    tokio::time::sleep(every).await;
                    let state = handle.state::<AppState>();
                    let jobs_active = || db::active_jobs(&state.db.lock().unwrap()).unwrap_or(true);
                    state.engine.sleep_if_idle(&handle, jobs_active).await;
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::engine_status,
            commands::restart_engine,
            commands::hardware_info,
            commands::providers_status,
            commands::stop_engine,
            commands::jobs_running,
            commands::list_models,
            commands::download_model,
            commands::model_packs,
            commands::queue_models,
            commands::delete_model,
            commands::analyze_prompt,
            commands::list_projects,
            commands::create_project,
            commands::rename_project,
            commands::set_project_cover,
            commands::list_presets,
            commands::create_job,
            commands::cancel_job,
            commands::get_job,
            commands::list_jobs,
            commands::list_assets,
            commands::get_asset,
            commands::asset_children,
            commands::deletion_preview,
            commands::delete_assets,
            commands::delete_history,
            commands::list_sessions,
            commands::rename_session,
            commands::delete_session,
            commands::set_assets_saved,
            commands::import_image,
            commands::save_mask,
            commands::relight_prepare,
            commands::export_asset,
            commands::vectorize_asset,
            commands::create_brand_kit,
            commands::list_brand_kits,
            commands::export_brand_kit,
            commands::list_persons,
            commands::person_detail,
            commands::create_person,
            commands::update_person,
            commands::delete_person,
            commands::add_person_reference,
            commands::remove_person_reference,
            commands::pose_estimate,
            commands::restore_detect,
            commands::list_workflows,
            commands::save_workflow,
            commands::delete_workflow,
            commands::start_batch,
            commands::list_batches,
            commands::batch_detail,
            commands::cancel_batch,
            commands::app_info,
            commands::get_setting,
            commands::set_setting,
        ])
        .build(tauri::generate_context!())
        .expect("error al construir AICreativeStudio");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            handle.state::<AppState>().engine.stop();
        }
    });
}
