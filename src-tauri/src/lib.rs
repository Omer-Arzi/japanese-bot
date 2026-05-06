use serde::Serialize;

const PROJECT_DIR: &str = "/Users/omerarzi/projects/japanese-agent";

#[derive(Serialize)]
pub struct FileGenResult {
    pub output: String,
    pub file_path: Option<String>,
}

fn extract_answer(stdout: &str) -> String {
    if let Some(pos) = stdout.rfind("Answer:\n") {
        stdout[pos + "Answer:\n".len()..].trim().to_string()
    } else {
        stdout.trim().to_string()
    }
}

fn extract_file_path(stderr: &str) -> Option<String> {
    stderr
        .lines()
        .find(|line| line.contains("output/") && line.contains(".md"))
        .and_then(|line| {
            line.split_whitespace()
                .find(|tok| tok.contains("output/") && tok.ends_with(".md"))
                .map(String::from)
        })
}

// Commands live in their own module to avoid Tauri v2 macro-namespace conflicts
// when generate_handler! is called in the same scope as #[tauri::command].
mod commands {
    use super::{extract_answer, extract_file_path, FileGenResult, PROJECT_DIR};

    #[tauri::command]
    pub async fn run_ask_sensei(prompt: String) -> Result<String, String> {
        let output = tokio::process::Command::new("bash")
            .arg("bin/ask-sensei")
            .arg(&prompt)
            .current_dir(PROJECT_DIR)
            .output()
            .await
            .map_err(|e| format!("Failed to start ask-sensei: {e}"))?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();

        if !output.status.success() {
            let msg = if stderr.is_empty() { &stdout } else { &stderr };
            return Err(format!("ask-sensei failed: {msg}"));
        }

        Ok(extract_answer(&stdout))
    }

    #[tauri::command]
    pub async fn run_sensei_file(prompt: String) -> Result<FileGenResult, String> {
        let output = tokio::process::Command::new("bash")
            .arg("bin/sensei-file")
            .arg(&prompt)
            .current_dir(PROJECT_DIR)
            .output()
            .await
            .map_err(|e| format!("Failed to start sensei-file: {e}"))?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();

        if !output.status.success() {
            let msg = if stderr.is_empty() { &stdout } else { &stderr };
            return Err(format!("sensei-file failed: {msg}"));
        }

        Ok(FileGenResult {
            output: stdout,
            file_path: extract_file_path(&stderr),
        })
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::run_ask_sensei,
            commands::run_sensei_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
