fn main() {
    let attributes = tauri_build::Attributes::new().plugin(
        "serial",
        tauri_build::InlinedPlugin::new().commands(&["list", "open", "read", "write", "close"]),
    );
    tauri_build::try_build(attributes).expect("failed to build Tauri plugins");
}
