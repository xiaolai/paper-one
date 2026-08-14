fn main() {
    // tauri-build does not add icons/** to Cargo's input set, so without these
    // the binary keeps embedding the previous .icns after the icon is
    // regenerated: the new file is on disk, the old one is still in the Dock.
    println!("cargo:rerun-if-changed=icons");
    println!("cargo:rerun-if-changed=icons/icon.icns");
    println!("cargo:rerun-if-changed=icons/icon.png");
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.svg");
    println!("cargo:rerun-if-changed=tauri.conf.json");

    tauri_build::build()
}
