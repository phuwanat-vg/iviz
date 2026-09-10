#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // In-app updates: checks the endpoints in tauri.conf.json, verifies the
        // signature with the embedded public key, installs, then the frontend
        // calls `relaunch()` from the process plugin.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .run(tauri::generate_context!())
        .expect("error while running iViz");
}
