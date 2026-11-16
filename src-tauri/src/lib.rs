mod plugins {
    pub mod serial;
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(plugins::serial::init())
        .run(tauri::generate_context!())
        .expect("error while running Aether Studio");
}
