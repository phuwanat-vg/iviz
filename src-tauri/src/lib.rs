use base64::Engine;
use std::path::Path;

/// Write a Nav2 map (YAML + PGM) to the paths the user picked in the save
/// dialog. Only `.yaml`/`.yml` and `.pgm` files can be written.
#[tauri::command]
fn write_map_files(yaml_path: String, yaml: String, pgm_path: String, pgm_base64: String) -> Result<(), String> {
    fn has_ext(path: &str, exts: &[&str]) -> bool {
        Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| exts.iter().any(|x| x.eq_ignore_ascii_case(e)))
            .unwrap_or(false)
    }
    if !has_ext(&yaml_path, &["yaml", "yml"]) || !has_ext(&pgm_path, &["pgm"]) {
        return Err("map files must end in .yaml and .pgm".into());
    }
    let pgm = base64::engine::general_purpose::STANDARD
        .decode(pgm_base64)
        .map_err(|e| format!("image data is not valid base64: {e}"))?;
    std::fs::write(&pgm_path, pgm).map_err(|e| format!("{pgm_path}: {e}"))?;
    std::fs::write(&yaml_path, yaml).map_err(|e| format!("{yaml_path}: {e}"))?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // In-app updates: checks the endpoints in tauri.conf.json, verifies the
        // signature with the embedded public key, installs, then the frontend
        // calls `relaunch()` from the process plugin.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Save dialog for exporting maps.
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![write_map_files])
        .run(tauri::generate_context!())
        .expect("error while running iViz");
}
